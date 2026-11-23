# pyground-api

Backend for Pyground (Bun + Elysia). Full setup and deployment docs land with the deploy task.

```bash
bun install
bun run dev        # http://localhost:3001/health
bun run typecheck && bun run lint && bun run format:check
bun test                       # needs local Postgres running + migrated
```

## Local database

```bash
cp .env.example .env
docker compose up -d --wait   # Postgres 17 on localhost:5434 (set POSTGRES_PORT to change)
bun run db:generate           # Prisma client -> src/generated/prisma
bun run db:migrate            # apply migrations (local only; production uses db:deploy)
bun run db:seed               # admin from SEED_ADMIN_* + sample student (sample data skipped in production)
```

## Errors

Every error is `{ "error": { "code": "STABLE_CODE", "message": "for developers" } }`.
The web translates `code`; never show `message` to users. Base codes: `VALIDATION_ERROR`,
`INVALID_BODY`, `NOT_FOUND`, `RATE_LIMITED` (with `Retry-After`), `INTERNAL_ERROR`.

## Auth

Better Auth (email + password, email verification required) is served at `/api/auth/*`.
pyground-web proxies `/api/*` here, so `WEB_URL` is used as Better Auth's `baseURL` and trusted origin.
Until Resend is wired, verification and reset links are printed to the console (never in production).
Protected routes use `{ auth: true }` (401 `UNAUTHORIZED`) or `{ admin: true }` (403 `FORBIDDEN`).

## API types package (`@winstencoellins/pyground-api-types`)

`src/app.ts` exports `type App` (the routes, without the error handler). `bun run types:build` writes
`types-package/dist/index.d.ts`: declarations only, no runtime code, and it fails if the contract
would need any module other than `elysia`. On every push to `main`, the "Publish API types" workflow
publishes it to GitHub Packages **if** `types-package/package.json` has a new version.

**When routes or response shapes change, bump `types-package/package.json` `version`** (minor for new
routes/fields, major for breaking changes) and note the version in the Notion task.

Consuming it from pyground-web:

```ini
# .npmrc (token needs read:packages; in CI use the workflow's GITHUB_TOKEN or a PAT secret)
@winstencoellins:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```ts
import { treaty } from "@elysiajs/eden";
import type { App } from "@winstencoellins/pyground-api-types";
const api = treaty<App>(process.env.API_URL!);
```
