import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true },
  user: {
    // Exposed on the session user; input: false so sign-up can't set them (DB defaults apply).
    additionalFields: {
      role: { type: "string", required: false, input: false },
      accessUntil: { type: "date", required: false, input: false },
      locale: { type: "string", required: false, input: false },
    },
  },
});
