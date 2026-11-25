import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { outcomeOf, verifySignature } from "../src/modules/payments/fulfill";
import { call, cleanupUsers, createUser, type ErrorBody } from "./helpers";

const KEY = "SB-Mid-server-WEBHOOK-TEST";
const DAY = 86_400_000;
const realFetch = globalThis.fetch;
const env = { ...process.env };
/** What the fake Get Status API returns, per order_id. */
const statuses = new Map<string, Record<string, string>>();
let statusCalls = 0;

beforeAll(() => {
  spyOn(console, "info").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  Object.assign(process.env, { MIDTRANS_SERVER_KEY: KEY, ACCESS_PASS_PRICE_IDR: "49000" });
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = /api\.sandbox\.midtrans\.com\/v2\/([^/]+)\/status$/.exec(url);
    if (!m) return realFetch(input, init);
    statusCalls++;
    const s = statuses.get(decodeURIComponent(m[1]!));
    return s ? Response.json(s) : Response.json({ status_code: "404" }, { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  statuses.clear();
  statusCalls = 0;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  process.env = env;
  await cleanupUsers();
});

const sign = (orderId: string, statusCode: string, gross: string, key = KEY) =>
  createHash("sha512")
    .update(orderId + statusCode + gross + key)
    .digest("hex");

function notify(orderId: string, opts: { gross?: string; statusCode?: string; key?: string } = {}) {
  const gross = opts.gross ?? "49000.00";
  const statusCode = opts.statusCode ?? "200";
  return call("/api/payments/midtrans/notification", {
    method: "POST",
    json: {
      order_id: orderId,
      status_code: statusCode,
      gross_amount: gross,
      signature_key: sign(orderId, statusCode, gross, opts.key),
      transaction_status: "settlement", // ignored: Get Status is the source of truth
    },
  });
}

async function newOrder(accessUntil: Date | null = null) {
  const user = await createUser({ accessUntil });
  const orderId = `PYG-TEST-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  await prisma.order.create({ data: { userId: user.id, orderId, amount: 49000 } });
  return { userId: user.id, orderId };
}
const settled = (orderId: string, extra: Record<string, string> = {}) =>
  statuses.set(orderId, {
    order_id: orderId,
    transaction_status: "settlement",
    gross_amount: "49000.00",
    payment_type: "qris",
    transaction_id: "trx-1",
    ...extra,
  });
const accessOf = async (userId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).accessUntil!.getTime();
const statusOf = async (orderId: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { orderId } })).status;

describe("signature", () => {
  const n = { order_id: "PYG-1", status_code: "200", gross_amount: "49000.00" };
  it("accepts SHA512(order_id + status_code + gross_amount + server_key)", () => {
    expect(verifySignature({ ...n, signature_key: sign("PYG-1", "200", "49000.00") }, KEY)).toBe(
      true,
    );
  });
  it("rejects a wrong key, a tampered field, or garbage", () => {
    expect(
      verifySignature({ ...n, signature_key: sign("PYG-1", "200", "49000.00", "other") }, KEY),
    ).toBe(false);
    expect(
      verifySignature(
        { ...n, gross_amount: "1.00", signature_key: sign("PYG-1", "200", "49000.00") },
        KEY,
      ),
    ).toBe(false);
    expect(verifySignature({ ...n, signature_key: "not-hex" }, KEY)).toBe(false);
  });
  it("webhook with a bad signature -> 401 and no Get Status call", async () => {
    const { orderId } = await newOrder();
    const res = await notify(orderId, { key: "attacker-guess" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error.code).toBe("INVALID_SIGNATURE");
    expect(statusCalls).toBe(0);
    expect(await statusOf(orderId)).toBe("PENDING");
  });
});

describe("access extension: accessUntil = max(now, accessUntil) + 30 days", () => {
  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThan(5_000);

  it("no access yet -> now + 30 days", async () => {
    const { userId, orderId } = await newOrder(null);
    settled(orderId);
    expect((await notify(orderId)).status).toBe(200);
    near(await accessOf(userId), Date.now() + 30 * DAY);
    const order = await prisma.order.findUniqueOrThrow({ where: { orderId } });
    expect(order).toMatchObject({
      status: "PAID",
      paymentType: "qris",
      midtransTransactionId: "trx-1",
    });
    expect(order.paidAt).not.toBeNull();
    expect(order.rawNotification).toMatchObject({ transaction_status: "settlement" });
  });

  it("active pass -> stacks on top of the current expiry", async () => {
    const current = Date.now() + 10 * DAY;
    const { userId, orderId } = await newOrder(new Date(current));
    settled(orderId);
    await notify(orderId);
    near(await accessOf(userId), current + 30 * DAY);
  });

  it("expired pass -> starts from now, not from the old expiry", async () => {
    const { userId, orderId } = await newOrder(new Date(Date.now() - 5 * DAY));
    settled(orderId);
    await notify(orderId);
    near(await accessOf(userId), Date.now() + 30 * DAY);
  });

  it("two different orders paid at the same time both count (+60 days)", async () => {
    const { userId, orderId } = await newOrder(null);
    const second = `PYG-TEST-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    await prisma.order.create({ data: { userId, orderId: second, amount: 49000 } });
    settled(orderId);
    settled(second);
    await Promise.all([notify(orderId), notify(second)]);
    near(await accessOf(userId), Date.now() + 60 * DAY);
  });
});

