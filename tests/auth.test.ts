import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { call as fresh, cleanupUsers, createUser } from "./helpers";

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
  await cleanupUsers();
});

describe("email + password auth", () => {
  const links: string[] = [];
  const info = spyOn(console, "info").mockImplementation((msg: string) => {
    if (msg.includes(email)) links.push(/https?:\/\/[^\s\])]*verify-email[^\s\])]*/.exec(msg)![0]);
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
      locale: "id",
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

describe("auth emails in production", () => {
  it("never logs verification links or tokens", async () => {
    const nodeEnv = process.env.NODE_ENV;
    const logged: string[] = [];
    const capture = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    const spies = [spyOn(console, "info"), spyOn(console, "warn"), spyOn(console, "log")].map((s) =>
      s.mockImplementation(capture),
    );
    process.env.NODE_ENV = "production";
    const prodEmail = `test-prod-${crypto.randomUUID()}@example.com`;
    try {
      const res = await call("/api/auth/sign-up/email", {
        method: "POST",
        json: { email: prodEmail, password, name: "Prod" },
      });
      expect(res.status).toBe(200);
    } finally {
      process.env.NODE_ENV = nodeEnv;
      spies.forEach((s) => s.mockRestore());
      await prisma.user.deleteMany({ where: { email: prodEmail } });
    }
    const all = logged.join("\n");
    expect(all).toContain("not sent");
    expect(all).not.toContain("token=");
    expect(all).not.toContain("http");
    expect(all).not.toContain(prodEmail);
  });
});

describe("profile: name and password", () => {
  const post = (path: string, cookie: string, json: unknown) =>
    fresh(`/api/auth/${path}`, { method: "POST", headers: { cookie }, json });

  it("update-user trims the name; empty or over 80 characters -> 400 INVALID_NAME", async () => {
    const u = await createUser();
    expect((await post("update-user", u.cookie, { name: "  Siti Rahma  " })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).name).toBe("Siti Rahma");
    for (const name of ["   ", "x".repeat(81)]) {
      const res = await post("update-user", u.cookie, { name });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).error.code).toBe("INVALID_NAME");
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).name).toBe("Siti Rahma");
  });

  it("update-user can't touch role, accessUntil or email", async () => {
    const u = await createUser();
    await post("update-user", u.cookie, {
      role: "ADMIN",
      accessUntil: new Date(2100, 0),
      email: "x@example.com",
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect([user.role, user.accessUntil, user.email]).toEqual(["STUDENT", null, u.email]);
  });

  it("sign-up with an over-long name -> 400 INVALID_NAME", async () => {
    const res = await fresh("/api/auth/sign-up/email", {
      method: "POST",
      json: {
        email: `test-long-${crypto.randomUUID()}@example.com`,
        password: "test-password-123",
        name: "y".repeat(81),
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe("INVALID_NAME");
  });

  it("change-password needs the current password; the new one works afterwards", async () => {
    const u = await createUser();
    const wrong = await post("change-password", u.cookie, {
      currentPassword: "not-my-password",
      newPassword: "brand-new-pass-1",
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as ErrorBody).error.code).toBe("INVALID_PASSWORD");
    const ok = await post("change-password", u.cookie, {
      currentPassword: "test-password-123",
      newPassword: "brand-new-pass-1",
      revokeOtherSessions: true,
    });
    expect(ok.status).toBe(200);
    const signIn = (password: string) =>
      fresh("/api/auth/sign-in/email", { method: "POST", json: { email: u.email, password } });
    expect((await signIn("test-password-123")).status).toBe(401);
    expect((await signIn("brand-new-pass-1")).status).toBe(200);
  });
});
