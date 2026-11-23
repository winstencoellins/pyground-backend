import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { prisma } from "../src/lib/prisma";
import { call, cleanupUsers, createUser, type ErrorBody } from "./helpers";

const logs: string[] = [];
let cookie: string;
let userId: string;

beforeAll(async () => {
  spyOn(console, "info").mockImplementation((msg: string) => void logs.push(msg));
  ({ cookie, id: userId } = await createUser());
});
afterAll(cleanupUsers);

const patch = (json: unknown, headers: Record<string, string> = { cookie }) =>
  call("/api/me", { method: "PATCH", json, headers });

describe("PATCH /api/me", () => {
  it("updates locale and returns the /api/me shape", async () => {
    const res = await patch({ locale: "en" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: userId, locale: "en", role: "STUDENT" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).locale).toBe("EN");
    const me = (await (await call("/api/me", { headers: { cookie } })).json()) as {
      locale: string;
    };
    expect(me.locale).toBe("en");
  });

  it("saved locale becomes the default for lessons (explicit ?locale still wins)", async () => {
    const idx = (await (await call("/api/lessons", { headers: { cookie } })).json()) as {
      locale: string;
    };
    expect(idx.locale).toBe("en");
    const forced = (await (
      await call("/api/lessons?locale=id", { headers: { cookie } })
    ).json()) as { locale: string };
    expect(forced.locale).toBe("id");
  });

  it("rejects unknown locales and extra fields like role", async () => {
    expect((await patch({ locale: "fr" })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    await patch({ locale: "id", role: "ADMIN" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).role).toBe("STUDENT");
  });

  it("requires a session", async () => {
    const res = await patch({ locale: "en" }, {});
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error.code).toBe("UNAUTHORIZED");
  });
});

describe("locale at sign-up and in auth emails", () => {
  const signUp = (email: string, locale?: string) =>
    call("/api/auth/sign-up/email", {
      method: "POST",
      json: { email, password: "test-password-123", name: "T", ...(locale ? { locale } : {}) },
    });

  it("English sign-up stores EN and sends the verification email in English", async () => {
    const email = `test-${crypto.randomUUID()}@example.com`;
    expect((await signUp(email, "en")).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).locale).toBe("EN");
    expect(logs.find((l) => l.includes(email))).toContain('(en) "Verify your Pyground email"');
  });

  it("no or unknown locale -> ID and an Indonesian email", async () => {
    for (const locale of [undefined, "fr"]) {
      const email = `test-${crypto.randomUUID()}@example.com`;
      expect((await signUp(email, locale)).status).toBe(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { email } })).locale).toBe("ID");
      expect(logs.find((l) => l.includes(email))).toContain('(id) "Verifikasi email Pyground-mu"');
    }
  });

  it("Better Auth's update-user normalizes locale and can't touch role or accessUntil", async () => {
    const res = await call("/api/auth/update-user", {
      method: "POST",
      headers: { cookie },
      json: { locale: "xx", role: "ADMIN", accessUntil: "2099-01-01" },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.locale).toBe("ID");
    expect(user.role).toBe("STUDENT");
    expect(user.accessUntil).toBeNull();
    expect(res.status).toBeLessThan(500);
  });
});
