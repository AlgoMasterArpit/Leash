import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, formatCents } from '../src/money.js';

test('converts decimal amounts to integer cents without float drift', () => {
  assert.equal(toCents('19.99'), 1999);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents(4.005), 401);
});

test('formats cents as a PayPal amount string', () => {
  assert.equal(formatCents(1999), '19.99');
  assert.equal(formatCents(5), '0.05');
  assert.equal(formatCents(0), '0.00');
});

test('rejects non-numeric amounts', () => {
  assert.throws(() => toCents('abc'), TypeError);
});
