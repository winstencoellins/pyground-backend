import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { prisma } from "../src/lib/prisma";
import { call, cleanupUsers, createUser, type ErrorBody } from "./helpers";

const DAY = 86_400_000;
let admin: { id: string; cookie: string };
let student: { id: string; cookie: string; email: string };
const tag = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  spyOn(console, "info").mockImplementation(() => {});
  [admin, student] = await Promise.all([createUser({ role: "ADMIN" }), createUser()]);
  await prisma.user.update({ where: { id: student.id }, data: { name: `Siti ${tag}` } });
  await prisma.order.createMany({
    data: [
      {
        userId: student.id,
        orderId: `PYG-ADM-${tag}-1`.toUpperCase(),
        amount: 49000,
        status: "PAID",
        paidAt: new Date(),
      },
      {
        userId: student.id,
        orderId: `PYG-ADM-${tag}-2`.toUpperCase(),
        amount: 49000,
        status: "EXPIRED",
      },
    ],
  });
});
afterAll(cleanupUsers);

const asAdmin = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  call(path, { ...init, headers: { cookie: admin.cookie, ...init.headers } });
const access = (userId: string, json: unknown, cookie = admin.cookie) =>
  call(`/api/admin/users/${userId}/access`, { method: "POST", json, headers: { cookie } });

describe("admin guard on every admin route", () => {
  const routes: [string, RequestInit & { json?: unknown }][] = [
    ["/api/admin/users", {}],
    ["/api/admin/orders", {}],
    ["/api/admin/users/x/access", { method: "POST", json: { action: "revoke", reason: "test" } }],
  ];
  it("anonymous -> 401, student -> 403", async () => {
    for (const [path, init] of routes) {
      expect((await call(path, init)).status).toBe(401);
      const res = await call(path, { ...init, headers: { cookie: student.cookie } });
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorBody).error.code).toBe("FORBIDDEN");
    }
  });
});

describe("GET /api/admin/users", () => {
  type Users = {
    users: { id: string; email: string; hasAccess: boolean; locale: string }[];
    total: number;
    page: number;
    limit: number;
  };

  it("searches by name or email (case-insensitive) and returns safe fields only", async () => {
    const body = (await (await asAdmin(`/api/admin/users?q=SITI%20${tag}`)).json()) as Users;
    expect(body.total).toBe(1);
    expect(body.users[0]).toMatchObject({
      id: student.id,
      email: student.email,
      hasAccess: false,
      locale: "id",
    });
    expect(Object.keys(body.users[0]!).sort()).toEqual([
      "accessUntil",
      "createdAt",
      "email",
      "emailVerified",
      "hasAccess",
      "id",
      "locale",
      "name",
      "role",
    ]);
    const byEmail = (await (
      await asAdmin(`/api/admin/users?q=${student.email.slice(0, 20)}`)
    ).json()) as Users;
    expect(byEmail.users.map((u) => u.id)).toContain(student.id);
  });

  it("paginates (query numbers coerced from strings), newest first", async () => {
    const p1 = (await (await asAdmin("/api/admin/users?limit=1&page=1")).json()) as Users;
    const p2 = (await (await asAdmin("/api/admin/users?limit=1&page=2")).json()) as Users;
    expect([p1.users.length, p1.limit, p2.page]).toEqual([1, 1, 2]);
    expect(p1.users[0]!.id).not.toBe(p2.users[0]!.id);
    expect((await asAdmin("/api/admin/users?limit=500")).status).toBe(400);
    expect((await asAdmin("/api/admin/users?page=0")).status).toBe(400);
  });
});

describe("GET /api/admin/orders", () => {
  type Orders = {
    orders: {
      orderId: string;
      status: string;
      user: { id: string; email: string; name: string };
    }[];
    total: number;
  };

  it("filters by status and searches by order id or user email", async () => {
    const paid = (await (await asAdmin(`/api/admin/orders?status=PAID&q=${tag}`)).json()) as Orders;
    expect(paid.orders.map((o) => o.status)).toEqual(["PAID"]);
    expect(paid.orders[0]!.user).toEqual({
      id: student.id,
      email: student.email,
      name: `Siti ${tag}`,
    });
    const all = (await (await asAdmin(`/api/admin/orders?q=${student.email}`)).json()) as Orders;
    expect(all.total).toBe(2);
    expect((await asAdmin("/api/admin/orders?status=WHATEVER")).status).toBe(400);
  });
});

describe("POST /api/admin/users/:id/access", () => {
  const accessOf = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).accessUntil;

  it("grant on a user without access -> now + days, logged with admin and reason", async () => {
    const res = await access(student.id, { action: "grant", days: 7, reason: "Beta tester" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: student.id, hasAccess: true });
    expect(Math.abs((await accessOf(student.id))!.getTime() - (Date.now() + 7 * DAY))).toBeLessThan(
      5_000,
    );
    const grant = await prisma.accessGrant.findFirstOrThrow({
      where: { userId: student.id },
      orderBy: { createdAt: "desc" },
    });
    expect(grant).toMatchObject({ grantedById: admin.id, days: 7, reason: "Beta tester" });
  });

  it("grant stacks on an active pass", async () => {
    const before = (await accessOf(student.id))!.getTime();
    await access(student.id, { action: "grant", days: 3, reason: "Compensation for downtime" });
    expect(Math.abs((await accessOf(student.id))!.getTime() - (before + 3 * DAY))).toBeLessThan(
      5_000,
    );
  });

  it("revoke ends access now and logs the remaining days as negative", async () => {
    const res = await access(student.id, {
      action: "revoke",
      reason: "Refunded via bank transfer",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hasAccess: false, accessUntil: null });
    const grant = await prisma.accessGrant.findFirstOrThrow({
      where: { userId: student.id },
      orderBy: { createdAt: "desc" },
    });
    expect(grant.days).toBe(-10);
    expect(
      (await call("/api/lessons/for-loops", { headers: { cookie: student.cookie } })).status,
    ).toBe(403);
  });

  it("revoke without an active pass logs 0 days", async () => {
    await access(student.id, { action: "revoke", reason: "Double check" });
    const grant = await prisma.accessGrant.findFirstOrThrow({
      where: { userId: student.id },
      orderBy: { createdAt: "desc" },
    });
    expect(grant.days).toBe(0);
  });

  it("validates input and target", async () => {
    for (const json of [
      { action: "grant", days: 0, reason: "zero" },
      { action: "grant", days: 366, reason: "too long" },
      { action: "grant", days: 5 },
      { action: "grant", days: 5, reason: "x" },
      { action: "extend", days: 5, reason: "unknown action" },
    ]) {
      expect((await access(student.id, json)).status).toBe(400);
    }
    const missing = await access("no-such-user", { action: "grant", days: 1, reason: "nobody" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ErrorBody).error.code).toBe("USER_NOT_FOUND");
  });
});
