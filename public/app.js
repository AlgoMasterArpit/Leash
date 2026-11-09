const $ = (id) => document.getElementById(id);

const usd = (cents) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function timeAgo(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body && JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, { error = false } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

const STATUS = {
  paid: (p) => (p.decided_by === 'owner' ? ['Owner approved', 'ok'] : ['Auto-paid', 'ok']),
  pending_owner: () => ['Needs approval', 'warn'],
  blocked: () => ['Blocked', 'bad'],
  declined: () => ['Declined', 'muted'],
  refunded: () => ['Refunded', 'info'],
  failed: () => ['Payment failed', 'bad'],
  processing: () => ['Processing', 'muted'],
  payment_pending: () => ['Payment pending', 'muted'],
};

function statusOf(purchase) {
  return (STATUS[purchase.status] ?? (() => [purchase.status, 'muted']))(purchase);
}

function statusPill(purchase) {
  const [label, tone] = statusOf(purchase);
  return `<span class="pill pill-${tone}">${escapeHtml(label)}</span>`;
}

const itemsSummary = (items) => items.map((i) => `${i.qty}× ${i.name}`).join(', ');
