import { Elysia } from "elysia";
import { auth } from "../lib/auth";
import { ApiError } from "../lib/errors";

async function requireSession(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new ApiError(401, "UNAUTHORIZED", "Sign in required");
  return session;
}

/** Route options: `{ auth: true }` -> `user` + `session` in context (401), `{ admin: true }` -> also 403 unless ADMIN. */
export const sessionPlugin = new Elysia({ name: "session" }).macro({
  auth: {
    async resolve({ request }) {
      return requireSession(request.headers);
    },
  },
  admin: {
    async resolve({ request }) {
      const session = await requireSession(request.headers);
      if (session.user.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Admin only");
      return session;
    },
  },
});
