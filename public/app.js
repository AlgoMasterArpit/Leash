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

function riskRenderer(params) {
  if (params.node.rowPinned || params.value == null) return '';
  const value = params.value;
  const color = value >= 70 ? 'var(--bad)' : value >= 35 ? 'var(--warn)' : 'var(--ok)';
  return `<div class="risk"><div class="risk-bar"><i style="width:${value}%;background:${color}"></i></div><span>${value}</span></div>`;
}

function actionsRenderer(params) {
  if (params.node.rowPinned || params.data.status !== 'paid') return '';
  return '<button class="btn btn-sm" data-refund type="button">Refund</button>';
}

const columnDefs = [
  {
    field: 'created_at',
    headerName: 'When',
    width: 110,
    sort: 'desc',
    valueFormatter: (p) => (p.node.rowPinned ? '' : timeAgo(p.value)),
  },
  { field: 'agent', headerName: 'Agent', width: 190 },
  {
    colId: 'items',
    headerName: 'Items',
    flex: 1.4,
    minWidth: 200,
    valueGetter: (p) => (p.data.items ? itemsSummary(p.data.items) : ''),
    tooltipValueGetter: (p) => p.value,
  },
  { field: 'vendors', headerName: 'Vendor', width: 190 },
  {
    field: 'total_cents',
    headerName: 'Amount',
    width: 115,
    type: 'rightAligned',
    filter: 'agNumberColumnFilter',
    valueFormatter: (p) => usd(p.value ?? 0),
    cellStyle: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
  },
  {
    colId: 'outcome',
    headerName: 'Outcome',
    width: 165,
    valueGetter: (p) => (p.node.rowPinned ? '' : statusOf(p.data)[0]),
    cellRenderer: (p) => (p.node.rowPinned ? '' : statusPill(p.data)),
  },
  { field: 'risk', headerName: 'AI risk', width: 120, cellRenderer: riskRenderer, filter: 'agNumberColumnFilter' },
  {
    field: 'ai_summary',
    headerName: 'Why',
    flex: 2,
    minWidth: 260,
    tooltipField: 'ai_summary',
  },
  {
    field: 'capture_id',
    headerName: 'PayPal capture',
    width: 175,
    cellClass: 'mono',
    valueFormatter: (p) => p.value ?? '',
  },
  {
    colId: 'actions',
    headerName: '',
    width: 100,
    sortable: false,
    filter: false,
    resizable: false,
    cellRenderer: actionsRenderer,
  },
];

function totalsRow(purchases) {
  const paid = purchases.filter((p) => p.status === 'paid');
  return [{ agent: `${paid.length} paid purchases`, total_cents: paid.reduce((s, p) => s + p.total_cents, 0) }];
}

const ledger = agGrid.createGrid($('ledger'), {
  columnDefs,
  rowData: [],
  getRowId: (p) => p.data.id ?? 'total',
  defaultColDef: { sortable: true, filter: true, resizable: true },
  rowHeight: 46,
  headerHeight: 40,
  animateRows: true,
  tooltipShowDelay: 400,
  overlayNoRowsTemplate: '<span>No agent purchases yet. Run the restock agent to see Leash in action.</span>',
  onCellClicked: (event) => {
    if (event.node.rowPinned) return;
    if (event.event.target.closest('[data-refund]')) return refundPurchase(event.data);
    openDrawer(event.data.id);
  },
});

function renderLedger(purchases) {
  ledger.setGridOption('rowData', purchases);
  ledger.setGridOption('pinnedBottomRowData', totalsRow(purchases));
}

$('ledger-search').addEventListener('input', (event) => {
  ledger.setGridOption('quickFilterText', event.target.value);
});

