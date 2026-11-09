import { config } from '../src/config.js';
import { createWebhook } from '../src/paypal.js';

const EVENTS = [
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
];

const url = `${config.PUBLIC_URL}/webhooks/paypal`;
if (!url.startsWith('https://')) {
  console.error(`PayPal only delivers webhooks to HTTPS URLs. Set PUBLIC_URL to your deployed URL (got ${url}).`);
  process.exit(1);
}

const webhook = await createWebhook(url, EVENTS);
console.log(`Registered webhook ${webhook.id} for ${url}`);
console.log(`Set PAYPAL_WEBHOOK_ID=${webhook.id} in your environment.`);
