import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { errorHandler } from "../src/lib/errors";
import { sessionPlugin } from "../src/plugins/session";
import { cleanupUsers, createUser, type ErrorBody } from "./helpers";

// A throwaway route using the real guard (the admin API in #29 uses the same macro).
const app = new Elysia()
  .use(errorHandler)
  .use(sessionPlugin)
  .get("/admin-only", ({ user }) => ({ id: user.id }), { admin: true });
const get = (cookie?: string) =>
  app.handle(new Request("http://localhost/admin-only", { headers: cookie ? { cookie } : {} }));

let student: string, admin: { id: string; cookie: string };
beforeAll(async () => {
  spyOn(console, "info").mockImplementation(() => {});
  [student, admin] = await Promise.all([
    createUser({ accessUntil: new Date(Date.now() + 86_400_000) }).then((u) => u.cookie),
    createUser({ role: "ADMIN" }),
  ]);
});
afterAll(cleanupUsers);

describe("{ admin: true }", () => {
  it("no session -> 401 UNAUTHORIZED", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error.code).toBe("UNAUTHORIZED");
  });
  it("STUDENT (even with a pass) -> 403 FORBIDDEN", async () => {
    const res = await get(student);
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe("FORBIDDEN");
  });
  it("ADMIN -> 200 with the user in context", async () => {
    const res = await get(admin.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: admin.id });
  });
});
