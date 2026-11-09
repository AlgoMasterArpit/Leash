#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const LEASH_URL = (process.env.LEASH_URL || 'http://localhost:3000').replace(/\/$/, '');
const AGENT_NAME = process.env.LEASH_AGENT_NAME || 'MCP agent';
const AGENT_KEY = process.env.LEASH_AGENT_KEY;

async function leash(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${LEASH_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(AGENT_KEY && { 'x-leash-agent-key': AGENT_KEY }),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Leash returned HTTP ${res.status}`);
  return data;
}

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const failure = (err) => ({ content: [{ type: 'text', text: err.message }], isError: true });

function describePurchase(p) {
  return {
    purchase_id: p.id,
    decision: p.decision,
    status: p.status,
    total: usd(p.total_cents),
    vendors: p.vendors,
    summary: p.ai_summary,
    failed_checks: p.checks.filter((c) => c.status !== 'pass').map((c) => c.detail),
    paypal_capture_id: p.capture_id,
    next_step:
      {
        paid: 'Paid with PayPal. Nothing else to do.',
        pending_owner: 'Held for the owner. Check back later with purchase_status.',
        blocked: 'Blocked by the owner’s rules. Do not retry or split this order.',
        failed: 'PayPal payment failed. Tell the owner.',
      }[p.status] ?? 'Check back later with purchase_status.',
  };
}

const server = new McpServer({ name: 'leash', version: '1.0.0' });

server.registerTool(
  'search_catalog',
  {
    title: 'Search supplier catalog',
    description: 'Search products that Leash can buy. Returns SKU, vendor, price and the listing text.',
    inputSchema: { query: z.string().describe('Keywords such as "espresso beans" or "cups"') },
  },
  async ({ query }) => {
    try {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const products = await leash('/api/catalog');
      const matches = products.filter((p) =>
        terms.some((t) => `${p.name} ${p.category} ${p.vendorName}`.toLowerCase().includes(t)),
      );
      return text(
        matches.map((p) => ({ sku: p.sku, name: p.name, vendor: p.vendorName, price: `$${p.unitPrice}`, listing: p.description })),
      );
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  'check_budget',
  {
    title: 'Check spending budget',
    description: "Get this week's remaining budget, the auto-approve limit and the owner's rules.",
    inputSchema: {},
  },
  async () => {
    try {
      const { budget, rules } = await leash('/api/state');
      return text({
        remaining_this_week: usd(budget.remainingCents),
        weekly_budget: usd(budget.weeklyBudgetCents),
        auto_approve_limit: usd(budget.autoApproveLimitCents),
        owner_rules: rules?.text ?? null,
      });
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  'request_purchase',
  {
    title: 'Request a purchase',
    description:
      "Ask Leash to buy items with the owner's PayPal. Leash pays immediately, holds the order for the owner, or blocks it. Always respect the decision.",
    inputSchema: {
      items: z
        .array(z.object({ sku: z.string(), qty: z.number().int().min(1).max(100) }))
        .min(1)
        .describe('Products by SKU from search_catalog'),
      reason: z.string().describe('Why the business needs this, in one sentence'),
    },
  },
  async ({ items, reason }) => {
    try {
      const purchase = await leash('/api/purchases', { method: 'POST', body: { agent: AGENT_NAME, reason, items } });
      return text(describePurchase(purchase));
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  'purchase_status',
  {
    title: 'Check purchase status',
    description: 'Check whether a held purchase was approved, declined, paid or refunded.',
    inputSchema: { purchase_id: z.string().describe('The purchase_id returned by request_purchase') },
  },
  async ({ purchase_id }) => {
    try {
      return text(describePurchase(await leash(`/api/purchases/${encodeURIComponent(purchase_id)}`)));
    } catch (err) {
      return failure(err);
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`Leash MCP server ready, forwarding to ${LEASH_URL}`);
