import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHardRules, strictest } from '../src/rules.js';
import { findProduct } from '../src/catalog.js';

const rules = {
  weeklyBudgetCents: 20000,
  autoApproveLimitCents: 5000,
  allowedVendors: ['BeanBros Coffee Supply', 'CupCo Packaging', 'KitchenPro Equipment'],
  blockedCategories: ['alcohol'],
  blockRecurring: true,
  requireVerifiedVendors: true,
  notes: '',
};

function evaluate(skus, spentCents = 0) {
  const items = skus.map((sku) => ({ ...findProduct(sku), qty: 1 }));
  const totalCents = items.reduce((sum, i) => sum + Math.round(Number(i.unitPrice) * 100), 0);
  return evaluateHardRules({ rules, items, totalCents, spentCents });
}

const statusOf = (result, id) => result.checks.find((c) => c.id === id)?.status;

test('approves small purchases from approved vendors', () => {
  assert.equal(evaluate(['CC-CUP12-50', 'CC-LID-50']).decision, 'approve');
});

test('asks the owner when over the auto-approve limit', () => {
  const result = evaluate(['KP-GRIND-01']);
  assert.equal(result.decision, 'review');
  assert.equal(statusOf(result, 'limit'), 'review');
});

test('blocks purchases that would exceed the weekly budget', () => {
  const result = evaluate(['CC-CUP12-50'], 19500);
  assert.equal(result.decision, 'block');
  assert.equal(statusOf(result, 'budget'), 'block');
});

test('allows spending exactly up to the budget', () => {
  assert.equal(evaluate(['CC-CUP12-50'], 19100).decision, 'approve');
});

test('blocks recurring subscriptions', () => {
  const result = evaluate(['KOS-TRIAL']);
  assert.equal(result.decision, 'block');
  assert.equal(statusOf(result, 'recurring'), 'block');
});

test('blocks unapproved and unverified vendors', () => {
  const result = evaluate(['DZ-ESP-1KG']);
  assert.equal(result.decision, 'block');
  assert.equal(statusOf(result, 'vendors'), 'block');
  assert.equal(statusOf(result, 'verified'), 'block');
});

test('vendor matching ignores case', () => {
  const result = evaluateHardRules({
    rules: { ...rules, allowedVendors: ['cupco packaging'] },
    items: [{ ...findProduct('CC-NAP-200'), qty: 1 }],
    totalCents: 400,
    spentCents: 0,
  });
  assert.equal(result.decision, 'approve');
});

test('strictest picks the most restrictive decision', () => {
  assert.equal(strictest('approve', 'review'), 'review');
  assert.equal(strictest('review', 'block', 'approve'), 'block');
  assert.equal(strictest(), 'approve');
});
