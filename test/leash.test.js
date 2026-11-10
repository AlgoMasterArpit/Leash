import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/db.js';
import { createLeash } from '../src/leash.js';
import * as catalog from '../src/catalog.js';

const RULES = {
  text: 'test rules',
  summary: [],
  rules: {
    weeklyBudgetCents: 20000,
    autoApproveLimitCents: 5000,
    allowedVendors: ['BeanBros Coffee Supply', 'CupCo Packaging', 'KitchenPro Equipment'],
    blockedCategories: [],
    blockRecurring: true,
    requireVerifiedVendors: true,
    notes: '',
  },
};

function setup({ verdict = 'approve', injection = 0.01, judgeFails = false, captureStatus = 'COMPLETED' } = {}) {
  const store = createStore(':memory:');
  const charges = [];
  const paypal = {
    async chargeVault(args) {
      charges.push(args);
      return { orderId: `O-${charges.length}`, orderStatus: 'COMPLETED', captureId: `C-${charges.length}`, captureStatus };
    },
    async refundCapture(captureId) {
      return { refundId: `R-${captureId}`, status: 'COMPLETED' };
    },
  };
  const ai = {
    async judgePurchase() {
      if (judgeFails) throw new Error('rate limited');
      return { verdict, risk: 10, reasons: ['looks fine'], summary: 'ok' };
    },
    async scanForInjection() {
      return injection;
    },
    async compileRules() {
      return RULES;
    },
  };
  const leash = createLeash({ store, paypal, ai, catalog, publicUrl: 'http://test', seedVaultId: 'vault-1' });
  store.setSetting('rules', RULES);
  return { leash, store, charges };
}

const buy = (leash, items, reason = 'restock') => leash.requestPurchase({ agent: 'test-agent', reason, items });

test('auto-approves and charges in-policy purchases', async () => {
  const { leash, charges } = setup();
  const p = await buy(leash, [{ sku: 'CC-CUP12-50', qty: 2 }]);
  assert.equal(p.decision, 'approve');
  assert.equal(p.status, 'paid');
  assert.equal(p.capture_id, 'C-1');
  assert.equal(charges[0].total, '18.00');
  assert.equal(charges[0].vaultId, 'vault-1');
  assert.equal(leash.budget().spentCents, 1800);
});

test('holds purchases over the limit for the owner, then charges on approval', async () => {
  const { leash, charges } = setup();
  const p = await buy(leash, [{ sku: 'KP-GRIND-01', qty: 1 }]);
  assert.equal(p.status, 'pending_owner');
  assert.equal(charges.length, 0);
  const approved = await leash.approve(p.id);
  assert.equal(approved.status, 'paid');
  assert.equal(approved.decided_by, 'owner');
  await assert.rejects(leash.approve(p.id), /not awaiting approval/);
});

test('blocks subscriptions without charging', async () => {
  const { leash, charges } = setup();
  const p = await buy(leash, [{ sku: 'KOS-TRIAL', qty: 1 }]);
  assert.equal(p.status, 'blocked');
  assert.equal(charges.length, 0);
});

test('reports blocked spend and pending approvals in the budget', async () => {
  const { leash } = setup();
  await buy(leash, [{ sku: 'DZ-ESP-1KG', qty: 3 }]);
  await buy(leash, [{ sku: 'KP-GRIND-01', qty: 1 }]);
  const budget = leash.budget();
  assert.equal(budget.blockedCount, 1);
  assert.equal(budget.blockedCents, 3597);
  assert.equal(budget.pendingCount, 1);
});

test('AI can tighten a decision but never loosen it', async () => {
  const strict = setup({ verdict: 'block' });
  assert.equal((await buy(strict.leash, [{ sku: 'CC-NAP-200', qty: 1 }])).status, 'blocked');

  const lenient = setup({ verdict: 'approve' });
  assert.equal((await buy(lenient.leash, [{ sku: 'KOS-TRIAL', qty: 1 }])).status, 'blocked');
});

test('falls back to owner review when the AI judge is unavailable', async () => {
  const { leash, charges } = setup({ judgeFails: true });
  const p = await buy(leash, [{ sku: 'CC-NAP-200', qty: 1 }]);
  assert.equal(p.status, 'pending_owner');
  assert.equal(charges.length, 0);
});

