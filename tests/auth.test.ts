import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

type ErrorBody = { error: { code: string; message: string } };
const email = `test-auth-${crypto.randomUUID()}@example.com`;
const password = "correct-horse-battery";
const ip = `198.51.100.${Math.floor(Math.random() * 250)}`; // own rate-limit bucket

const call = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        "x-forwarded-for": ip,
        origin: process.env.WEB_URL!,
        ...(init.json ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.json ? JSON.stringify(init.json) : init.body,
    }),
  );

const sessionCookie = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email } });
});

describe("email + password auth", () => {
  const links: string[] = [];
  const info = spyOn(console, "info").mockImplementation((msg: string) => {
    if (msg.includes(email)) links.push(msg.slice(msg.indexOf("http")));
  });

  it("GET /api/me without a session -> 401 UNAUTHORIZED", async () => {
    const res = await call("/api/me");
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error.code).toBe("UNAUTHORIZED");
  });

  it("sign-up creates an unverified STUDENT and sends a verification link", async () => {
    const res = await call("/api/auth/sign-up/email", {
      method: "POST",
      json: { email, password, name: "Budi" },
    });
    expect(res.status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerified).toBe(false);
    expect(user.role).toBe("STUDENT");
    expect(links.length).toBe(1);
  });

  it("rejects short passwords in our error format", async () => {
    const res = await call("/api/auth/sign-up/email", {
      method: "POST",
      json: { email: `x-${email}`, password: "short", name: "X" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe("PASSWORD_TOO_SHORT");
  });

  it("sign-in before verification -> 403 EMAIL_NOT_VERIFIED", async () => {
    const res = await call("/api/auth/sign-in/email", {
      method: "POST",
      json: { email, password },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("verification link verifies the email and signs the user in", async () => {
    const res = await call(new URL(links[0]!).pathname + new URL(links[0]!).search);
    expect(res.status).toBeLessThan(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).emailVerified).toBe(true);
    expect(sessionCookie(res)).toContain("session_token");
  });

  it("sign-in -> session cookie -> GET /api/me", async () => {
    const signIn = await call("/api/auth/sign-in/email", {
      method: "POST",
      json: { email, password },
    });
    expect(signIn.status).toBe(200);
    const me = await call("/api/me", { headers: { cookie: sessionCookie(signIn) } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      email,
      name: "Budi",
      role: "STUDENT",
      locale: "ID",
      accessUntil: null,
    });
    expect(Object.keys(body).sort()).toEqual([
      "accessUntil",
      "email",
      "id",
      "locale",
      "name",
      "role",
    ]);
  });

  it("wrong password -> 401 in our error format", async () => {
    const res = await call("/api/auth/sign-in/email", {
      method: "POST",
      json: { email, password: "wrong-password-123" },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    info.mockRestore();
  });
});
