import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const adapter = new PrismaPg({
  connectionString,
  max: Number(process.env.DATABASE_POOL_MAX ?? 5), // small Railway instance
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

// The only PrismaClient in the app; import `prisma` from here everywhere.
export const prisma = new PrismaClient({ adapter });
