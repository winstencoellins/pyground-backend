import { describe, expect, it } from "bun:test";
import { Elysia, t } from "elysia";
import { app } from "../src/app";
import { ApiError, errorHandler } from "../src/lib/errors";
import { clientIp, limit } from "../src/lib/rate-limit";

type ErrorBody = { error: { code: string; message: string } };
const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

const testApp = new Elysia()
  .use(errorHandler)
  .post("/echo", ({ body }) => body, { body: t.Object({ name: t.String({ minLength: 1 }) }) })
  .get("/teapot", () => {
    throw new ApiError(418, "TEAPOT", "short and stout");
  })
  .get("/boom", () => {
    throw new Error("secret detail: DATABASE_URL=postgres://...");
  })
  .get("/limited", () => "ok", { beforeHandle: limit("test", 2, 60_000) });

describe("health", () => {
  it("returns ok when the database answers", async () => {
    const res = await app.handle(req("/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("error format", () => {
  it("unknown route -> 404 NOT_FOUND", async () => {
    const res = await app.handle(req("/api/nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  it("invalid body -> 400 VALIDATION_ERROR", async () => {
    const res = await testApp.handle(
      req("/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":""}',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("/name");
  });

  it("ApiError keeps its status and code", async () => {
    const res = await testApp.handle(req("/teapot"));
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: { code: "TEAPOT", message: "short and stout" } });
  });

  it("unexpected errors -> 500 without leaking the message", async () => {
    const res = await testApp.handle(req("/boom"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("DATABASE_URL");
    expect(JSON.parse(text).error.code).toBe("INTERNAL_ERROR");
  });
});

describe("rate limit", () => {
  it("allows max requests per window, then 429 with Retry-After", async () => {
    const h = { "x-forwarded-for": "203.0.113.7" };
    expect((await testApp.handle(req("/limited", { headers: h }))).status).toBe(200);
    expect((await testApp.handle(req("/limited", { headers: h }))).status).toBe(200);
    const res = await testApp.handle(req("/limited", { headers: h }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(((await res.json()) as ErrorBody).error.code).toBe("RATE_LIMITED");
    // a different client is unaffected
    const other = await testApp.handle(
      req("/limited", { headers: { "x-forwarded-for": "203.0.113.8" } }),
    );
    expect(other.status).toBe(200);
  });

  it("clientIp ignores spoofed left-most X-Forwarded-For entries", () => {
    const r = req("/", { headers: { "x-forwarded-for": "1.1.1.1, 9.9.9.9" } });
    expect(clientIp(r)).toBe("9.9.9.9");
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(clientIp(r)).toBe("1.1.1.1");
    delete process.env.TRUSTED_PROXY_HOPS;
  });
});
