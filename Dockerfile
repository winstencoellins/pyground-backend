# pyground-api: one image for the API service and both cron services (reminders, backup).
FROM oven/bun:1.4.4-slim AS base
WORKDIR /app

# Production dependencies only (prisma CLI is a runtime dependency: pre-deploy runs migrate deploy).
FROM base AS deps
COPY package.json bun.lock ./
# Install scripts must run: @prisma/engines downloads the schema engine that `migrate deploy` needs.
RUN bun install --frozen-lockfile --production

# Generate the Prisma client (no database needed: prisma.config.ts tolerates a missing DATABASE_URL).
FROM deps AS build
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY src ./src
RUN bunx --bun prisma generate

FROM base AS runtime
# pg_dump 17 for the backup cron (from the official PostgreSQL apt repo; must be >= the server's major).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates postgresql-common \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY package.json prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
COPY content ./content
USER bun
EXPOSE 3001
CMD ["bun", "src/index.ts"]
