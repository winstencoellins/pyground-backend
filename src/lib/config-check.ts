/**
 * Production startup check: refuse to boot with config that would be unsafe or silently broken.
 * Returns { errors, warnings }; src/index.ts exits on errors. Localhost WEB_URL is allowed for DEV.
 */
export function checkProductionConfig(env: Record<string, string | undefined> = process.env) {
  const errors: string[] = [];
  const warnings: string[] = [];

  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < 32)
    errors.push("BETTER_AUTH_SECRET must be at least 32 characters (openssl rand -base64 32)");

  let web: URL | undefined;
  try {
    web = new URL(env.WEB_URL ?? "");
  } catch {
    errors.push("WEB_URL must be a valid URL");
  }
  if (web && web.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(web.hostname)) {
    errors.push("WEB_URL must use https (secure cookies depend on it)");
  }

  const key = env.MIDTRANS_SERVER_KEY ?? "";
  const production = env.MIDTRANS_IS_PRODUCTION === "true";
  if (!key) warnings.push("MIDTRANS_SERVER_KEY is not set: checkout returns 503");
  else if (production && key.startsWith("SB-"))
    errors.push("MIDTRANS_IS_PRODUCTION=true but MIDTRANS_SERVER_KEY is a sandbox key");
  else if (!production && !key.startsWith("SB-"))
    errors.push("MIDTRANS_IS_PRODUCTION is not true but MIDTRANS_SERVER_KEY is a production key");

  const hops = Number(env.TRUSTED_PROXY_HOPS ?? 1);
  if (!Number.isInteger(hops) || hops < 1 || hops > 5)
    errors.push("TRUSTED_PROXY_HOPS must be an integer from 1 to 5");

  if (!env.RESEND_API_KEY)
    warnings.push("RESEND_API_KEY is not set: no emails are sent (users can't verify)");
  if (!env.EMAIL_FROM)
    warnings.push("EMAIL_FROM is not set: Resend only delivers to the account owner's address");

  return { errors, warnings };
}