$('ledger-export').addEventListener('click', () => {
  ledger.exportDataAsCsv({
    fileName: `leash-ledger-${new Date().toISOString().slice(0, 10)}.csv`,
    columnKeys: ['created_at', 'agent', 'items', 'vendors', 'total_cents', 'outcome', 'risk', 'ai_summary', 'capture_id'],
    processCellCallback: (p) => (p.column.getColId() === 'total_cents' ? (p.value / 100).toFixed(2) : p.value),
  });
});

function syncGridTheme() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  $('ledger').className = dark ? 'ag-theme-quartz-dark' : 'ag-theme-quartz';
}
syncGridTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncGridTheme);

async function refundPurchase(purchase) {
  if (!confirm(`Refund ${usd(purchase.total_cents)} to your PayPal wallet?`)) return;
  try {
    await api(`/api/purchases/${purchase.id}/refund`, { method: 'POST', body: {} });
    toast(`Refunded ${usd(purchase.total_cents)} through PayPal`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  refresh();
}

const CHECK_MARK = { pass: '✓', review: '!', block: '✕' };

function closeDrawer() {
  document.body.classList.remove('drawer-open');
  $('drawer').setAttribute('aria-hidden', 'true');
}

async function openDrawer(id) {
  let p;
  try {
    p = await api(`/api/purchases/${id}`);
  } catch (err) {
    return toast(err.message, { error: true });
  }
  const paypalRows = [
    ['Order', p.order_id],
    ['Capture', p.capture_id],
    ['Capture status', p.capture_status],
    ['Refund', p.refund_id],
  ].filter(([, v]) => v);

  $('drawer').innerHTML = `
    <div class="drawer-top">
      <span class="eyebrow mono">${escapeHtml(p.id)}</span>
      <button class="btn btn-ghost btn-sm" id="drawer-close" type="button" aria-label="Close details">Close</button>
    </div>
    <h2>${usd(p.total_cents)} · ${escapeHtml(p.vendors)}</h2>
    <div class="drawer-status">${statusPill(p)}<span class="card-sub">AI risk ${p.risk}/100</span></div>

    <section>
      <div class="eyebrow">Agent request</div>
      <dl class="kv">
        <dt>Agent</dt><dd>${escapeHtml(p.agent)}</dd>
        <dt>Reason</dt><dd>${escapeHtml(p.reason)}</dd>
        <dt>Items</dt><dd>${p.items.map((i) => `${i.qty}× ${escapeHtml(i.name)} @ $${escapeHtml(i.unitPrice)}`).join('<br>')}</dd>
      </dl>
    </section>

    <section>
      <div class="eyebrow">Checks</div>
      <ul class="checks">
        ${p.checks
          .map(
            (c) =>
              `<li class="${escapeHtml(c.status)}"><span class="mark">${CHECK_MARK[c.status] ?? ''}</span><div>${escapeHtml(c.label)}<small>${escapeHtml(c.detail)}</small></div></li>`,
          )
          .join('')}
      </ul>
    </section>

    <section>
      <div class="eyebrow">AI risk review</div>
      <p class="drawer-summary">${escapeHtml(p.ai_summary)}</p>
      <ul class="drawer-reasons">${p.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
    </section>

    ${
      paypalRows.length
        ? `<section><div class="eyebrow">PayPal</div><dl class="kv">${paypalRows
            .map(([k, v]) => `<dt>${k}</dt><dd class="mono">${escapeHtml(v)}</dd>`)
            .join('')}</dl></section>`
        : ''
    }
    ${p.error ? `<section><div class="eyebrow">Error</div><p class="drawer-error">${escapeHtml(p.error)}</p></section>` : ''}

    <section>
      <div class="eyebrow">Audit trail</div>
      <ol class="events">${p.events
        .map((e) => `<li><span class="mono">${new Date(e.created_at).toLocaleTimeString()}</span> · ${escapeHtml(e.type)}</li>`)
        .join('')}</ol>
    </section>`;

  $('drawer-close').addEventListener('click', closeDrawer);
  document.body.classList.add('drawer-open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('drawer-close').focus();
}

$('drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
});
