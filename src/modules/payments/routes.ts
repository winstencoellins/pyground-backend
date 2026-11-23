import { Elysia, t } from "elysia";
import { ApiError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { limit } from "../../lib/rate-limit";
import { sessionPlugin } from "../../plugins/session";
import { createSnapTransaction } from "./midtrans";
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
  );
