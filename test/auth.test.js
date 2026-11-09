import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessControl, isAgentRoute, safeEqual } from '../src/auth.js';

function run(middleware, { method = 'GET', path = '/', headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { method, path, get: (name) => lower[name.toLowerCase()] };
  const res = {
    statusCode: 200,
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  };
  let passed = false;
  middleware(req, res, () => {
    passed = true;
  });
  return { passed, status: res.statusCode, headers: res.headers };
}

const basic = (password) => `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`;

test('compares secrets without short-circuiting on length', () => {
  assert.ok(safeEqual('secret', 'secret'));
  assert.ok(!safeEqual('secret', 'secret-longer'));
  assert.ok(!safeEqual(undefined, 'secret'));
});

test('recognizes the routes agents are allowed to call', () => {
  assert.ok(isAgentRoute('POST', '/api/purchases'));
  assert.ok(isAgentRoute('GET', '/api/purchases/pur_abc123'));
  assert.ok(!isAgentRoute('POST', '/api/purchases/pur_abc123/approve'));
  assert.ok(!isAgentRoute('PUT', '/api/rules'));
});

test('everything is open when no secrets are configured', () => {
  const open = createAccessControl({});
  assert.ok(run(open, { method: 'POST', path: '/api/purchases/x/approve' }).passed);
  assert.ok(run(open, { method: 'POST', path: '/api/purchases' }).passed);
});

test('dashboard password protects owner routes', () => {
  const guard = createAccessControl({ dashboardPassword: 'hunter2' });
  const denied = run(guard, { method: 'POST', path: '/api/purchases/x/approve' });
  assert.equal(denied.status, 401);
  assert.match(denied.headers['WWW-Authenticate'], /Basic/);
  assert.ok(run(guard, { path: '/', headers: { Authorization: basic('hunter2') } }).passed);
  assert.equal(run(guard, { path: '/', headers: { Authorization: basic('wrong') } }).status, 401);
});

test('agent key unlocks only agent routes', () => {
  const guard = createAccessControl({ dashboardPassword: 'hunter2', agentKey: 'agent-key' });
  const headers = { 'x-leash-agent-key': 'agent-key' };
  assert.ok(run(guard, { method: 'POST', path: '/api/purchases', headers }).passed);
  assert.ok(run(guard, { method: 'GET', path: '/api/state', headers }).passed);
  assert.equal(run(guard, { method: 'POST', path: '/api/purchases/x/approve', headers }).status, 401);
  assert.equal(run(guard, { method: 'PUT', path: '/api/rules', headers }).status, 401);
});

test('agent key is required for purchases when set without a dashboard password', () => {
  const guard = createAccessControl({ agentKey: 'agent-key' });
  assert.equal(run(guard, { method: 'POST', path: '/api/purchases' }).status, 401);
  assert.ok(run(guard, { method: 'POST', path: '/api/purchases', headers: { 'x-leash-agent-key': 'agent-key' } }).passed);
  assert.ok(run(guard, { method: 'POST', path: '/api/purchases/x/approve' }).passed);
});
