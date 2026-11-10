import { config } from './config.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class GroqError extends Error {
  constructor(status, message) {
    super(`Groq ${status}: ${message}`);
    this.name = 'GroqError';
    this.status = status;
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
  if (RETRYABLE.has(res.status) && attempt < 5) {
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(retryAfter + 0.5, 60) * 1000));
    return post(body, attempt + 1);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new GroqError(res.status, data?.error?.message || res.statusText);
  return data.choices[0].message;
}

export function chat({ messages, tools, temperature = 0.2, model = config.GROQ_MODEL }) {
  return post({ model, messages, temperature, ...(tools && { tools, tool_choice: 'auto' }) });
}

export async function chatJson({ system, user, model = config.GROQ_MODEL }) {
  const message = await post({
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
  const score = Number(message.content);
  return Number.isFinite(score) ? score : 0;
}
