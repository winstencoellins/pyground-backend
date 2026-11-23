import { Elysia, t } from "elysia";
import { ApiError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { sessionPlugin } from "../../plugins/session";
import { hasAccess } from "../lessons/access";

const DAY = 86_400_000;

const page = {
  page: t.Optional(t.Integer({ minimum: 1, default: 1 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
  q: t.Optional(t.String({ maxLength: 100 })),
};
const skipTake = (q: { page?: number; limit?: number }) => {
  const limit = q.limit ?? 20;
  return { skip: ((q.page ?? 1) - 1) * limit, take: limit };
};

type U = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: "STUDENT" | "ADMIN";
  accessUntil: Date | null;
  locale: "ID" | "EN";
  createdAt: Date;
};
const userView = (u: U) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  emailVerified: u.emailVerified,
  role: u.role,
  accessUntil: u.accessUntil,
  hasAccess: hasAccess(u),
  locale: (u.locale === "EN" ? "en" : "id") as "id" | "en",
  createdAt: u.createdAt,
});

const ORDER_STATUSES = ["PENDING", "PAID", "FAILED", "EXPIRED", "REFUNDED"] as const;

export const adminRoutes = new Elysia({ prefix: "/api/admin" })
  .use(sessionPlugin)
  .get(
    "/users",
    async ({ query }) => {
      const where = query.q
        ? {
            OR: [
              { email: { contains: query.q, mode: "insensitive" as const } },
              { name: { contains: query.q, mode: "insensitive" as const } },
            ],
          }
        : {};
      const [users, total] = await Promise.all([
        prisma.user.findMany({ where, orderBy: { createdAt: "desc" }, ...skipTake(query) }),
        prisma.user.count({ where }),
      ]);
      return { users: users.map(userView), total, page: query.page ?? 1, limit: query.limit ?? 20 };
    },
    { admin: true, query: t.Object(page) },
  )
  .get(
    "/orders",
    async ({ query }) => {
      const where = {
        ...(query.status ? { status: query.status } : {}),
        ...(query.q
          ? {
              OR: [
                { orderId: { contains: query.q, mode: "insensitive" as const } },
                { user: { email: { contains: query.q, mode: "insensitive" as const } } },
              ],
            }
          : {}),
      };
      const [orders, total] = await Promise.all([
        prisma.order.findMany({
          where,
          orderBy: { createdAt: "desc" },
          include: { user: { select: { id: true, email: true, name: true } } },
          ...skipTake(query),
        }),
        prisma.order.count({ where }),
      ]);
      return {
        orders: orders.map((o) => ({
          orderId: o.orderId,
          amount: o.amount,
          status: o.status as (typeof ORDER_STATUSES)[number],
          paymentType: o.paymentType,
          midtransTransactionId: o.midtransTransactionId,
          createdAt: o.createdAt,
          paidAt: o.paidAt,
          user: o.user,
        })),
        total,
        page: query.page ?? 1,
        limit: query.limit ?? 20,
      };
    },
    {
      admin: true,
      query: t.Object({
        ...page,
        status: t.Optional(t.Union(ORDER_STATUSES.map((s) => t.Literal(s)))),
      }),
    },
  )
  .post(
    "/users/:id/access",
    async ({ user: admin, params, body }) => {
      const target = await prisma.user.findUnique({ where: { id: params.id } });
      if (!target) throw new ApiError(404, "USER_NOT_FOUND", "User not found");

      const updated = await prisma.$transaction(async (tx) => {
        let days: number;
        if (body.action === "grant") {
          days = body.days;
          // Same rule as a payment: accessUntil = max(now, accessUntil) + days, atomically.
          await tx.$executeRaw`
            UPDATE users
            SET access_until = GREATEST(COALESCE(access_until, now()), now()) + make_interval(days => ${days}),
                updated_at = now()
            WHERE id = ${target.id}`;
        } else {
          // Revoke ends access now; the grant log stores the remaining days as a negative number.
          const remainingMs = target.accessUntil ? target.accessUntil.getTime() - Date.now() : 0;
          days = -Math.max(0, Math.ceil(remainingMs / DAY));
          await tx.user.update({ where: { id: target.id }, data: { accessUntil: null } });
        }
        await tx.accessGrant.create({
          data: { userId: target.id, grantedById: admin.id, days, reason: body.reason },
        });
        return tx.user.findUniqueOrThrow({ where: { id: target.id } });
      });
      return userView(updated);
    },
    {
      admin: true,
      params: t.Object({ id: t.String({ maxLength: 64 }) }),
      body: t.Union([
        t.Object({
          action: t.Literal("grant"),
          days: t.Integer({ minimum: 1, maximum: 365 }),
          reason: t.String({ minLength: 3, maxLength: 500 }),
        }),
        t.Object({
          action: t.Literal("revoke"),
          reason: t.String({ minLength: 3, maxLength: 500 }),
        }),
      ]),
    },
  );
