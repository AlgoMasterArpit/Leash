import { z } from 'zod';

export const PurchaseItems = z
  .array(z.object({ sku: z.string().min(1).max(40), qty: z.number().int().min(1).max(100) }))
  .min(1)
  .max(20);

export const PurchaseBody = z.object({
  agent: z.string().trim().min(1).max(80),
  reason: z.string().trim().min(1).max(500),
  items: PurchaseItems,
});
