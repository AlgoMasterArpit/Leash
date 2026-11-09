import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, startOfWeek } from '../src/db.js';

const base = {
  agent: 'restock-agent',
  reason: 'weekly restock',
  items: [{ sku: 'CUP-12', qty: 2 }],
  vendors: 'CupCo Packaging',
  decision: 'approve',
};

test('round-trips purchases with JSON columns', () => {
  const store = createStore(':memory:');
  store.insertPurchase({ ...base, id: 'p1', total_cents: 1800, status: 'paid', reasons: ['ok'] });
  const p = store.getPurchase('p1');
  assert.deepEqual(p.items, base.items);
  assert.deepEqual(p.reasons, ['ok']);
  const updated = store.updatePurchase('p1', { status: 'refunded', checks: [{ id: 'budget' }] });
  assert.equal(updated.status, 'refunded');
  assert.deepEqual(updated.checks, [{ id: 'budget' }]);
});

test('counts only paid purchases toward spend', () => {
  const store = createStore(':memory:');
  store.insertPurchase({ ...base, id: 'a', total_cents: 1000, status: 'paid' });
  store.insertPurchase({ ...base, id: 'b', total_cents: 5000, status: 'pending_owner' });
  store.insertPurchase({ ...base, id: 'c', total_cents: 700, status: 'refunded' });
  assert.equal(store.spentSinceCents(startOfWeek()), 1000);
});

test('week starts on Monday 00:00 UTC', () => {
  assert.equal(startOfWeek(new Date('2026-11-12T15:00:00Z')).toISOString(), '2026-11-09T00:00:00.000Z');
  assert.equal(startOfWeek(new Date('2026-11-15T23:59:00Z')).toISOString(), '2026-11-09T00:00:00.000Z');
  assert.equal(startOfWeek(new Date('2026-11-09T00:00:00Z')).toISOString(), '2026-11-09T00:00:00.000Z');
});

test('settings are stored as JSON', () => {
  const store = createStore(':memory:');
  store.setSetting('rules', { weeklyBudgetCents: 20000 });
  store.setSetting('rules', { weeklyBudgetCents: 30000 });
  assert.deepEqual(store.getSetting('rules'), { weeklyBudgetCents: 30000 });
  store.deleteSetting('rules');
  assert.equal(store.getSetting('rules'), null);
});
