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

let rulesDirty = false;

function renderBudget(budget) {
  const pct = budget.weeklyBudgetCents ? Math.min((budget.spentCents / budget.weeklyBudgetCents) * 100, 100) : 0;
  $('spent').textContent = usd(budget.spentCents);
  $('budget-of').textContent = `of ${usd(budget.weeklyBudgetCents)}`;
  $('meter-fill').style.width = `${pct}%`;
  $('meter-fill').className = `meter-fill${pct >= 100 ? ' full' : pct >= 75 ? ' high' : ''}`;
  $('meter').setAttribute('aria-valuenow', String(Math.round(pct)));
  $('stat-left').textContent = usd(budget.remainingCents);
  $('stat-limit').textContent = usd(budget.autoApproveLimitCents);
  $('stat-pending').textContent = String(budget.pendingCount);
  const weekStart = new Date(budget.weekStart);
  $('week-label').textContent = `Since Monday ${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · resets weekly`;
}

function renderWallet(wallet) {
  $('wallet-pill').classList.toggle('connected', Boolean(wallet));
  $('wallet-label').textContent = wallet
    ? `PayPal connected${wallet.payerEmail ? ` · ${wallet.payerEmail}` : ''}`
    : 'PayPal not connected';
  $('connect-banner').hidden = Boolean(wallet);
}

function renderRules(rules) {
  if (!rules) {
    $('rules-compiled').innerHTML = '<li>No rules yet. Write some and press Update rules.</li>';
    return;
  }
  if (!rulesDirty) $('rules-text').value = rules.text;
  $('rules-compiled').innerHTML = rules.summary.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
}

async function refreshState() {
  const state = await api('/api/state');
  renderBudget(state.budget);
  renderWallet(state.wallet);
  renderRules(state.rules);
}

function renderApprovals(purchases) {
  const pending = purchases.filter((p) => p.status === 'pending_owner');
  $('approvals').innerHTML = pending
    .map(
      (p) => `
      <article class="approval" data-id="${escapeHtml(p.id)}">
        <div class="approval-head">
          <span>${escapeHtml(p.vendors)}</span>
          <span class="amount">${usd(p.total_cents)}</span>
        </div>
        <div class="meta">${escapeHtml(itemsSummary(p.items))} · ${escapeHtml(p.agent)} · ${timeAgo(p.created_at)}</div>
        <p class="why">${escapeHtml(p.ai_summary)}</p>
        <div class="approval-actions">
          <button class="btn btn-primary" data-action="approve" type="button">Approve &amp; pay ${usd(p.total_cents)}</button>
          <button class="btn btn-danger" data-action="decline" type="button">Decline</button>
          <button class="btn btn-ghost" data-action="details" type="button">Details</button>
        </div>
      </article>`,
    )
    .join('');
}

$('approvals').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.closest('.approval').dataset.id;
  const action = button.dataset.action;
  if (action === 'details') return openDrawer(id);

  button.disabled = true;
  try {
    const purchase = await api(`/api/purchases/${id}/${action}`, { method: 'POST' });
    toast(
      action === 'approve'
        ? purchase.status === 'paid'
          ? `Paid ${usd(purchase.total_cents)} to ${purchase.vendors} with PayPal`
          : `Payment ${purchase.status}: ${purchase.error ?? ''}`
        : 'Purchase declined. The agent will not be charged.',
      { error: action === 'approve' && purchase.status !== 'paid' },
    );
  } catch (err) {
    toast(err.message, { error: true });
    button.disabled = false;
  }
  refresh();
});
