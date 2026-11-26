// The same rates for every marketer (product decision), set per environment.

type Env = Record<string, string | undefined>;

function percent(name: string, fallback: number, max: number, env: Env): number {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be a whole percentage from 0 to ${max}, got "${raw}"`);
  }
  return value;
}

/** Discount for a first-time buyer who enters a valid marketer code. */
export const discountPercent = (env: Env = process.env) =>
  percent("MARKETING_DISCOUNT_PERCENT", 10, 90, env);
/** Marketer's commission, as a percentage of what the buyer actually paid. */
export const commissionPercent = (env: Env = process.env) =>
  percent("MARKETING_COMMISSION_PERCENT", 20, 100, env);

/** Rupiah amounts for a code purchase. Rounded down: the buyer never pays more, commission never exceeds. */
export function codePricing(listPrice: number) {
  const discount = Math.floor((listPrice * discountPercent()) / 100);
  const amount = listPrice - discount;
  const commission = Math.floor((amount * commissionPercent()) / 100);
  return { listPrice, discount, amount, commission };
}
