# pyground-api

Backend for Pyground (Bun + Elysia). Full setup and deployment docs land with the deploy task.

```bash
bun install
bun run dev        # http://localhost:3001/health
bun run typecheck && bun run lint && bun run format:check
```

## Local database

```bash
cp .env.example .env
docker compose up -d --wait   # Postgres 17 on localhost:5434 (set POSTGRES_PORT to change)
bun run db:generate           # Prisma client -> src/generated/prisma
bun run db:migrate            # apply migrations (local only; production uses db:deploy)
bun run db:seed               # admin from SEED_ADMIN_* + sample student (sample data skipped in production)
```
