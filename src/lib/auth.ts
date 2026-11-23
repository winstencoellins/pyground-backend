import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { emailLocale, SUBJECTS } from "../emails/i18n";
import { prisma } from "./prisma";

const webUrl = process.env.WEB_URL;
if (!webUrl) throw new Error("WEB_URL is not set");
const cookieDomain = process.env.COOKIE_DOMAIN; // e.g. ".pyground.id" once on a custom domain

// shortcut: links go to the console until Resend is wired (task #28). Never log tokens in production.
function deliver(
  kind: keyof typeof SUBJECTS,
  user: { email: string; locale?: unknown },
  url: string,
) {
  const locale = emailLocale(user);
  if (process.env.NODE_ENV === "production") {
    console.warn(`[auth] ${kind} email (${locale}) not sent: email delivery is not configured yet`);
    return;
  }
  console.info(`[auth] (${locale}) "${SUBJECTS[kind][locale]}" to ${user.email}: ${url}`);
}

/** Sign-up and update-user may send "id"/"en" (any case); store the enum, default ID. */
const normalizeLocale = (value: unknown) => (String(value).toUpperCase() === "EN" ? "EN" : "ID");

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  // The browser only talks to pyground-web, which proxies /api/* here, so links and cookies use WEB_URL.
  baseURL: webUrl,
  trustedOrigins: [webUrl],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => deliver("passwordReset", user, url),
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true, // unverified sign-in attempts get a fresh link
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => deliver("verification", user, url),
  },
  user: {
    // Exposed on the session user. role/accessUntil: input false, so clients can never set them.
    // locale: optional at sign-up so verification emails go out in the visitor's language.
    additionalFields: {
      role: { type: "string", required: false, input: false },
      accessUntil: { type: "date", required: false, input: false },
      locale: { type: "string", required: false, input: true },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => ({ data: { ...user, locale: normalizeLocale(user.locale) } }),
      },
      update: {
        before: async (data) =>
          "locale" in data
            ? { data: { ...data, locale: normalizeLocale(data.locale) } }
            : undefined,
      },
    },
  },
  // Our own limiter (src/lib/rate-limit.ts) guards /api/auth/* with proxy-aware client IPs.
  rateLimit: { enabled: false },
  advanced: {
    useSecureCookies: webUrl.startsWith("https://"),
    crossSubDomainCookies: { enabled: Boolean(cookieDomain), domain: cookieDomain },
  },
});
