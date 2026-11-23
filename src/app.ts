import { Elysia } from "elysia";
import { errorHandler } from "./lib/errors";
import { prisma } from "./lib/prisma";

export const app = new Elysia().use(errorHandler).get("/health", async ({ set }) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok" };
  } catch {
    set.status = 503;
    return { status: "degraded", database: "unreachable" };
  }
});

export type App = typeof app;
