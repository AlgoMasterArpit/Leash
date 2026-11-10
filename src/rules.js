import { z } from 'zod';
import { formatCents } from './money.js';

export const DEFAULT_RULES_TEXT =
  'Spend up to $200 a week on café supplies. Only buy from our approved suppliers: BeanBros, CupCo and KitchenPro. ' +
  'Ask me before any single purchase over $50. Never sign up for subscriptions or free trials.';

export const RulesSchema = z.object({
  weeklyBudgetCents: z.number().int().nonnegative(),
  autoApproveLimitCents: z.number().int().nonnegative(),
  allowedVendors: z.array(z.string()),
  blockedCategories: z.array(z.string()),
  blockRecurring: z.boolean(),
  requireVerifiedVendors: z.boolean(),
  notes: z.string().default(''),
});

const RANK = { approve: 0, review: 1, block: 2 };
const STATUS_TO_DECISION = { pass: 'approve', review: 'review', block: 'block' };

export function strictest(...decisions) {
  return decisions.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'approve');
}

const usd = (cents) => `$${formatCents(cents)}`;

export function evaluateHardRules({ rules, items, totalCents, spentCents, recentAutoPaidCents = 0 }) {
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });

  const remaining = rules.weeklyBudgetCents - spentCents;
  add(
    'budget',
    'Weekly budget',
    totalCents <= remaining ? 'pass' : 'block',
    totalCents <= remaining
      ? `${usd(totalCents)} of ${usd(Math.max(remaining, 0))} left this week`
      : `Needs ${usd(totalCents)} but only ${usd(Math.max(remaining, 0))} is left this week`,
  );

  const vendors = [...new Map(items.map((i) => [i.vendorName, i])).values()];
  if (rules.allowedVendors.length) {
    const allowed = new Set(rules.allowedVendors.map((v) => v.toLowerCase()));
    const outside = vendors.filter((i) => !allowed.has(i.vendorName.toLowerCase()));
    add(
      'vendors',
      'Approved vendors',
      outside.length ? 'block' : 'pass',
      outside.length
        ? `Not on your approved list: ${outside.map((i) => i.vendorName).join(', ')}`
        : 'All vendors are on your approved list',
    );
  }

  if (rules.requireVerifiedVendors) {
    const unverified = vendors.filter((i) => !i.verified);
    add(
      'verified',
      'Verified merchants',
      unverified.length ? 'block' : 'pass',
      unverified.length
        ? `Unverified merchant: ${unverified.map((i) => i.vendorName).join(', ')}`
        : 'All merchants are verified',
    );
  }

  const blocked = new Set(rules.blockedCategories.map((c) => c.toLowerCase()));
  const blockedItems = items.filter((i) => blocked.has(i.category.toLowerCase()));
  if (blocked.size) {
    add(
      'categories',
      'Blocked categories',
      blockedItems.length ? 'block' : 'pass',
      blockedItems.length
        ? `Blocked category: ${[...new Set(blockedItems.map((i) => i.category))].join(', ')}`
        : 'No blocked categories',
    );
  }

  if (rules.blockRecurring) {
    const recurring = items.filter((i) => i.recurring);
    add(
      'recurring',
      'No subscriptions',
      recurring.length ? 'block' : 'pass',
      recurring.length
        ? `Recurring charge: ${recurring.map((i) => i.name).join(', ')}`
        : 'No recurring charges',
    );
  }

  const overLimit = totalCents > rules.autoApproveLimitCents;
  add(
    'limit',
    'Auto-approve limit',
    overLimit ? 'review' : 'pass',
    overLimit
      ? `${usd(totalCents)} is over your ${usd(rules.autoApproveLimitCents)} auto-approve limit`
      : `Under your ${usd(rules.autoApproveLimitCents)} auto-approve limit`,
  );

  if (!overLimit && recentAutoPaidCents > 0) {
    const combined = totalCents + recentAutoPaidCents;
    const split = combined > rules.autoApproveLimitCents;
    add(
      'splitting',
      'Order splitting',
      split ? 'review' : 'pass',
      split
        ? `With ${usd(recentAutoPaidCents)} auto-paid to the same vendor in the last 24 hours, this adds up to ${usd(combined)}, over your ${usd(rules.autoApproveLimitCents)} limit`
        : `${usd(combined)} auto-paid to this vendor in the last 24 hours, under your limit`,
    );
  }

  return {
    decision: strictest(...checks.map((c) => STATUS_TO_DECISION[c.status])),
    checks,
  };
}
