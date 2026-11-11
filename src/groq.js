import { config } from './config.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class GroqError extends Error {
  constructor(status, message, { quotaExhausted = false } = {}) {
    super(`Groq ${status}: ${message}`);
    this.name = 'GroqError';
    this.status = status;
    this.quotaExhausted = quotaExhausted;
  }
}

async function post(body, attempt = 0) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => null);
  const message = data?.error?.message || res.statusText;

  // A daily quota won't recover by waiting a minute, so let the caller switch models instead.
  if (res.status === 429 && /per day/i.test(message)) {
    throw new GroqError(429, message, { quotaExhausted: true });
  }
  if (RETRYABLE.has(res.status) && attempt < 5) {
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(retryAfter + 0.5, 60) * 1000));
    return post(body, attempt + 1);
  }
  if (!res.ok) throw new GroqError(res.status, message);
  return data.choices[0].message;
}

const usage = {};

export function modelUsage() {
  return { ...usage };
}

export function modelChain(primary = config.GROQ_MODEL) {
  return [...new Set([primary, ...config.GROQ_FALLBACK_MODELS])];
}

async function postWithFallback(body) {
  let lastError;
  for (const model of modelChain(body.model)) {
    try {
      const message = await post({ ...body, model });
      usage[model] = (usage[model] ?? 0) + 1;
      return message;
    } catch (err) {
      if (!(err instanceof GroqError && err.quotaExhausted)) throw err;
      console.warn(`Groq daily quota reached for ${model}, trying the next model`);
      lastError = err;
    }
  }
  throw lastError;
}

export function chat({ messages, tools, temperature = 0.2, model = config.GROQ_MODEL }) {
  return postWithFallback({ model, messages, temperature, ...(tools && { tools, tool_choice: 'auto' }) });
}

export async function chatJson({ system, user, model = config.GROQ_MODEL }) {
  const message = await postWithFallback({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return JSON.parse(message.content);
}

export async function injectionScore(text) {
  const message = await post({
    model: config.GROQ_GUARD_MODEL,
    messages: [{ role: 'user', content: text.slice(0, 2000) }],
  });
  const score = Number.parseFloat(message.content);
  if (!Number.isFinite(score)) throw new GroqError(502, `Prompt Guard returned a non-numeric score: ${message.content}`);
  return score;
}
