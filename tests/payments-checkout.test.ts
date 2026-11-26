import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { prisma } from "../src/lib/prisma";
import { call, cleanupUsers, createUser, type ErrorBody } from "./helpers";

const realFetch = globalThis.fetch;
const env = { ...process.env };
let alice: { id: string; cookie: string; email: string };
let bob: { id: string; cookie: string };
const sent: { url: string; init: RequestInit }[] = [];

/**
 * Only Midtrans calls are faked; everything else goes to the real fetch. Snap gets `body`; Get Status gets
 * `statusBody` (default: like the real API for a Snap page where no payment method was chosen).
 */
function fakeMidtrans(
  status: number,
  body: unknown,
  statusBody: unknown = { status_code: "404", status_message: "Transaction doesn't exist." },
) {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("midtrans.com")) return realFetch(input, init);
    sent.push({ url, init: init ?? {} });
    return url.endsWith("/status") ? Response.json(statusBody) : Response.json(body, { status });
  }) as unknown as typeof fetch;
}
const snapCalls = () => sent.filter((s) => s.url.includes("/snap/"));

beforeAll(async () => {
  spyOn(console, "info").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  Object.assign(process.env, {
    MIDTRANS_SERVER_KEY: "SB-Mid-server-TEST",
    MIDTRANS_IS_PRODUCTION: "false",
    ACCESS_PASS_PRICE_IDR: "49000",
  });
  [alice, bob] = await Promise.all([createUser(), createUser()]);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  sent.length = 0;
});
afterAll(async () => {
  process.env = env;
  await cleanupUsers();
});

describe("GET /api/payments/pass", () => {
  it("is public and returns the configured price", async () => {
    process.env.ACCESS_PASS_PRICE_IDR = "59000";
    const res = await call("/api/payments/pass");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "access-pass-30d",
      days: 30,
      price: 59000,
      currency: "IDR",
    });
    process.env.ACCESS_PASS_PRICE_IDR = "49000";
  });
});

const checkout = (cookie?: string) =>
  call("/api/payments/checkout", { method: "POST", headers: cookie ? { cookie } : {} });

