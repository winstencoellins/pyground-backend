// Hourly cron (Railway: 15 * * * *): settles PENDING orders whose payment window has closed. Each one is
// checked with Midtrans first, so a payment whose notification we missed is still credited (PAID + access)
// and an order whose Snap page was abandoned without choosing a method becomes EXPIRED. Ones Midtrans
// still calls pending are left for Midtrans' own expire notification. Safe to re-run.
import type { Prisma } from "../generated/prisma/client";
import { prisma } from "../lib/prisma";
import { applyStatus, sendReceipt } from "../modules/payments/fulfill";
import { getTransactionStatus } from "../modules/payments/midtrans";
import { PAYMENT_WINDOW_HOURS } from "../modules/payments/products";

const HOUR = 3_600_000;

/** `scope` narrows the sweep (tests use it to leave other orders in a shared database alone). */
export async function expireOrders(now = new Date(), scope: Prisma.OrderWhereInput = {}) {
  const orders = await prisma.order.findMany({
    where: {
      ...scope,
      status: "PENDING",
      createdAt: { lt: new Date(now.getTime() - (PAYMENT_WINDOW_HOURS + 1) * HOUR) },
    },
    orderBy: { createdAt: "asc" },
    take: 500, // shortcut: a bigger backlog is finished by the next hourly runs
  });
  const counts: Record<string, number> = {};
  for (const order of orders) {
    const status = await getTransactionStatus(order.orderId).catch((err) => {
      console.warn(`[expire-orders] ${order.orderId}: ${(err as Error).message}`);
      return null;
    });
    const result = status ? (await applyStatus(order.orderId, status)).result : "unreachable";
    if (result === "paid") await sendReceipt(order.orderId);
    counts[result] = (counts[result] ?? 0) + 1;
  }
  return counts;
}

if (import.meta.main) {
  const counts = await expireOrders();
  console.log(`[expire-orders] ${JSON.stringify(counts)}`);
  await prisma.$disconnect();
  process.exit(counts.unreachable ? 1 : 0); // Midtrans down: show the run as failed; the next run retries
}
