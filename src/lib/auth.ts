import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma";

const webUrl = process.env.WEB_URL;
if (!webUrl) throw new Error("WEB_URL is not set");
const cookieDomain = process.env.COOKIE_DOMAIN; // e.g. ".pyground.id" once on a custom domain

// shortcut: links go to the console until Resend is wired (task #28). Never log tokens in production.
function deliver(kind: string, to: string, url: string) {
  if (process.env.NODE_ENV === "production") {
    console.warn(`[auth] ${kind} email for ${to} not sent: email delivery is not configured yet`);
    return;
  }
  console.info(`[auth] ${kind} link for ${to}: ${url}`);
}

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
    sendResetPassword: async ({ user, url }) => deliver("password reset", user.email, url),
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true, // unverified sign-in attempts get a fresh link
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => deliver("verification", user.email, url),
  },
  user: {
    // Exposed on the session user; input: false so sign-up can't set them (DB defaults apply).
    additionalFields: {
      role: { type: "string", required: false, input: false },
      accessUntil: { type: "date", required: false, input: false },
      locale: { type: "string", required: false, input: false },
    },
  },
  // Our own limiter (src/lib/rate-limit.ts) guards /api/auth/* with proxy-aware client IPs.
  rateLimit: { enabled: false },
  advanced: {
    useSecureCookies: webUrl.startsWith("https://"),
    crossSubDomainCookies: { enabled: Boolean(cookieDomain), domain: cookieDomain },
  },
});
