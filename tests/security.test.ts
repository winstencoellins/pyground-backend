import { describe, expect, it } from "bun:test";
import { checkProductionConfig } from "../src/lib/config-check";
import { call } from "./helpers";

const good = {
  BETTER_AUTH_SECRET: "x".repeat(44),
  WEB_URL: "https://pyground.id",
  MIDTRANS_SERVER_KEY: "Mid-server-abc",
  MIDTRANS_IS_PRODUCTION: "true",
  TRUSTED_PROXY_HOPS: "2",
  RESEND_API_KEY: "re_x",
  EMAIL_FROM: "Pyground <noreply@pyground.id>",
};

describe("checkProductionConfig", () => {
  it("accepts a correct production config", () => {
    expect(checkProductionConfig(good)).toEqual({ errors: [], warnings: [] });
  });
  it("accepts sandbox keys in sandbox mode and a localhost WEB_URL (DEV)", () => {
    const dev = {
      ...good,
      WEB_URL: "http://localhost:3000",
      MIDTRANS_SERVER_KEY: "SB-Mid-server-x",
      MIDTRANS_IS_PRODUCTION: "false",
    };
    expect(checkProductionConfig(dev).errors).toEqual([]);
  });
  it("refuses dangerous mismatches", () => {
    const errs = (env: Record<string, string | undefined>) =>
      checkProductionConfig({ ...good, ...env }).errors.join("\n");
    expect(errs({ MIDTRANS_SERVER_KEY: "SB-Mid-server-x" })).toContain("sandbox key");
    expect(errs({ MIDTRANS_IS_PRODUCTION: "false" })).toContain("production key");
    expect(errs({ BETTER_AUTH_SECRET: "short" })).toContain("BETTER_AUTH_SECRET");
    expect(errs({ BETTER_AUTH_SECRET: undefined })).toContain("BETTER_AUTH_SECRET");
    expect(errs({ WEB_URL: "http://pyground.id" })).toContain("https");
    expect(errs({ WEB_URL: "not a url" })).toContain("valid URL");
    expect(errs({ TRUSTED_PROXY_HOPS: "0" })).toContain("TRUSTED_PROXY_HOPS");
  });
  it("only warns about missing email/payment keys (deployable before the domain exists)", () => {
    const { errors, warnings } = checkProductionConfig({
      ...good,
      RESEND_API_KEY: "",
      EMAIL_FROM: "",
      MIDTRANS_SERVER_KEY: "",
    });
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(3);
  });
});

describe("security headers", () => {
  it("every response (200, 403, 404, auth) carries them", async () => {
    for (const res of [
      await call("/health"),
      await call("/api/lessons/for-loops"),
      await call("/api/nope"),
      await call("/api/auth/get-session"),
    ]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(res.headers.get("cache-control")).toContain("no-store"); // Better Auth sets its own "no-store"
    }
  });
});

describe("real server process", () => {
  const start = (env: Record<string, string>) => {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const proc = Bun.spawn(["bun", "src/index.ts"], {
      env: { ...process.env, PORT: String(port), ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { port, proc };
  };
  const waitUp = async (port: number) => {
    for (let i = 0; i < 50; i++) {
      if (
        await fetch(`http://localhost:${port}/health`).then(
          () => true,
          () => false,
        )
      )
        return;
      await Bun.sleep(100);
    }
    throw new Error("server did not start");
  };

  it("rejects bodies over 1 MB with 413 before reading them", async () => {
    const { port, proc } = start({});
    try {
      await waitUp(port);
      const res = await fetch(`http://localhost:${port}/api/payments/midtrans/notification`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "a".repeat(2 * 1024 * 1024),
      }).catch(() => undefined);
      expect(res === undefined || res.status === 413).toBe(true); // Bun may also just close the connection
    } finally {
      proc.kill();
    }
  });

  it("refuses to boot in production with a sandbox key and MIDTRANS_IS_PRODUCTION=true", async () => {
    const { proc } = start({
      ...good,
      NODE_ENV: "production",
      MIDTRANS_SERVER_KEY: "SB-Mid-server-x",
    });
    expect(await proc.exited).toBe(1);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("sandbox key");
    expect(stderr).not.toContain("SB-Mid-server-x");
  });

  it("shuts down cleanly on SIGTERM (exit 0, fast)", async () => {
    const { port, proc } = start({});
    await waitUp(port);
    const t0 = Date.now();
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(await new Response(proc.stdout).text()).toContain("[shutdown] SIGTERM");
  });

  it("boots in production with a correct config", async () => {
    const { port, proc } = start({ ...good, NODE_ENV: "production" });
    try {
      await waitUp(port);
      expect((await fetch(`http://localhost:${port}/health`)).status).toBe(200);
    } finally {
      proc.kill();
    }
  });
});
