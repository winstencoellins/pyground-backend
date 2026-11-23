import { betterAuth, type User } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { authEmail } from "../emails";
import { sendEmail } from "../emails/send";
import { prisma } from "./prisma";

type AuthUser = User & { locale?: unknown };

const webUrl = process.env.WEB_URL;
if (!webUrl) throw new Error("WEB_URL is not set");
const cookieDomain = process.env.COOKIE_DOMAIN; // e.g. ".pyground.id" once on a custom domain

// Awaited but never throws (sendEmail swallows failures), so auth flows don't break if email is down.
const deliver = (kind: "verification" | "passwordReset", user: AuthUser, url: string) =>
  sendEmail(authEmail(kind, user, url)).then(() => undefined);

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