test('blocks purchases when prompt injection is detected', async () => {
  const { leash } = setup({ injection: 0.82 });
  const p = await buy(leash, [{ sku: 'CC-NAP-200', qty: 1 }]);
  assert.equal(p.status, 'blocked');
  assert.equal(p.checks.find((c) => c.id === 'injection').status, 'block');
});

test('holds the second half of a split order for the owner', async () => {
  const { leash, charges } = setup();
  const first = await buy(leash, [{ sku: 'BB-ESP-1KG', qty: 1 }]);
  const second = await buy(leash, [{ sku: 'BB-ESP-1KG', qty: 1 }]);
  const third = await buy(leash, [{ sku: 'BB-ESP-1KG', qty: 1 }]);
  assert.equal(first.status, 'paid');
  assert.equal(second.status, 'paid');
  assert.equal(third.status, 'pending_owner');
  assert.equal(third.checks.find((c) => c.id === 'splitting').status, 'review');
  assert.equal(charges.length, 2);
});

test('previews a decision without charging or recording anything', async () => {
  const { leash, charges, store } = setup();
  const preview = leash.previewPurchase({ agent: 'test-agent', items: [{ sku: 'KP-GRIND-01', qty: 1 }] });
  assert.equal(preview.decision, 'review');
  assert.equal(preview.totalCents, 8900);
  assert.equal(charges.length, 0);
  assert.equal(store.listPurchases().length, 0);
  assert.equal(leash.previewPurchase({ agent: 'test-agent', items: [{ sku: 'KOS-TRIAL', qty: 1 }] }).decision, 'block');
});

test('rejects unknown SKUs', async () => {
  const { leash } = setup();
  await assert.rejects(buy(leash, [{ sku: 'NOPE', qty: 1 }]), /Unknown product SKU/);
});

test('owner approval re-checks the weekly budget', async () => {
  const { leash } = setup();
  const pending = await buy(leash, [{ sku: 'KP-GRIND-01', qty: 2 }]);
  assert.equal(pending.status, 'pending_owner');
  await buy(leash, [{ sku: 'BB-ESP-1KG', qty: 2 }]);
  await buy(leash, [{ sku: 'CC-CUP12-50', qty: 5 }]);
  await assert.rejects(leash.approve(pending.id), /exceed the weekly budget/);
});

test('concurrent purchases cannot overspend the budget', async () => {
  const { leash } = setup();
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, n) =>
      leash.requestPurchase({ agent: `agent-${n}`, reason: 'restock', items: [{ sku: 'BB-ESP-1KG', qty: 2 }] }),
    ),
  );
  assert.equal(results.filter((p) => p.status === 'paid').length, 4);
  assert.ok(leash.budget().spentCents <= 20000);
});

test('refunds paid purchases and frees the budget', async () => {
  const { leash } = setup();
  const p = await buy(leash, [{ sku: 'CC-CUP12-50', qty: 1 }]);
  const refunded = await leash.refund(p.id);
  assert.equal(refunded.status, 'refunded');
  assert.equal(refunded.refund_id, 'R-C-1');
  assert.equal(leash.budget().spentCents, 0);
  await assert.rejects(leash.refund(p.id), /Only paid purchases/);
});

test('marks purchases failed when PayPal rejects the charge', async () => {
  const { leash, store } = setup();
  const failing = createLeash({
    store,
    catalog,
    publicUrl: 'http://test',
    seedVaultId: 'vault-1',
    ai: { judgePurchase: async () => ({ verdict: 'approve', risk: 0, reasons: [], summary: '' }), scanForInjection: async () => 0 },
    paypal: {
      chargeVault: async () => {
        throw new Error('INSTRUMENT_DECLINED');
      },
    },
  });
  const p = await buy(failing, [{ sku: 'CC-NAP-200', qty: 1 }]);
  assert.equal(p.status, 'failed');
  assert.match(p.error, /INSTRUMENT_DECLINED/);
  assert.equal(leash.budget().spentCents, 0);
});

test('webhooks update purchase status by capture id', async () => {
  const { leash } = setup({ captureStatus: 'PENDING' });
  const p = await buy(leash, [{ sku: 'CC-NAP-200', qty: 1 }]);
  assert.equal(p.status, 'payment_pending');
  const updated = leash.handleWebhook({
    id: 'WH-1',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: p.capture_id, status: 'COMPLETED' },
  });
  assert.equal(updated.status, 'paid');
  assert.equal(leash.handleWebhook({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'other' } }), null);
});
