import express from 'express';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createStore } from './db.js';
import { createLeash } from './leash.js';
import { createAgent } from './agent.js';
import { AppError } from './errors.js';
import { DEFAULT_RULES_TEXT } from './rules.js';
import * as paypal from './paypal.js';
import * as ai from './ai.js';
import * as catalog from './catalog.js';
import { chat } from './groq.js';

const store = createStore(config.DATABASE_PATH);
const leash = createLeash({
  store,
  paypal,
  ai,
  catalog,
  publicUrl: config.PUBLIC_URL,
  seedVaultId: config.PAYPAL_VAULT_ID,
});
const runAgent = createAgent({ chat, leash, catalog });

const RulesBody = z.object({ text: z.string().trim().min(10).max(1000) });
const PurchaseBody = z.object({
  agent: z.string().trim().min(1).max(80),
  reason: z.string().trim().min(1).max(500),
  items: z
    .array(z.object({ sku: z.string().min(1).max(40), qty: z.number().int().min(1).max(100) }))
    .min(1)
    .max(20),
});
const RefundBody = z.object({ note: z.string().max(255).optional() });
const AgentBody = z.object({ task: z.string().trim().min(3).max(500) });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});

app.post('/webhooks/paypal', express.json({ limit: '1mb' }), async (req, res) => {
  const verified = await paypal.verifyWebhook(req.headers, req.body).catch(() => false);
  if (!verified) return res.status(400).json({ error: 'Webhook signature could not be verified' });
  leash.handleWebhook(req.body);
  res.sendStatus(200);
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { extensions: ['html'] }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

function maskEmail(email) {
  if (!email) return null;
  const [user, domain] = email.split('@');
  return `${user.slice(0, 3)}…@${domain}`;
}

app.get('/api/state', (req, res) => {
  const wallet = leash.wallet();
  res.json({
    rules: store.getSetting('rules'),
    wallet: wallet && { connected: true, payerEmail: maskEmail(wallet.payerEmail), connectedAt: wallet.connectedAt ?? null },
    budget: leash.budget(),
  });
});

app.put('/api/rules', async (req, res) => {
  const { text } = RulesBody.parse(req.body);
  res.json(await leash.setRules(text));
});

app.get('/api/catalog', (req, res) => res.json(catalog.listProducts()));

app.post('/api/connect', async (req, res) => {
  const { approveUrl } = await leash.startConnect();
  res.json({ approveUrl });
});

app.get('/connect/return', async (req, res) => {
  const setupTokenId = req.query.approval_token_id;
  if (typeof setupTokenId !== 'string' || !setupTokenId) return res.redirect('/?connect=failed');
  try {
    await leash.finishConnect(setupTokenId);
    res.redirect('/?connect=success');
  } catch (err) {
    console.error('Vault connection failed', err);
    res.redirect('/?connect=failed');
  }
});

app.delete('/api/wallet', async (req, res) => {
  await leash.disconnect();
  res.sendStatus(204);
});

function requireAgentKey(req, res, next) {
  if (config.LEASH_AGENT_KEY && req.get('x-leash-agent-key') !== config.LEASH_AGENT_KEY) {
    throw new AppError(401, 'Missing or invalid x-leash-agent-key header');
  }
  next();
}

app.get('/api/purchases', (req, res) => res.json(leash.listPurchases()));
app.get('/api/purchases/:id', (req, res) => res.json(leash.getPurchase(req.params.id)));

app.post('/api/purchases', requireAgentKey, async (req, res) => {
  const purchase = await leash.requestPurchase(PurchaseBody.parse(req.body));
  res.status(201).json(purchase);
});

app.post('/api/purchases/:id/approve', async (req, res) => res.json(await leash.approve(req.params.id)));
app.post('/api/purchases/:id/decline', (req, res) => res.json(leash.decline(req.params.id)));
app.post('/api/purchases/:id/refund', async (req, res) => {
  const { note } = RefundBody.parse(req.body ?? {});
  res.json(await leash.refund(req.params.id, note));
});

// ponytail: one agent run at a time keeps Groq usage bounded on the shared demo; use per-user quotas with auth
let agentBusy = false;

app.post('/api/agent/run', async (req, res) => {
  const { task } = AgentBody.parse(req.body);
  if (agentBusy) throw new AppError(429, 'The agent is already running a task. Try again in a moment.');
  agentBusy = true;

  res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const emit = (event) => res.write(`${JSON.stringify(event)}\n`);

  try {
    await runAgent(task, emit);
  } catch (err) {
    console.error('Agent run failed', err);
    emit({ type: 'error', message: err.message });
  } finally {
    agentBusy = false;
    emit({ type: 'done' });
    res.end();
  }
});

app.post('/api/demo/reset', (req, res) => {
  leash.resetDemo();
  res.sendStatus(204);
});
