// What can be bought. Today: a one-off 30-day pass. A Midtrans Subscription plan (task #44) would be
// another entry here with its own checkout path; fulfilment (extend accessUntil) stays the same.
export type Product = { id: string; name: string; days: number; price: number };

export function accessPass(): Product {
  const raw = process.env.ACCESS_PASS_PRICE_IDR ?? "49000";
  const price = Number(raw);
  if (!Number.isInteger(price) || price < 1000) {
    throw new Error(`ACCESS_PASS_PRICE_IDR must be an integer Rupiah amount >= 1000, got "${raw}"`);
  }
  return { id: "access-pass-30d", name: "Pyground 30-day access pass", days: 30, price };
}
