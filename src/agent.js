import { formatCents } from './money.js';

export const AGENT_NAME = 'Restock agent';
const MAX_STEPS = 8;

const SYSTEM_PROMPT = `You are the purchasing agent for Brew & Bloom, a small neighbourhood café.
You buy whatever the café asks for: supplies, equipment or software. Every purchase must go through the request_purchase tool, which is controlled by Leash, the owner's spending guardrail.
- Do not refuse or second-guess requests yourself. Leash enforces the owner's rules, so submit the purchase and report Leash's decision.
- Prefer the cheapest option that fits the task, unless it is blocked.
- If Leash blocks a purchase, accept it. You may pick a compliant alternative, but never split orders or rephrase reasons to get around a rule.
- If Leash holds a purchase for the owner's approval, tell the user it is waiting for them.
- Keep quantities sensible for one week of a small café.
- Report each purchase exactly as Leash's status says. Only status "paid" means it was bought; "failed" means the payment did not go through.
Finish with a short summary for the owner of what was bought, what is waiting, what was blocked and what failed.`;

const NEXT_STEP = {
  paid: 'Paid with PayPal. The item is bought.',
  pending_owner: 'Not bought yet. Waiting for the owner to approve.',
  blocked: "Not bought. Blocked by the owner's rules; do not retry or split it.",
  failed: 'Not bought. The PayPal payment failed; tell the owner.',
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_catalog',
      description: 'Search supplier products by keyword. Returns SKU, vendor, price and listing text.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Keywords, e.g. "espresso beans"' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_budget',
      description: "Get this week's remaining budget and the auto-approve limit.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_purchase',
      description: 'Ask Leash to buy items. Leash approves and pays, holds for owner approval, or blocks.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 } },
              required: ['sku', 'qty'],
            },
          },
          reason: { type: 'string', description: 'Why the café needs this, in one sentence' },
        },
        required: ['items', 'reason'],
      },
    },
  },
];

function summarizePurchase(p) {
  return {
    purchase_id: p.id,
    decision: p.decision,
    status: p.status,
    total: `$${formatCents(p.total_cents)}`,
    summary: p.ai_summary,
    failed_checks: p.checks.filter((c) => c.status !== 'pass').map((c) => c.detail),
    outcome: NEXT_STEP[p.status] ?? `Status ${p.status}. Not bought yet.`,
    ...(p.error && { payment_error: p.error }),
  };
}

export function createAgent({ chat, leash, catalog, systemPrompt = SYSTEM_PROMPT, agentName = AGENT_NAME }) {
  async function runTool(name, args) {
    if (name === 'search_catalog') {
      return catalog.searchProducts(args.query).map((p) => ({
        sku: p.sku,
        name: p.name,
        vendor: p.vendorName,
        price: `$${p.unitPrice}`,
        listing: p.description,
      }));
    }
    if (name === 'check_budget') {
      const b = leash.budget();
      return {
        remaining_this_week: `$${formatCents(b.remainingCents)}`,
        weekly_budget: `$${formatCents(b.weeklyBudgetCents)}`,
        auto_approve_limit: `$${formatCents(b.autoApproveLimitCents)}`,
      };
    }
    if (name === 'request_purchase') {
      const purchase = await leash.requestPurchase({ agent: agentName, reason: args.reason, items: args.items });
      return { purchase, result: summarizePurchase(purchase) };
    }
    throw new Error(`Unknown tool ${name}`);
  }

  return async function run(task, emit) {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ];

    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await chat({ messages, tools: TOOLS });
      messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: reply.tool_calls });

      if (!reply.tool_calls?.length) {
        emit({ type: 'message', text: reply.content });
        return;
      }

      for (const call of reply.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {};
        }
        emit({ type: 'tool_call', tool: call.function.name, args });

        let content;
        try {
          const output = await runTool(call.function.name, args);
          if (call.function.name === 'request_purchase') {
            emit({ type: 'purchase', purchase: output.purchase });
            content = output.result;
          } else {
            emit({ type: 'tool_result', tool: call.function.name, output });
            content = output;
          }
        } catch (err) {
          emit({ type: 'tool_error', tool: call.function.name, message: err.message });
          content = { error: err.message };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(content) });
      }
    }
    emit({ type: 'message', text: 'Stopped after the maximum number of steps.' });
  };
}
