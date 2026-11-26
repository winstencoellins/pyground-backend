import { createHash, timingSafeEqual } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client";
import { receiptEmail } from "../../emails";
import { sendEmail } from "../../emails/send";
import { prisma } from "../../lib/prisma";
import { accessPass, PAYMENT_WINDOW_HOURS } from "./products";

const HOUR = 3_600_000;

/** signature_key = SHA512(order_id + status_code + gross_amount + server_key), hex. */
export function verifySignature(
  n: { order_id: string; status_code: string; gross_amount: string; signature_key: string },
  serverKey: string,
): boolean {
  const expected = createHash("sha512")
    .update(n.order_id + n.status_code + n.gross_amount + serverKey)
    .digest();
  const given = Buffer.from(n.signature_key, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type MidtransStatus = {
  status_code?: string;
  order_id?: string;
  transaction_status?: string;
  fraud_status?: string;
  gross_amount?: string;
  payment_type?: string;
  transaction_id?: string;
};

type Outcome = "PAID" | "PENDING" | "FAILED" | "EXPIRED" | "REFUNDED" | "IGNORE";

/** Maps Midtrans' confirmed status to what we do with the order. */
export function outcomeOf(s: MidtransStatus): Outcome {
  switch (s.transaction_status) {
    case "settlement":
      return "PAID";
    case "capture": // card: only an accepted fraud check counts; "challenge" waits for a later notification
      return s.fraud_status === "accept"
        ? "PAID"
        : s.fraud_status === "deny"
          ? "FAILED"
          : "PENDING";
    case "pending":
      return "PENDING";
    case "deny":
    case "cancel":
    case "failure":
      return "FAILED";
    case "expire":
      return "EXPIRED";
    case "refund":
    case "partial_refund":
      return "REFUNDED";
    default:
      return "IGNORE";
  }
}

/**
 * Applies a confirmed Midtrans status to our order. Idempotent: marking PAID and extending access
 * happen in one transaction that only proceeds if this call is the one that flipped the order to PAID.
 * Returns what changed, for logging/tests.
 */
export async function applyStatus(orderId: string, status: MidtransStatus) {
  const order = await prisma.order.findUnique({ where: { orderId } });
  if (!order) return { result: "unknown-order" as const };

  // Snap was opened but no payment method chosen, so Midtrans never created a transaction. Once the
  // payment window (plus an hour of slack for clock skew) has closed it never will.
  if (status.status_code === "404") {
    if (Date.now() - order.createdAt.getTime() < (PAYMENT_WINDOW_HOURS + 1) * HOUR) {
      return { result: "ignored" as const };
    }
    const expired = await prisma.order.updateMany({
      where: { id: order.id, status: "PENDING" },
      data: { status: "EXPIRED" },
    });
    return { result: expired.count ? ("set-expired" as const) : ("unchanged" as const) };
  }

  const outcome = outcomeOf(status);
  if (outcome === "IGNORE") return { result: "ignored" as const };
  // Never trust an amount we didn't charge.
  if (Number(status.gross_amount) !== order.amount) {
    console.error(
      `[midtrans] amount mismatch for ${orderId}: ${status.gross_amount} vs ${order.amount}`,
    );
    return { result: "amount-mismatch" as const };
  }

  const details = {
    paymentType: status.payment_type ?? null,
    midtransTransactionId: status.transaction_id ?? null,
    rawNotification: status as Prisma.InputJsonValue,
  };

  if (outcome === "PAID") {
    const days = accessPass().days;
    return prisma.$transaction(async (tx) => {
      const flipped = await tx.order.updateMany({
        where: { id: order.id, status: { not: "PAID" } },
        data: { ...details, status: "PAID", paidAt: new Date() },
      });
      if (flipped.count === 0) return { result: "already-paid" as const };
      // accessUntil = max(now, accessUntil) + 30 days, atomically in SQL (safe with concurrent orders).
      await tx.$executeRaw`
        UPDATE users
        SET access_until = GREATEST(COALESCE(access_until, now()), now()) + make_interval(days => ${days}),
            updated_at = now()
        WHERE id = ${order.userId}`;
      return { result: "paid" as const };
    });
  }

  // REFUNDED may follow PAID; nothing else may overwrite a PAID order.
  const updated = await prisma.order.updateMany({
    where: { id: order.id, ...(outcome === "REFUNDED" ? {} : { status: { not: "PAID" } }) },
    data: { ...details, status: outcome },
  });
  // shortcut: a refund doesn't shorten accessUntil; an admin revokes access manually (AccessGrant) if needed.
  return {
    result: updated.count ? (`set-${outcome.toLowerCase()}` as const) : ("unchanged" as const),
  };
}

/** Emails the receipt for a PAID order. Never throws. */
export async function sendReceipt(orderId: string): Promise<boolean> {
  try {
    const order = await prisma.order.findUniqueOrThrow({
      where: { orderId },
      include: { user: true },
    });
    if (order.status !== "PAID" || !order.paidAt || !order.user.accessUntil) return false;
    return await sendEmail(
      receiptEmail(order.user, {
        orderId: order.orderId,
        amount: order.amount,
        paidAt: order.paidAt,
        paymentType: order.paymentType,
        accessUntil: order.user.accessUntil,
      }),
    );
  } catch (err) {
    console.error(`[email] receipt for ${orderId} failed:`, (err as Error).message);
    return false;
  }
}
