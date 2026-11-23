import type { Context } from "elysia";
import { ApiError } from "./errors";

// shortcut: in-memory, per process. Fine for one Railway replica; move to Redis/Postgres before scaling out.
const hits = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
}, 60_000).unref();

/**
 * Client IP from X-Forwarded-For. Each proxy appends the address it received the request from, so we
 * count TRUSTED_PROXY_HOPS entries from the right (1 = Railway's edge only; 2 = pyground-web forwards
 * X-Forwarded-For, then Railway's edge). Entries further left are client-controlled and ignored.
 */
export function clientIp(request: Request, fallback = "unknown"): string {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
  const chain = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return chain[chain.length - hops] ?? chain[0] ?? fallback;
}

/** Fixed window. Returns 0 if allowed, otherwise seconds until the window resets. */
export function hit(key: string, max: number, windowMs: number): number {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return 0;
  }
  return ++entry.count > max ? Math.ceil((entry.resetAt - now) / 1000) : 0;
}

/** beforeHandle hook, e.g. `{ beforeHandle: limit("checkout", 10, 60_000) }`. Throws 429 RATE_LIMITED. */
export const limit =
  (bucket: string, max: number, windowMs: number) =>
  ({ request, server, set }: Pick<Context, "request" | "server" | "set">) => {
    const ip = clientIp(request, server?.requestIP(request)?.address);
    const retryAfter = hit(`${bucket}:${ip}`, max, windowMs);
    if (retryAfter) {
      set.headers["retry-after"] = String(retryAfter);
      throw new ApiError(429, "RATE_LIMITED", "Too many requests, try again later");
    }
  };
