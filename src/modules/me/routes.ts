import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { sessionPlugin } from "../../plugins/session";

type MeUser = {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  accessUntil?: Date | null;
  locale?: string | null;
};

// locale is lowercase on the wire ("id" | "en"), same as ?locale= on lesson routes.
const toMe = (u: MeUser) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: (u.role ?? "STUDENT") as "STUDENT" | "ADMIN",
  accessUntil: u.accessUntil ?? null,
  locale: (u.locale === "EN" ? "en" : "id") as "id" | "en",
});

export const meRoutes = new Elysia({ prefix: "/api/me" })
  .use(sessionPlugin)
  .get("/", ({ user }) => toMe(user), { auth: true })
  .patch(
    "/",
    async ({ user, body }) =>
      toMe(
        await prisma.user.update({
          where: { id: user.id },
          data: { locale: body.locale === "en" ? "EN" : "ID" },
        }),
      ),
    { auth: true, body: t.Object({ locale: t.Union([t.Literal("id"), t.Literal("en")]) }) },
  );
