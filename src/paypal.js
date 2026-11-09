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
