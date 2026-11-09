import { z } from 'zod';
import { chatJson, injectionScore } from './groq.js';
import { RulesSchema } from './rules.js';
import { toCents, formatCents } from './money.js';
import { VENDORS } from './catalog.js';

const CATEGORIES = ['coffee', 'dairy', 'packaging', 'equipment', 'software', 'alcohol'];

const CompiledSchema = z.object({
  weeklyBudget: z.number().nonnegative().nullable(),
  autoApproveLimit: z.number().nonnegative().nullable(),
  allowedVendors: z.array(z.string()).default([]),
  blockedCategories: z.array(z.string()).default([]),
  blockRecurring: z.boolean().default(false),
  requireVerifiedVendors: z.boolean().default(true),
  notes: z.string().default(''),
  summary: z.array(z.string()).default([]),
});

const COMPILE_PROMPT = `You convert a business owner's plain-English spending rules for their AI purchasing agents into JSON.

Known vendors: ${Object.values(VENDORS).map((v) => v.name).join(', ')}.
Known categories: ${CATEGORIES.join(', ')}.

Return exactly this JSON shape:
{
  "weeklyBudget": number in USD or null if not stated,
  "autoApproveLimit": number in USD above which the owner must approve, or null if not stated,
  "allowedVendors": [full vendor names from the known list that the owner allows; [] if any vendor is fine],
  "blockedCategories": [categories from the known list the owner forbids],
  "blockRecurring": true if the owner forbids subscriptions, trials or recurring charges,
  "requireVerifiedVendors": true unless the owner explicitly allows unverified sellers,
  "notes": "any nuance not captured above, in one sentence, or empty",
  "summary": ["3-6 short bullet strings restating the rules, e.g. '$200 weekly budget'"]
}
Map nicknames to full vendor names (e.g. "BeanBros" -> "BeanBros Coffee Supply"). Never invent vendors.`;

export async function compileRules(text) {
  const raw = CompiledSchema.parse(await chatJson({ system: COMPILE_PROMPT, user: text }));
  const known = new Map(Object.values(VENDORS).map((v) => [v.name.toLowerCase(), v.name]));
  const weeklyBudgetCents = toCents(raw.weeklyBudget ?? 100);
  const rules = RulesSchema.parse({
    weeklyBudgetCents,
    autoApproveLimitCents: raw.autoApproveLimit == null ? weeklyBudgetCents : toCents(raw.autoApproveLimit),
    allowedVendors: raw.allowedVendors.map((v) => known.get(v.toLowerCase())).filter(Boolean),
    blockedCategories: raw.blockedCategories.map((c) => c.toLowerCase()).filter((c) => CATEGORIES.includes(c)),
    blockRecurring: raw.blockRecurring,
    requireVerifiedVendors: raw.requireVerifiedVendors,
    notes: raw.notes,
  });
  return { text, rules, summary: raw.summary };
}