describe("idempotency", () => {
  it("the same settlement delivered 5 times concurrently extends access once", async () => {
    const { userId, orderId } = await newOrder(null);
    settled(orderId);
    const results = await Promise.all(Array.from({ length: 5 }, () => notify(orderId)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(Math.abs((await accessOf(userId)) - (Date.now() + 30 * DAY))).toBeLessThan(5_000);
  });

  it("the receipt email is sent exactly once, in the user's language", async () => {
    const user = await createUser({ locale: "EN" });
    const orderId = `PYG-TEST-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    await prisma.order.create({ data: { userId: user.id, orderId, amount: 49000 } });
    settled(orderId);
    const info = console.info as unknown as { mock: { calls: unknown[][] } };
    const receipts = () =>
      info.mock.calls.filter((c) => String(c[0]).includes(`"Pyground payment receipt ${orderId}"`));
    await Promise.all(Array.from({ length: 5 }, () => notify(orderId)));
    await notify(orderId);
    for (let i = 0; i < 40 && receipts().length === 0; i++) await Bun.sleep(25); // sent after the 200
    await Bun.sleep(100);
    expect(receipts()).toHaveLength(1);
    expect(String(receipts()[0]![0])).toContain("Payments are processed by Trixync.");
  });

  it("a later retry after PAID changes nothing", async () => {
    const { userId, orderId } = await newOrder(null);
    settled(orderId);
    await notify(orderId);
    const first = await accessOf(userId);
    await notify(orderId);
    expect(await accessOf(userId)).toBe(first);
  });

  it("a stale pending/expire notification can't un-pay an order", async () => {
    const { orderId } = await newOrder(null);
    settled(orderId);
    await notify(orderId);
    for (const s of ["pending", "expire", "cancel"]) {
      statuses.set(orderId, { order_id: orderId, transaction_status: s, gross_amount: "49000.00" });
      await notify(orderId, { statusCode: "201" });
      expect(await statusOf(orderId)).toBe("PAID");
    }
  });
});

describe("status handling (always from Get Status, never from the notification body)", () => {
  it("maps every documented status", () => {
    expect(outcomeOf({ transaction_status: "settlement" })).toBe("PAID");
    expect(outcomeOf({ transaction_status: "capture", fraud_status: "accept" })).toBe("PAID");
    expect(outcomeOf({ transaction_status: "capture", fraud_status: "challenge" })).toBe("PENDING");
    expect(outcomeOf({ transaction_status: "capture", fraud_status: "deny" })).toBe("FAILED");
    expect(outcomeOf({ transaction_status: "pending" })).toBe("PENDING");
    expect(outcomeOf({ transaction_status: "deny" })).toBe("FAILED");
    expect(outcomeOf({ transaction_status: "cancel" })).toBe("FAILED");
    expect(outcomeOf({ transaction_status: "expire" })).toBe("EXPIRED");
    expect(outcomeOf({ transaction_status: "refund" })).toBe("REFUNDED");
    expect(outcomeOf({ transaction_status: "partial_refund" })).toBe("REFUNDED");
    expect(outcomeOf({ transaction_status: "authorize" })).toBe("IGNORE");
  });

  it("notification says settlement but Get Status says pending -> stays PENDING, no access", async () => {
    const { userId, orderId } = await newOrder(null);
    statuses.set(orderId, {
      order_id: orderId,
      transaction_status: "pending",
      gross_amount: "49000.00",
    });
    await notify(orderId);
    expect(await statusOf(orderId)).toBe("PENDING");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).accessUntil).toBeNull();
  });

  it("card capture with fraud challenge -> not paid", async () => {
    const { orderId } = await newOrder(null);
    settled(orderId, {
      transaction_status: "capture",
      fraud_status: "challenge",
      payment_type: "credit_card",
    });
    await notify(orderId);
    expect(await statusOf(orderId)).toBe("PENDING");
  });

  it("expire -> EXPIRED; deny -> FAILED; refund after PAID -> REFUNDED", async () => {
    const a = await newOrder(null);
    statuses.set(a.orderId, {
      order_id: a.orderId,
      transaction_status: "expire",
      gross_amount: "49000.00",
    });
    await notify(a.orderId, { statusCode: "407" });
    expect(await statusOf(a.orderId)).toBe("EXPIRED");

    const b = await newOrder(null);
    statuses.set(b.orderId, {
      order_id: b.orderId,
      transaction_status: "deny",
      gross_amount: "49000.00",
    });
    await notify(b.orderId, { statusCode: "202" });
    expect(await statusOf(b.orderId)).toBe("FAILED");

    const c = await newOrder(null);
    settled(c.orderId);
    await notify(c.orderId);
    statuses.set(c.orderId, {
      order_id: c.orderId,
      transaction_status: "refund",
      gross_amount: "49000.00",
    });
    await notify(c.orderId);
    expect(await statusOf(c.orderId)).toBe("REFUNDED");
  });

  it("a late settlement on an EXPIRED order still pays (the customer did pay)", async () => {
    const { userId, orderId } = await newOrder(null);
    await prisma.order.update({ where: { orderId }, data: { status: "EXPIRED" } });
    settled(orderId);
    await notify(orderId);
    expect(await statusOf(orderId)).toBe("PAID");
    expect(await accessOf(userId)).toBeGreaterThan(Date.now());
  });

  it("amount mismatch -> not paid", async () => {
    const { orderId } = await newOrder(null);
    settled(orderId, { gross_amount: "1000.00" });
    await notify(orderId, { gross: "1000.00" });
    expect(await statusOf(orderId)).toBe("PENDING");
  });

  it("unknown order with a valid signature -> 200 (Midtrans dashboard test), nothing created", async () => {
    statuses.set("PYG-NOT-OURS", {
      order_id: "PYG-NOT-OURS",
      transaction_status: "settlement",
      gross_amount: "49000.00",
    });
    expect((await notify("PYG-NOT-OURS")).status).toBe(200);
    expect(await prisma.order.findUnique({ where: { orderId: "PYG-NOT-OURS" } })).toBeNull();
  });

  it("Get Status unreachable -> 500 so Midtrans retries", async () => {
    const { orderId } = await newOrder(null); // no status registered -> fake API returns 404
    expect((await notify(orderId)).status).toBe(500);
    expect(await statusOf(orderId)).toBe("PENDING");
  });
});

describe("POST /api/payments/orders/:orderId/sync", () => {
  async function ownOrder() {
    const user = await createUser();
    const orderId = `PYG-TEST-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    await prisma.order.create({ data: { userId: user.id, orderId, amount: 49000 } });
    return { ...user, orderId };
  }
  const sync = (orderId: string, cookie?: string) =>
    call(`/api/payments/orders/${orderId}/sync`, {
      method: "POST",
      headers: cookie ? { cookie } : {},
    });

  it("asks Midtrans and pays the owner's order (no webhook needed), once", async () => {
    const o = await ownOrder();
    settled(o.orderId);
    const res = await sync(o.orderId, o.cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("PAID");
    const until = await accessOf(o.id);
    expect(until).toBeGreaterThan(Date.now() + 29 * DAY);
    await sync(o.orderId, o.cookie); // already PAID: no second extension, no Midtrans call
    expect(await accessOf(o.id)).toBe(until);
    expect(statusCalls).toBe(1);
  });

  it("no transaction yet / Midtrans down -> still PENDING, 200", async () => {
    const o = await ownOrder(); // fake Get Status answers 404 for unknown orders
    const res = await sync(o.orderId, o.cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("PENDING");
  });

  it("someone else's order looks missing; signed out is 401", async () => {
    const o = await ownOrder();
    const other = await createUser();
    settled(o.orderId);
    expect((await sync(o.orderId, other.cookie)).status).toBe(404);
    expect((await sync(o.orderId)).status).toBe(401);
    expect(await statusOf(o.orderId)).toBe("PENDING");
  });
});
