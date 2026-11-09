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
