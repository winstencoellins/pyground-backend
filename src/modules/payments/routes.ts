import { Elysia, t } from "elysia";
import { ApiError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { limit } from "../../lib/rate-limit";
import { sessionPlugin } from "../../plugins/session";
import { applyStatus, sendReceipt, verifySignature } from "./fulfill";
import { createSnapTransaction, getTransactionStatus, serverKey } from "./midtrans";
import { accessPass, PAYMENT_WINDOW_HOURS } from "./products";

const HOUR = 3_600_000;

const orderView = (o: {
  orderId: string;
  amount: number;
  status: string;
  paymentType: string | null;
  createdAt: Date;
  paidAt: Date | null;
  snapRedirectUrl: string | null;
}) => {
  const payUntil = new Date(o.createdAt.getTime() + PAYMENT_WINDOW_HOURS * HOUR);
  return {
    orderId: o.orderId,
    amount: o.amount,
    status: o.status as "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "REFUNDED",
    paymentType: o.paymentType,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    /** When the Snap page stops accepting payment. */
    payUntil,
    /** Midtrans' Snap page, to finish paying; only while the order is PENDING and the window is open. */
    paymentUrl: o.status === "PENDING" && payUntil > new Date() ? o.snapRedirectUrl : null,
  };
};

// PYG-<base36 time>-<random>: unique, sortable, well under Midtrans' 50-char order_id limit.
const newOrderId = () =>
  `PYG-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

/**
 * The user's unfinished order, if its Snap page can still be paid, so Buy resumes it instead of making a
 * duplicate. Midtrans is asked first: an order that was meanwhile paid, expired or failed is updated and
 * not reused. Needs an hour left on the clock, and the current price.
 */
async function resumableOrder(userId: string, price: number) {
  const order = await prisma.order.findFirst({
    where: {
      userId,
      status: "PENDING",
      amount: price,
      snapRedirectUrl: { not: null },
      createdAt: { gt: new Date(Date.now() - (PAYMENT_WINDOW_HOURS - 1) * HOUR) },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!order?.snapToken || !order.snapRedirectUrl) return null;
  const status = await getTransactionStatus(order.orderId).catch(() => null);
  if (!status) return null; // can't confirm it is still open: start a fresh one
  if (status.status_code === "404" || status.transaction_status === "pending") {
    return { ...order, snapToken: order.snapToken, snapRedirectUrl: order.snapRedirectUrl };
  }
  const { result } = await applyStatus(order.orderId, status);
  if (result === "paid") void sendReceipt(order.orderId);
  return null;
}

export const paymentRoutes = new Elysia({ prefix: "/api/payments" })
  .use(sessionPlugin)
  // Public: the landing page shows the real price from the same config checkout charges.
  .get("/pass", () => {
    const { id, days, price } = accessPass();
    return { id, days, price, currency: "IDR" as const };
  })
  .post(
    "/checkout",
    async ({ user }) => {
      const product = accessPass();
      const open = await resumableOrder(user.id, product.price);
      if (open)
        return {
          snapToken: open.snapToken,
          redirectUrl: open.snapRedirectUrl,
          orderId: open.orderId,
        };
      const order = await prisma.order.create({
        data: { userId: user.id, orderId: newOrderId(), amount: product.price },
      });
      try {
        const snap = await createSnapTransaction({
          orderId: order.orderId,
          amount: order.amount,
          item: product,
          customer: { name: user.name, email: user.email },
          finishUrl: `${process.env.WEB_URL}/payment/result?orderId=${order.orderId}`,
        });
        await prisma.order.update({
          where: { id: order.id },
          data: { snapToken: snap.token, snapRedirectUrl: snap.redirectUrl },
        });
        return { snapToken: snap.token, redirectUrl: snap.redirectUrl, orderId: order.orderId };
      } catch (err) {
        await prisma.order.update({ where: { id: order.id }, data: { status: "FAILED" } });
        throw err;
      }
    },
    { auth: true, beforeHandle: limit("checkout", 10, 60_000) },
  )
  .get(
    "/orders",
    async ({ user }) =>
      (
        await prisma.order.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: "desc" },
          take: 100,
        })
      ).map(orderView),
    { auth: true },
  )
  .get(
    "/orders/:orderId",
    async ({ user, params }) => {
      const order = await prisma.order.findUnique({ where: { orderId: params.orderId } });
      // Someone else's order looks exactly like a missing one.
      if (!order || order.userId !== user.id) {
        throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
      }
      return orderView(order);
    },
    {
      auth: true,
      params: t.Object({ orderId: t.String({ pattern: "^[A-Z0-9-]+$", maxLength: 50 }) }),
    },
  )
  .post(
    "/orders/:orderId/sync",
    async ({ user, params }) => {
      const order = await prisma.order.findUnique({ where: { orderId: params.orderId } });
      if (!order || order.userId !== user.id) {
        throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
      }
      // The result page asks Midtrans directly instead of waiting for the webhook (which can lag, and
      // needs a tunnel locally). Same confirmed-status path as the webhook, so it stays idempotent.
      if (order.status !== "PAID" && order.status !== "REFUNDED") {
        const status = await getTransactionStatus(order.orderId).catch((err) => {
          console.warn(`[midtrans] sync ${order.orderId}: ${(err as Error).message}`);
          return null; // Midtrans unreachable, or no transaction yet: report what we have
        });
        if (status) {
          const { result } = await applyStatus(order.orderId, status);
          if (result === "paid") void sendReceipt(order.orderId);
        }
      }
      return orderView(await prisma.order.findUniqueOrThrow({ where: { id: order.id } }));
    },
    {
      auth: true,
      params: t.Object({ orderId: t.String({ pattern: "^[A-Z0-9-]+$", maxLength: 50 }) }),
      beforeHandle: limit("order-sync", 30, 60_000),
    },
  )
  .post(
    "/midtrans/notification",
    async ({ body }) => {
      if (!verifySignature(body, serverKey())) {
        console.warn(`[midtrans] bad signature for notification ${body.order_id}`);
        throw new ApiError(401, "INVALID_SIGNATURE", "Signature does not match");
      }
      // The notification only tells us *that* something changed; Get Status is the source of truth.
      // If Midtrans is unreachable this throws -> 500 -> Midtrans retries the notification.
      const status = await getTransactionStatus(body.order_id);
      const { result } = await applyStatus(body.order_id, status);
      console.info(`[midtrans] ${body.order_id}: ${status.transaction_status} -> ${result}`);
      // Only the call that flipped the order to PAID sends the receipt; not awaited so Midtrans gets 200 fast.
      if (result === "paid") void sendReceipt(body.order_id);
      return { ok: true };
    },
    {
      beforeHandle: limit("midtrans-webhook", 120, 60_000),
      body: t.Object({
        order_id: t.String({ maxLength: 50 }),
        status_code: t.String({ maxLength: 3 }),
        gross_amount: t.String({ maxLength: 20 }),
        signature_key: t.String({ maxLength: 128 }),
      }),
    },
  );
