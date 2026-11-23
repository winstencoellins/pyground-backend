import { app } from "../src/app";
import { auth } from "../src/lib/auth";
import { prisma } from "../src/lib/prisma";

export type ErrorBody = { error: { code: string; message: string } };

/** In-process request with its own rate-limit bucket. */
export const call = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250)}`,
        origin: process.env.WEB_URL!,
        ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    }),
  );

/** Creates a verified user and returns its id plus a session cookie. Delete with cleanupUsers(). */
export async function createUser(
  data: { accessUntil?: Date | null; role?: "STUDENT" | "ADMIN"; locale?: "ID" | "EN" } = {},
) {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const password = "test-password-123";
  const { user } = await auth.api.signUpEmail({ body: { email, password, name: "Test" } });
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true, ...data } });
  const res = await call("/api/auth/sign-in/email", { method: "POST", json: { email, password } });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { id: user.id, email, cookie };
}

export const cleanupUsers = () =>
  prisma.user.deleteMany({ where: { email: { startsWith: "test-" } } });
