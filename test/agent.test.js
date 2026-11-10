import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../src/agent.js';
import * as catalog from '../src/catalog.js';

function scriptedChat(items) {
  let turn = 0;
  return async () => {
    turn += 1;
    if (turn === 1) {
      return {
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'request_purchase', arguments: JSON.stringify({ items, reason: 'restock' }) },
          },
        ],
      };
    }
    return { content: 'Done.' };
  };
}

test('the agent rejects malformed purchase arguments before they reach Leash', async () => {
  const requests = [];
  const leash = { requestPurchase: async (r) => requests.push(r), budget: () => ({}) };
  const agent = createAgent({
    chat: scriptedChat([
      { sku: 'KP-GRIND-01', qty: 3 },
      { sku: 'CC-NAP-200', qty: -64 },
    ]),
    leash,
    catalog,
  });
  const events = [];
  await agent('buy things', (e) => events.push(e));
  assert.equal(requests.length, 0);
  assert.ok(events.some((e) => e.type === 'tool_error'));
});

test('the agent forwards valid purchases with its own name', async () => {
  const requests = [];
  const leash = {
    requestPurchase: async (r) => {
      requests.push(r);
      return { id: 'p1', decision: 'approve', status: 'paid', total_cents: 400, checks: [], ai_summary: 'ok' };
    },
    budget: () => ({}),
  };
  const agent = createAgent({ chat: scriptedChat([{ sku: 'CC-NAP-200', qty: 1 }]), leash, catalog, agentName: 'tester' });
  await agent('napkins', () => {});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].agent, 'tester');
});
