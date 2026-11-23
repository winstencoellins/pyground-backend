import { Elysia } from "elysia";
import { auth } from "./lib/auth";
import { errorBody, errorHandler } from "./lib/errors";
import { prisma } from "./lib/prisma";
import { limit } from "./lib/rate-limit";
import { sessionPlugin } from "./plugins/session";

/** Better Auth replies { code, message } on errors; rewrap into our { error: { code, message } }. */
async function authHandler(request: Request) {
  const res = await auth.handler(request);
  if (res.ok || !res.headers.get("content-type")?.includes("application/json")) return res;
  const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return Response.json(errorBody(body.code ?? "AUTH_ERROR", body.message ?? res.statusText), {
    status: res.status,
    headers,
  });
}

// All routes live here; `App` is their type, so the error handler (added below) stays out of the
// Eden Treaty contract and errors land in Eden's `error`, not in every route's `data`.
const routes = new Elysia()
  .use(sessionPlugin)
  .get("/health", async ({ set }) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ok" };
    } catch {
      set.status = 503;
      return { status: "degraded", database: "unreachable" };
    }
  })
  .get("/api/auth/*", ({ request }) => authHandler(request), { parse: "none" })
  .post("/api/auth/*", ({ request }) => authHandler(request), {
    parse: "none",
    beforeHandle: limit("auth", 10, 60_000),
  })
  .get(
    "/api/me",
    ({ user }) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      accessUntil: user.accessUntil ?? null,
      locale: user.locale,
    }),
    { auth: true },
  );

export const app = new Elysia().use(errorHandler).use(routes);

/** Eden Treaty contract (published as @winstencoellins/pyground-api-types). */
export type App = typeof routes;
