import { z } from 'zod';

const schema = z.object({
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_VAULT_ID: z.string().optional(),
  GROQ_API_KEY: z.string().min(1),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  GROQ_GUARD_MODEL: z.string().default('meta-llama/llama-prompt-guard-2-86m'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  LEASH_AGENT_KEY: z.string().optional(),
  DASHBOARD_PASSWORD: z.string().optional(),
  DATABASE_PATH: z.string().default('leash.db'),
});

const env = Object.fromEntries(
  Object.entries(process.env)
    .map(([key, value]) => [key, value.trim()])
    .filter(([, value]) => value !== ''),
);
const parsed = schema.safeParse(env);

if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  console.error(`Invalid environment configuration: ${missing}. See .env.example.`);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  PUBLIC_URL: parsed.data.PUBLIC_URL.replace(/\/$/, ''),
  paypalBase:
    parsed.data.PAYPAL_ENV === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com',
};
