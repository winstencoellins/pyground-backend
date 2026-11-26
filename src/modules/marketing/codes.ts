import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { jakartaDayNumber, jakartaDayStart } from "../../lib/jakarta";

// Daily-rotating marketer codes: HANDLE-XXXXX. XXXXX = HMAC(marketer's secret, Jakarta day number), so
// there is nothing to generate or store per day; replacing a marketer's secret revokes all their codes.

/** No I or O (read as 1 and 0); 32 symbols, so each 5-bit chunk maps to exactly one, without bias. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SUFFIX = 5; // 32^5 = 33.5 million per day, behind a rate limit
/** Yesterday's code still works until 06:00 WIB, so a code shared late in the evening isn't wasted. */
const GRACE_MS = 6 * 3_600_000;
/** How far back an old code is still recognised, to tell the buyer it expired rather than "invalid". */
const EXPIRED_LOOKBACK_DAYS = 30;

export const HANDLE_RE = /^[A-Z0-9]{3,12}$/;

export const newCodeSecret = () => randomBytes(32).toString("base64url");

export function suffixFor(secret: string, day: number): string {
  const mac = createHmac("sha256", secret).update(`pyground-marketer-code:${day}`).digest();
  let out = "";
  for (let i = 0; i < SUFFIX; i++) out += ALPHABET[mac[i]! & 31];
  return out;
}

export const codeFor = (m: { handle: string; codeSecret: string }, day: number) =>
  `${m.handle}-${suffixFor(m.codeSecret, day)}`;

/** Today's code, plus when it stops being today's (the next 00:00 WIB). */
export function todaysCode(m: { handle: string; codeSecret: string }, now = new Date()) {
  const day = jakartaDayNumber(now);
  return { code: codeFor(m, day), rotatesAt: jakartaDayStart(day + 1) };
}

/** "rina-7k3qx", " RINA 7K3QX ", "RINA7K3QX" -> { handle: "RINA", suffix: "7K3QX" }; null if it can't be a code. */
export function parseCode(input: string): { handle: string; suffix: string } | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  if (compact.length < 3 + SUFFIX || compact.length > 12 + SUFFIX) return null;
  const handle = compact.slice(0, -SUFFIX);
  const suffix = compact.slice(-SUFFIX);
  if (!HANDLE_RE.test(handle) || ![...suffix].every((c) => ALPHABET.includes(c))) return null;
  return { handle, suffix };
}

const same = (a: string, b: string) => timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Whether `suffix` is this marketer's code right now: today's, or yesterday's before 06:00 WIB.
 * "expired" when it is one of their codes from the last 30 days, so the buyer can be told so.
 */
export function checkSuffix(
  m: { codeSecret: string },
  suffix: string,
  now = new Date(),
): "valid" | "expired" | "invalid" {
  const today = jakartaDayNumber(now);
  const inGrace = now.getTime() - jakartaDayStart(today).getTime() < GRACE_MS;
  if (same(suffix, suffixFor(m.codeSecret, today))) return "valid";
  if (same(suffix, suffixFor(m.codeSecret, today - 1))) return inGrace ? "valid" : "expired";
  for (let d = 2; d <= EXPIRED_LOOKBACK_DAYS; d++) {
    if (same(suffix, suffixFor(m.codeSecret, today - d))) return "expired";
  }
  return "invalid";
}
