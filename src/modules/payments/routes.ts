import { Elysia, t } from "elysia";
import { ApiError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { limit } from "../../lib/rate-limit";
import { sessionPlugin } from "../../plugins/session";
import { applyStatus, sendReceipt, verifySignature } from "./fulfill";
import { createSnapTransaction, getTransactionStatus, serverKey } from "./midtrans";
import { accessPass } from "./products";

const orderView = (o: {
  orderId: string;
  amount: number;
  status: string;
  paymentType: string | null;
  createdAt: Date;
  paidAt: Date | null;
}) => ({
  orderId: o.orderId,
  amount: o.amount,
  status: o.status as "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "REFUNDED",
  paymentType: o.paymentType,
  createdAt: o.createdAt,
  paidAt: o.paidAt,
});

// PYG-<base36 time>-<random>: unique, sortable, well under Midtrans' 50-char order_id limit.
const newOrderId = () =>
  `PYG-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

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
        return { snapToken: snap.token, orderId: order.orderId };
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
