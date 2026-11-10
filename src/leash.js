import { randomBytes } from 'node:crypto';
import { AppError } from './errors.js';
import { startOfWeek } from './db.js';
import { evaluateHardRules, strictest } from './rules.js';
import { toCents, formatCents } from './money.js';

export const INJECTION_THRESHOLD = 0.5;

const STATUS_FOR_DECISION = { approve: 'processing', review: 'pending_owner', block: 'blocked' };

const WEBHOOK_TRANSITIONS = {
  'PAYMENT.CAPTURE.COMPLETED': { from: ['processing', 'payment_pending', 'failed'], set: { status: 'paid', capture_status: 'COMPLETED' } },
  'PAYMENT.CAPTURE.PENDING': { from: ['processing'], set: { status: 'payment_pending', capture_status: 'PENDING' } },
  'PAYMENT.CAPTURE.DENIED': { from: ['processing', 'payment_pending'], set: { status: 'failed', capture_status: 'DENIED' } },
  'PAYMENT.CAPTURE.REFUNDED': { from: ['paid'], set: {} },
};

function purchaseId() {
  return `pur_${randomBytes(6).toString('hex')}`;
}

export function createLeash({ store, paypal, ai, catalog, publicUrl, seedVaultId }) {
  // ponytail: in-process lock, swap for a DB row lock if this ever runs on more than one instance
  let lock = Promise.resolve();
  function serialized(fn) {
    const run = lock.then(fn);
    lock = run.catch(() => {});
    return run;
  }

  function rules() {
    const current = store.getSetting('rules');
    if (!current) throw new AppError(409, 'Spending rules have not been set yet', 'NO_RULES');
    return current;
  }

  function wallet() {
    const saved = store.getSetting('wallet');
    if (saved?.disconnected) return null;
    if (saved) return saved;
    if (seedVaultId) return { vaultId: seedVaultId, payerEmail: null, seeded: true };
    return null;
  }

  function spentThisWeek() {
    return store.spentSinceCents(startOfWeek());
  }

  // Agent names are self-reported, so splitting is tracked per vendor across every agent.
  function recentAutoPaidCents(items) {
    const vendors = new Set(items.map((i) => i.vendorName));
    return store
      .recentPurchases(24)
      .filter(
        (p) =>
          ['paid', 'payment_pending', 'processing'].includes(p.status) &&
          p.decided_by === 'policy' &&
          p.items.some((i) => vendors.has(i.vendorName)),
      )
      .reduce((sum, p) => sum + p.total_cents, 0);
  }

  function resolveItems(requested) {
    return requested.map(({ sku, qty }) => {
      const product = catalog.findProduct(sku);
      if (!product) throw new AppError(400, `Unknown product SKU: ${sku}`, 'UNKNOWN_SKU');
      return { ...product, qty };
    });
  }

  async function aiReview(input) {
    const [verdict, injection] = await Promise.allSettled([ai.judgePurchase(input), ai.scanForInjection(input)]);
    return {
      verdict:
        verdict.status === 'fulfilled'
          ? verdict.value
          : {
              verdict: 'review',
              risk: 50,
              reasons: ['AI review was unavailable, so a human needs to approve this'],
              summary: 'AI review unavailable; sent to the owner as a precaution.',
            },
      injectionScore: injection.status === 'fulfilled' ? injection.value : null,
    };
  }

  async function charge(purchase) {
    const current = wallet();
    if (!current) {
      store.logEvent('paypal.charge_failed', purchase.id, { message: 'No PayPal wallet connected' });
      return store.updatePurchase(purchase.id, { status: 'failed', error: 'No PayPal wallet connected' });
    }
    try {
      const result = await paypal.chargeVault({
        vaultId: current.vaultId,
        purchaseId: purchase.id,
        vendorSummary: purchase.vendors,
        items: purchase.items,
        total: formatCents(purchase.total_cents),
      });
      const paid = result.captureStatus === 'COMPLETED';
      store.logEvent('paypal.charged', purchase.id, result);
      return store.updatePurchase(purchase.id, {
        status: paid ? 'paid' : 'payment_pending',
        paid_at: new Date().toISOString(),
        order_id: result.orderId,
        capture_id: result.captureId,
        capture_status: result.captureStatus,
      });
    } catch (err) {
      store.logEvent('paypal.charge_failed', purchase.id, { message: err.message, debugId: err.debugId });
      return store.updatePurchase(purchase.id, { status: 'failed', error: err.message });
    }
  }

  return {
    rules,
    wallet,

    async setRules(text, compile = ai.compileRules) {
      const compiled = await compile(text);
      store.setSetting('rules', compiled);
      store.logEvent('rules.updated', null, compiled);
      return compiled;
    },

    budget() {
      const current = store.getSetting('rules');
      const spentCents = spentThisWeek();
      const weeklyBudgetCents = current?.rules.weeklyBudgetCents ?? 0;
      const week = store.totalsByStatusSince(startOfWeek());
      const allTime = store.totalsByStatusSince(new Date(0));
      return {
        weeklyBudgetCents,
        autoApproveLimitCents: current?.rules.autoApproveLimitCents ?? 0,
        spentCents,
        remainingCents: Math.max(weeklyBudgetCents - spentCents, 0),
        pendingCount: allTime.pending_owner?.count ?? 0,
        blockedCount: week.blocked?.count ?? 0,
        blockedCents: week.blocked?.cents ?? 0,
        weekStart: startOfWeek().toISOString(),
      };
    },

    async startConnect() {
      return paypal.createVaultSetupToken({
        returnUrl: `${publicUrl}/connect/return`,
        cancelUrl: `${publicUrl}/?connect=cancelled`,
        brandName: 'Leash',
      });
    },

    async finishConnect(setupTokenId) {
      const token = await paypal.createPaymentToken(setupTokenId);
      const saved = { vaultId: token.id, payerEmail: token.payerEmail, connectedAt: new Date().toISOString() };
      store.setSetting('wallet', saved);
      store.logEvent('wallet.connected', null, { payerEmail: token.payerEmail });
      return saved;
    },

    async disconnect() {
      const current = store.getSetting('wallet');
      if (current?.vaultId) await paypal.deletePaymentToken(current.vaultId).catch(() => {});
      store.setSetting('wallet', { disconnected: true, disconnectedAt: new Date().toISOString() });
      store.logEvent('wallet.disconnected');
    },

    async requestPurchase({ agent, reason, items: requested, idempotencyKey }) {
      const repeat = idempotencyKey && store.findPurchaseByIdempotencyKey(idempotencyKey);
      if (repeat) return repeat;
      const { text: rulesText, rules: policy } = rules();
      if (!wallet()) throw new AppError(409, 'Connect a PayPal account first', 'NO_WALLET');

      const items = resolveItems(requested);
      const totalCents = items.reduce((sum, i) => sum + toCents(i.unitPrice) * i.qty, 0);
      const preview = evaluateHardRules({
        rules: policy,
        items,
        totalCents,
        spentCents: spentThisWeek(),
        recentAutoPaidCents: recentAutoPaidCents(items),
      });
      const review = await aiReview({
        rulesText,
        rules: policy,
        agent,
        reason,
        items,
        totalCents,
        spentCents: spentThisWeek(),
        recent: store.recentPurchases(),
        checks: preview.checks,
      });

      return serialized(async () => {
        const raced = idempotencyKey && store.findPurchaseByIdempotencyKey(idempotencyKey);
        if (raced) return raced;
        const hard = evaluateHardRules({
          rules: rules().rules,
          items,
          totalCents,
          spentCents: spentThisWeek(),
          recentAutoPaidCents: recentAutoPaidCents(items),
        });
        const scannerDown = review.injectionScore == null;
        const injected = !scannerDown && review.injectionScore >= INJECTION_THRESHOLD;
        const injectionStatus = injected ? 'block' : scannerDown ? 'review' : 'pass';
        const checks = [
          ...hard.checks,
          {
            id: 'injection',
            label: 'Prompt injection scan',
            status: injectionStatus,
            detail: scannerDown
              ? 'Scanner unavailable, so the owner must approve'
              : injected
                ? `Manipulative instructions detected (score ${review.injectionScore.toFixed(2)})`
                : 'No manipulation detected',
          },
        ];
        const decision = strictest(
          hard.decision,
          review.verdict.verdict,
          { pass: 'approve', review: 'review', block: 'block' }[injectionStatus],
        );

        const purchase = store.insertPurchase({
          id: purchaseId(),
          agent,
          reason,
          items: items.map(({ sku, name, vendorName, category, unitPrice, qty, recurring }) => ({
            sku,
            name,
            vendorName,
            category,
            unitPrice,
            qty,
            recurring: Boolean(recurring),
          })),
          vendors: [...new Set(items.map((i) => i.vendorName))].join(', '),
          total_cents: totalCents,
          decision,
          status: STATUS_FOR_DECISION[decision],
          risk: Math.round(review.verdict.risk),
          reasons: review.verdict.reasons,
          checks,
          ai_summary: review.verdict.summary,
          injection_score: review.injectionScore,
          decided_by: 'policy',
          idempotency_key: idempotencyKey ?? null,
        });
        store.logEvent(`purchase.${decision}`, purchase.id, { totalCents, checks });

        return decision === 'approve' ? charge(purchase) : purchase;
      });
    },

    previewPurchase({ agent, items: requested }) {
      const { rules: policy } = rules();
      const items = resolveItems(requested);
      const totalCents = items.reduce((sum, i) => sum + toCents(i.unitPrice) * i.qty, 0);
      const spentCents = spentThisWeek();
      const { decision, checks } = evaluateHardRules({
        rules: policy,
        items,
        totalCents,
        spentCents,
        recentAutoPaidCents: recentAutoPaidCents(items),
      });
      return {
        decision,
        totalCents,
        remainingCents: Math.max(policy.weeklyBudgetCents - spentCents, 0),
        checks,
        note: 'Rules only. The real request also runs the AI risk judge and the injection scan, which can only make the decision stricter.',
      };
    },

    approve(id) {
      return serialized(async () => {
        const purchase = store.getPurchase(id);
        if (!purchase) throw new AppError(404, 'Purchase not found');
        if (purchase.status !== 'pending_owner') {
          throw new AppError(409, `Purchase is ${purchase.status}, not awaiting approval`);
        }
        const { rules: policy } = rules();
        if (spentThisWeek() + purchase.total_cents > policy.weeklyBudgetCents) {
          throw new AppError(409, 'Approving this would exceed the weekly budget', 'OVER_BUDGET');
        }
        if (!wallet()) throw new AppError(409, 'Connect a PayPal account first', 'NO_WALLET');
        store.updatePurchase(id, { decided_by: 'owner', status: 'processing' });
        store.logEvent('purchase.owner_approved', id);
        return charge(store.getPurchase(id));
      });
    },

    decline(id) {
      const purchase = store.getPurchase(id);
      if (!purchase) throw new AppError(404, 'Purchase not found');
      if (purchase.status !== 'pending_owner') {
        throw new AppError(409, `Purchase is ${purchase.status}, not awaiting approval`);
      }
      store.logEvent('purchase.owner_declined', id);
      return store.updatePurchase(id, { decided_by: 'owner', status: 'declined' });
    },

    async refund(id, note) {
      const purchase = store.getPurchase(id);
      if (!purchase) throw new AppError(404, 'Purchase not found');
      if (purchase.status !== 'paid' || !purchase.capture_id) {
        throw new AppError(409, 'Only paid purchases can be refunded');
      }
      const result = await paypal.refundCapture(purchase.capture_id, {
        purchaseId: id,
        note: note || 'Refunded by the business owner through Leash',
      });
      store.logEvent('paypal.refunded', id, result);
      return store.updatePurchase(id, { status: 'refunded', refund_id: result.refundId });
    },

    getPurchase(id) {
      const purchase = store.getPurchase(id);
      if (!purchase) throw new AppError(404, 'Purchase not found');
      return { ...purchase, events: store.listEvents(id) };
    },

    listPurchases() {
      return store.listPurchases();
    },

    handleWebhook(event) {
      const resource = event.resource ?? {};
      const captureId =
        event.event_type === 'PAYMENT.CAPTURE.REFUNDED'
          ? resource.links?.find((l) => l.rel === 'up')?.href.split('/').pop()
          : resource.id;
      const purchase =
        (resource.custom_id && store.getPurchase(resource.custom_id)) ||
        (captureId && store.findPurchaseByCaptureId(captureId));
      if (!purchase) return null;

      store.logEvent(`webhook.${event.event_type}`, purchase.id, { id: event.id, status: resource.status });
      const transition = WEBHOOK_TRANSITIONS[event.event_type];
      if (!transition || !transition.from.includes(purchase.status)) return purchase;

      if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
        const refundedCents = resource.amount?.value ? toCents(resource.amount.value) : purchase.total_cents;
        if (refundedCents < purchase.total_cents) {
          store.logEvent('paypal.partial_refund', purchase.id, { refundedCents });
          return purchase;
        }
        return store.updatePurchase(purchase.id, { status: 'refunded', refund_id: resource.id });
      }
      return store.updatePurchase(purchase.id, {
        ...transition.set,
        ...(transition.set.status === 'paid' && !purchase.paid_at && { paid_at: new Date().toISOString() }),
      });
    },

    resetDemo() {
      store.clearActivity();
      store.logEvent('demo.reset');
    },
  };
}
