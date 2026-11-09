import { randomUUID } from 'node:crypto';
import { config } from './config.js';

export class PayPalError extends Error {
  constructor(status, body) {
    const detail = body?.details?.[0]?.description || body?.message || `HTTP ${status}`;
    super(`PayPal ${body?.name || 'error'}: ${detail}`);
    this.status = status;
    this.name = 'PayPalError';
    this.code = body?.details?.[0]?.issue || body?.name;
    this.debugId = body?.debug_id;
  }
}

let cachedToken = null;
let pendingToken = null;

async function fetchAccessToken() {
  const credentials = Buffer.from(
    `${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`,
  ).toString('base64');
  const res = await fetch(`${config.paypalBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const body = await res.json();
  if (!res.ok) throw new PayPalError(res.status, body);
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
  };
  return cachedToken.value;
}

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  pendingToken ??= fetchAccessToken().finally(() => {
    pendingToken = null;
  });
  return pendingToken;
}

async function request(method, path, { body, requestId } = {}) {
  const res = await fetch(`${config.paypalBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(requestId && { 'PayPal-Request-Id': requestId }),
    },
    body: body && JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new PayPalError(res.status, data);
  return data;
}

export async function createVaultSetupToken({ returnUrl, cancelUrl, brandName }) {
  const token = await request('POST', '/v3/vault/setup-tokens', {
    requestId: randomUUID(),
    body: {
      payment_source: {
        paypal: {
          usage_type: 'MERCHANT',
          usage_pattern: 'UNSCHEDULED_POSTPAID',
          description: 'Leash pays approved purchases made by your AI agents',
          experience_context: {
            brand_name: brandName,
            return_url: returnUrl,
            cancel_url: cancelUrl,
            shipping_preference: 'GET_FROM_FILE',
          },
        },
      },
    },
  });
  return {
    id: token.id,
    approveUrl: token.links.find((l) => l.rel === 'approve')?.href,
  };
}

export async function createPaymentToken(setupTokenId) {
  const token = await request('POST', '/v3/vault/payment-tokens', {
    requestId: `pt-${setupTokenId}`,
    body: { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } },
  });
  return {
    id: token.id,
    customerId: token.customer?.id,
    payerEmail: token.payment_source?.paypal?.email_address ?? null,
  };
}

export function getPaymentToken(id) {
  return request('GET', `/v3/vault/payment-tokens/${encodeURIComponent(id)}`);
}

export function deletePaymentToken(id) {
  return request('DELETE', `/v3/vault/payment-tokens/${encodeURIComponent(id)}`);
}

function orderItems(items) {
  return items.map((item) => ({
    name: item.name.slice(0, 127),
    sku: item.sku,
    quantity: String(item.qty),
    unit_amount: { currency_code: 'USD', value: item.unitPrice },
    category: 'PHYSICAL_GOODS',
  }));
}

export async function chargeVault({ vaultId, purchaseId, vendorSummary, items, total }) {
  const order = await request('POST', '/v2/checkout/orders', {
    requestId: `charge-${purchaseId}`,
    body: {
      intent: 'CAPTURE',
      payment_source: { paypal: { vault_id: vaultId } },
      purchase_units: [
        {
          reference_id: purchaseId,
          invoice_id: purchaseId,
          custom_id: purchaseId,
          description: `Agent purchase via Leash: ${vendorSummary}`.slice(0, 127),
          soft_descriptor: 'LEASH AGENT',
          items: orderItems(items),
          amount: {
            currency_code: 'USD',
            value: total,
            breakdown: { item_total: { currency_code: 'USD', value: total } },
          },
        },
      ],
    },
  });
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    orderId: order.id,
    orderStatus: order.status,
    captureId: capture?.id ?? null,
    captureStatus: capture?.status ?? null,
  };
}
