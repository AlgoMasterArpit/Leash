import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let groq;
const realFetch = globalThis.fetch;

before(async () => {
  Object.assign(process.env, {
    PAYPAL_CLIENT_ID: 'test',
    PAYPAL_CLIENT_SECRET: 'test',
    GROQ_API_KEY: 'test',
    GROQ_MODEL: 'primary-model',
    GROQ_FALLBACK_MODELS: 'backup-model',
  });
  groq = await import('../src/groq.js');
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('falls back to the next model when the daily quota is used up', async () => {
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const { model } = JSON.parse(init.body);
    asked.push(model);
    if (model === 'primary-model') {
      return respond(429, { error: { message: 'Rate limit reached on tokens per day (TPD)' } });
    }
    return respond(200, { choices: [{ message: { content: 'ok' } }] });
  };
  const reply = await groq.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(reply.content, 'ok');
  assert.deepEqual(asked, ['primary-model', 'backup-model']);
  assert.equal(groq.modelUsage()['backup-model'], 1);
});

test('does not fall back on errors that another model would not fix', async () => {
  const asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push(JSON.parse(init.body).model);
    return respond(400, { error: { message: 'Bad request' } });
  };
  await assert.rejects(groq.chat({ messages: [{ role: 'user', content: 'hi' }] }), /Groq 400/);
  assert.deepEqual(asked, ['primary-model']);
});

test('rejects a non-numeric Prompt Guard score', async () => {
  globalThis.fetch = async () => respond(200, { choices: [{ message: { content: 'SAFE' } }] });
  await assert.rejects(groq.injectionScore('hello'), /non-numeric/);
});
