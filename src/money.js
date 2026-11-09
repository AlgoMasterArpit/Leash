export function toCents(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) throw new TypeError(`Invalid amount: ${value}`);
  return Math.round(n * 100);
}

export function formatCents(cents) {
  return (cents / 100).toFixed(2);
}