describe("POST /api/payments/checkout", () => {
  it("creates a PENDING order and returns the Snap token", async () => {
    fakeMidtrans(201, {
      token: "snap-token-123",
      redirect_url: "https://app.sandbox.midtrans.com/x",
    });
    const res = await checkout(alice.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapToken: string; redirectUrl: string; orderId: string };
    expect(body.snapToken).toBe("snap-token-123");
    expect(body.redirectUrl).toBe("https://app.sandbox.midtrans.com/x");
    expect(body.orderId).toMatch(/^PYG-[A-Z0-9]+-[A-Z0-9]{8}$/);

    const order = await prisma.order.findUniqueOrThrow({ where: { orderId: body.orderId } });
    expect(order).toMatchObject({ userId: alice.id, amount: 49000, status: "PENDING" });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://app.sandbox.midtrans.com/snap/v1/transactions");
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa("SB-Mid-server-TEST:")}`);
    const payload = JSON.parse(String(sent[0]!.init.body));
    expect(payload.transaction_details).toEqual({ order_id: body.orderId, gross_amount: 49000 });
    expect(payload.item_details[0]).toMatchObject({ price: 49000, quantity: 1 });
    expect(payload.customer_details.email).toBe(alice.email);
    expect(payload.enabled_payments).toEqual(
      expect.arrayContaining(["other_qris", "gopay", "shopeepay", "bca_va", "credit_card"]),
    );
    expect(payload.expiry).toEqual({ unit: "hours", duration: 24 });
    expect(payload.callbacks.finish).toBe(
      `${process.env.WEB_URL}/payment/result?orderId=${body.orderId}`,
    );
  });

  it("uses the production endpoint when MIDTRANS_IS_PRODUCTION=true", async () => {
    process.env.MIDTRANS_IS_PRODUCTION = "true";
    fakeMidtrans(201, { token: "t", redirect_url: "https://app.midtrans.com/x" });
    await checkout((await createUser()).cookie); // a user with no open order, so a new Snap is created
    expect(sent[0]!.url).toBe("https://app.midtrans.com/snap/v1/transactions");
    process.env.MIDTRANS_IS_PRODUCTION = "false";
  });

  it("Midtrans error -> 502 PAYMENT_PROVIDER_ERROR, order marked FAILED, no details leaked", async () => {
    fakeMidtrans(401, { error_messages: ["Access denied due to unauthorized transaction"] });
    const before = await prisma.order.count({ where: { userId: bob.id } });
    const res = await checkout(bob.cookie);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect((JSON.parse(text) as ErrorBody).error.code).toBe("PAYMENT_PROVIDER_ERROR");
    expect(text).not.toContain("unauthorized");
    const orders = await prisma.order.findMany({ where: { userId: bob.id } });
    expect(orders).toHaveLength(before + 1);
    expect(orders.at(-1)!.status).toBe("FAILED");
  });

  it("no server key -> 503 PAYMENTS_UNAVAILABLE", async () => {
    delete process.env.MIDTRANS_SERVER_KEY;
    const res = await checkout(bob.cookie);
    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorBody).error.code).toBe("PAYMENTS_UNAVAILABLE");
    process.env.MIDTRANS_SERVER_KEY = "SB-Mid-server-TEST";
  });

  it("requires a session", async () => {
    expect((await checkout()).status).toBe(401);
  });

  it("network failure talking to Midtrans -> 502, order FAILED", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("midtrans.com")) throw new TypeError("fetch failed");
      return realFetch(input, init);
    }) as unknown as typeof fetch;
    const res = await checkout(bob.cookie);
    expect(res.status).toBe(502);
    const latest = await prisma.order.findFirstOrThrow({
      where: { userId: bob.id },
      orderBy: { createdAt: "desc" },
    });
    expect(latest.status).toBe("FAILED");
  });

  it("invalid ACCESS_PASS_PRICE_IDR -> no order, nothing sent to Midtrans", async () => {
    fakeMidtrans(201, { token: "t", redirect_url: "x" });
    const before = await prisma.order.count({ where: { userId: bob.id } });
    for (const price of ["49.000", "abc", "500"]) {
      process.env.ACCESS_PASS_PRICE_IDR = price;
      expect((await checkout(bob.cookie)).status).toBe(500);
    }
    process.env.ACCESS_PASS_PRICE_IDR = "49000";
    expect(await prisma.order.count({ where: { userId: bob.id } })).toBe(before);
    expect(sent).toHaveLength(0);
  });
});

describe("orders", () => {
  it("GET /orders lists only my orders, newest first", async () => {
    const res = await call("/api/payments/orders", { headers: { cookie: alice.cookie } });
    const orders = (await res.json()) as { orderId: string; createdAt: string; amount: number }[];
    const mine = await prisma.order.findMany({ where: { userId: alice.id } });
    expect(orders.map((o) => o.orderId).sort()).toEqual(mine.map((o) => o.orderId).sort());
    expect([...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt))).toEqual(orders);
    expect(Object.keys(orders[0]!).sort()).toEqual([
      "amount",
      "createdAt",
      "orderId",
      "paidAt",
      "payUntil",
      "paymentType",
      "paymentUrl",
      "status",
    ]);
  });

  it("GET /orders/:orderId returns my order; someone else's is 404", async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { userId: alice.id } });
    const mine = await call(`/api/payments/orders/${order.orderId}`, {
      headers: { cookie: alice.cookie },
    });
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ orderId: order.orderId, status: order.status });

    const theirs = await call(`/api/payments/orders/${order.orderId}`, {
      headers: { cookie: bob.cookie },
    });
    expect(theirs.status).toBe(404);
    expect(((await theirs.json()) as ErrorBody).error.code).toBe("ORDER_NOT_FOUND");
  });
});

describe("continuing an unfinished payment", () => {
  const snap = {
    token: "snap-1",
    redirect_url: "https://app.sandbox.midtrans.com/snap/v4/redirection/abc",
  };
  type Order = { orderId: string; status: string; paymentUrl: string | null; payUntil: string };
  const order = async (cookie: string, orderId: string) =>
    (await (
      await call(`/api/payments/orders/${orderId}`, { headers: { cookie } })
    ).json()) as Order;

  it("a pending order exposes its Snap page and deadline; Buy again resumes it", async () => {
    const u = await createUser();
    fakeMidtrans(201, snap);
    const first = (await (await checkout(u.cookie)).json()) as {
      orderId: string;
      redirectUrl: string;
    };
    const o = await order(u.cookie, first.orderId);
    expect(o.paymentUrl).toBe(snap.redirect_url);
    const left = new Date(o.payUntil).getTime() - Date.now();
    expect(left).toBeGreaterThan(23.9 * 3_600_000);
    expect(left).toBeLessThanOrEqual(24 * 3_600_000);

    sent.length = 0;
    const again = (await (await checkout(u.cookie)).json()) as {
      orderId: string;
      redirectUrl: string;
    };
    expect(again).toMatchObject({
      orderId: first.orderId,
      redirectUrl: snap.redirect_url,
      snapToken: "snap-1",
    });
    expect(snapCalls()).toHaveLength(0); // no new Snap transaction
    expect(await prisma.order.count({ where: { userId: u.id } })).toBe(1);
  });

  it("a payment method already chosen (pending at Midtrans) is resumed too", async () => {
    const u = await createUser();
    fakeMidtrans(201, snap);
    const first = (await (await checkout(u.cookie)).json()) as { orderId: string };
    fakeMidtrans(201, snap, { transaction_status: "pending", gross_amount: "49000.00" });
    expect(((await (await checkout(u.cookie)).json()) as { orderId: string }).orderId).toBe(
      first.orderId,
    );
  });

  it("an order Midtrans has meanwhile expired is closed and a new one is made", async () => {
    const u = await createUser();
    fakeMidtrans(201, snap);
    const first = (await (await checkout(u.cookie)).json()) as { orderId: string };
    fakeMidtrans(
      201,
      { ...snap, token: "snap-2" },
      { transaction_status: "expire", gross_amount: "49000.00" },
    );
    const second = (await (await checkout(u.cookie)).json()) as {
      orderId: string;
      snapToken: string;
    };
    expect(second.orderId).not.toBe(first.orderId);
    expect(second.snapToken).toBe("snap-2");
    const old = await order(u.cookie, first.orderId);
    expect(old.status).toBe("EXPIRED");
    expect(old.paymentUrl).toBeNull();
  });

  it("not resumed when under an hour is left, the price changed, or Midtrans can't confirm", async () => {
    const u = await createUser();
    fakeMidtrans(201, snap);
    const first = (await (await checkout(u.cookie)).json()) as { orderId: string };

    process.env.ACCESS_PASS_PRICE_IDR = "59000";
    const pricier = (await (await checkout(u.cookie)).json()) as { orderId: string };
    expect(pricier.orderId).not.toBe(first.orderId);
    process.env.ACCESS_PASS_PRICE_IDR = "49000";
    await prisma.order.update({ where: { orderId: pricier.orderId }, data: { status: "FAILED" } });

    await prisma.order.update({
      where: { orderId: first.orderId },
      data: { createdAt: new Date(Date.now() - 23.5 * 3_600_000) },
    });
    const late = (await (await checkout(u.cookie)).json()) as { orderId: string };
    expect(late.orderId).not.toBe(first.orderId);
    expect((await order(u.cookie, first.orderId)).paymentUrl).toBe(snap.redirect_url); // still payable

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/status")) return new Response("down", { status: 503 });
      if (url.includes("midtrans.com"))
        return Response.json({ ...snap, token: "snap-3" }, { status: 201 });
      return realFetch(input, init);
    }) as unknown as typeof fetch;
    const unconfirmed = (await (await checkout(u.cookie)).json()) as { orderId: string };
    expect(unconfirmed.orderId).not.toBe(late.orderId);
  });
});
