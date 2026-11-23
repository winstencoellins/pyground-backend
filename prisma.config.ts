import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "bun prisma/seed.ts",
  },
  datasource: {
    // Railway: ${{Postgres.DATABASE_URL}}. To migrate Railway from your machine, set this to DATABASE_PUBLIC_URL.
    // process.env (not env()) so `prisma generate` works in CI and Docker builds without a database.
    url: process.env.DATABASE_URL ?? "",
  },
});
