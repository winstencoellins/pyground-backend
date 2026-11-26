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

## Payments (Midtrans Snap)

`POST /api/payments/checkout` creates a PENDING `Order` (price from `ACCESS_PASS_PRICE_IDR`) and returns
`{ snapToken, redirectUrl, orderId }`; pyground-web sends the learner to `redirectUrl` (Snap's hosted page, so the
web app needs no client key or Midtrans script). Snap returns to `${WEB_URL}/payment/result?orderId=…`, which calls
`POST /api/payments/orders/:orderId/sync`: owner-only, it asks Midtrans' Get Status API and applies the result through
the same idempotent path as the webhook, so access turns on even if the webhook is late (or, locally, has no tunnel).
Enabled methods: QRIS, GoPay, ShopeePay, BCA/BNI/BRI/Permata/CIMB/other VA, Mandiri Bill, credit card.
Sandbox vs production is `MIDTRANS_IS_PRODUCTION` plus the matching keys.

### Payment notifications (webhook)

`POST /api/payments/midtrans/notification`:

1. Verifies `signature_key = SHA512(order_id + status_code + gross_amount + MIDTRANS_SERVER_KEY)` (401 otherwise).
2. Ignores the body's status and asks Midtrans' **Get Status API** for the real one (500 if unreachable, so Midtrans retries).
3. `settlement`, or `capture` with `fraud_status: accept` -> in one transaction: order `PAID` (only if it wasn't already)
   and `accessUntil = max(now, accessUntil) + 30 days`. Duplicates/retries are no-ops.
   `pending` -> PENDING, `deny`/`cancel`/`failure` -> FAILED, `expire` -> EXPIRED, `refund` -> REFUNDED.
   Nothing but a refund changes a PAID order. Amount mismatches are refused. Unknown orders get 200.

**Notification URL** (Midtrans dashboard > Settings > Payment > Notification URL):
`https://<your-api-domain>/api/payments/midtrans/notification` (sandbox and production dashboards are separate).

**Testing in sandbox locally:** expose the API with a tunnel and use that URL as the notification URL:

```bash
cloudflared tunnel --url http://localhost:3001      # or: ngrok http 3001
# dashboard.sandbox.midtrans.com -> Notification URL = https://<tunnel>/api/payments/midtrans/notification
```

Then pay through Snap with Midtrans' sandbox methods (test card `4811 1111 1111 1114`, CVV `123`, any future
expiry, OTP `112233`; VA/QRIS/e-wallets via simulator.sandbox.midtrans.com) and watch the API log
`[midtrans] PYG-…: settlement -> paid`.

## Marketer codes (freelance marketing)

- A marketer is an ordinary user with a row in `marketers` (handle, per-marketer code secret, active flag,
  bank details for payouts). No separate role, so marketers can study like everyone else.
- Their code is `HANDLE-XXXXX`. `XXXXX` is derived from their secret and the Asia/Jakarta date
  (`src/modules/marketing/codes.ts`), so it changes every day at 00:00 WIB with nothing stored or scheduled.
  Yesterday's code still works until 06:00 WIB; codes from the last 30 days are reported as expired.
  Replacing a marketer's secret revokes all their codes; deactivating them stops the codes too.
- Rates are the same for every marketer: `MARKETING_DISCOUNT_PERCENT` (buyer, default 10) and
  `MARKETING_COMMISSION_PERCENT` (marketer, of the amount paid, default 20). Amounts round down. Invalid
  values stop the API from starting in production.
- Orders keep the list price, discount, marketer, code as entered and the commission. Commission status:
  `PENDING` → `PAYABLE` (7 days after payment) → `PAID` (in a `payouts` row, manual bank transfer), or
  `VOID` on refund. Marketers, their orders and payouts use `onDelete: Restrict` so history is never lost.

## Emails (Resend + React Email)

Templates live in `src/emails/` (copy for both languages in `i18n.ts`, shared layout with the
"Supported by Trixync" footer). Each email goes out in the recipient's `User.locale`:

| Email                                                 | Sent when                                         |
| ----------------------------------------------------- | ------------------------------------------------- |
| Verification                                          | sign-up, and unverified sign-in attempts          |
| Password reset                                        | `POST /api/auth/request-password-reset`           |
| Payment receipt ("Payments are processed by Trixync") | the webhook flips an order to PAID (exactly once) |

Set `RESEND_API_KEY` and `EMAIL_FROM` (a sender on a domain verified in Resend). Without a key,
development prints each email to the console; production logs only that it wasn't sent.
Sending never throws, so auth and payments keep working if Resend is down.

## Security

- **Startup check (production):** the API refuses to boot if `BETTER_AUTH_SECRET` is under 32 chars,
  `WEB_URL` isn't https (localhost allowed for DEV), Midtrans keys don't match `MIDTRANS_IS_PRODUCTION`,
  or `TRUSTED_PROXY_HOPS` is outside 1–5. Missing Resend/Midtrans keys only warn.
- **Headers on every response:** `no-store`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `CSP: default-src 'none'` (JSON only; the page CSP for Pyodide/Snap belongs to pyground-web).
- **Limits:** 1 MB request bodies; per-IP rate limits on auth, checkout, webhook, progress and quiz.
- **No account enumeration:** sign-up with an existing email and password reset for an unknown email
  answer exactly like the normal case. Foreign `redirectTo` / `Origin` are refused.
- **Shutdown:** SIGTERM finishes in-flight requests, then exits 0.
- `bun audit` is clean (`effect` is pinned to a patched 3.x via `overrides` until Prisma bumps it).

## Cron jobs

All run as separate Railway cron services from the same image (schedules are UTC):

| Service          | Command                      | Schedule                      |
| ---------------- | ---------------------------- | ----------------------------- |
| Expiry reminders | `bun run cron:reminders`     | `0 1 * * *` (08:00 WIB)       |
| Database backup  | `bun run cron:backup`        | e.g. `0 20 * * *` (03:00 WIB) |
| Expire orders    | `bun run cron:expire-orders` | `15 * * * *` (hourly)         |

**Reminders** email STUDENTs with a verified email whose pass ends in 3 days or today (Asia/Jakarta
calendar), in their language. Each `(user, kind, accessUntil)` is recorded in `reminder_emails`, so
re-runs never double-send and a renewal re-arms them. Undelivered emails (Resend down or no key) are
released for the next run and make the job exit non-zero.

**Expire orders** settles `PENDING` orders older than the payment window (24 h, sent to Snap as
`expiry`, plus 1 h of slack). Each is checked with Midtrans first: paid -> `PAID` + access + receipt (a
missed notification), no transaction (Snap opened, no payment method chosen) -> `EXPIRED`, still pending
-> left for Midtrans' own expire notification. Exits non-zero if Midtrans was unreachable; the next run
retries.

**Backups** run `pg_dump --format=custom` (credentials passed as `PG*` env vars, never argv) and upload
`pyground/YYYY/MM/pyground-YYYYMMDD-HHMMSSZ.dump` to the bucket. `pg_dump` must match the server's
major version (Postgres 17 locally). Set a lifecycle rule on the bucket to expire old dumps.
Restore: `pg_restore --clean --no-owner -d "$DATABASE_PUBLIC_URL" pyground-….dump`.

## Environments: DEV → staging → production

|           | DEV (local)                                  | Staging (Railway)                        | Production (Railway)             |
| --------- | -------------------------------------------- | ---------------------------------------- | -------------------------------- |
| Runs      | `docker compose --profile app up -d --build` | Railway environment `staging`            | Railway environment `production` |
| Database  | `pyground_dev` in the compose Postgres       | its own Railway Postgres                 | its own Railway Postgres         |
| Midtrans  | sandbox                                      | sandbox (`MIDTRANS_IS_PRODUCTION=false`) | production keys (`true`)         |
| `WEB_URL` | `http://localhost:3000`                      | staging web URL                          | production web URL               |

Promote only what passed the previous stage: DEV runs the exact production image (same Dockerfile,
`NODE_ENV=production`, pre-deploy migration, health check, cron commands), so if it works in DEV it
deploys the same way on Railway.

### DEV (local, production image)

```bash
cp .env.example .env                                  # Midtrans sandbox / Resend keys are read from here
docker compose --profile app up -d --build --wait    # migrate (pre-deploy) -> api on http://localhost:3002
docker compose --profile app run --rm api bun run db:seed   # admin from SEED_ADMIN_* (no sample data: NODE_ENV=production)
docker compose --profile app run --rm reminders      # cron: expiry reminders
docker compose --profile app run --rm backup         # cron: needs BACKUP_S3_* in .env
docker compose --profile app run --rm expire-orders  # cron: settles stale PENDING orders
docker compose --profile app down                    # stop (data stays in the volume)
```

## Deployment (Railway)

One Railway project with environments `staging` and `production`. Each environment has:

| Service                       | Source                    | Config file (Settings → Config-as-code)                                                                                       |
| ----------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Postgres                      | Railway Postgres template | —                                                                                                                             |
| `pyground-api`                | this repo                 | `railway.json`: Dockerfile build, pre-deploy `bunx --bun prisma migrate deploy` (never `migrate dev`), health check `/health` |
| `pyground-cron-reminders`     | this repo                 | `railway.cron-reminders.json`: `bun run cron:reminders` at `0 1 * * *` (08:00 WIB)                                            |
| `pyground-cron-backup`        | this repo                 | `railway.cron-backup.json`: `bun run cron:backup` at `0 20 * * *` (03:00 WIB)                                                 |
| `pyground-cron-expire-orders` | this repo                 | `railway.cron-expire-orders.json`: `bun run cron:expire-orders` at `15 * * * *` (hourly)                                      |
| `pyground-web`                | pyground-frontend repo    | proxies `/api/*` to `pyground-api` over the private network                                                                   |

**Variables** (set per environment; see `.env.example` for all of them):

- All backend services: `DATABASE_URL=${{Postgres.DATABASE_URL}}` (private network), `WEB_URL`,
  `BETTER_AUTH_SECRET` (`openssl rand -base64 32`, different per environment), `RESEND_API_KEY`, `EMAIL_FROM`.
- `pyground-api`: `MIDTRANS_SERVER_KEY`, `MIDTRANS_IS_PRODUCTION`, `ACCESS_PASS_PRICE_IDR`,
  `TRUSTED_PROXY_HOPS`, optional `COOKIE_DOMAIN`. Railway sets `PORT`; the API listens on `::`.
- `pyground-cron-backup`: `BACKUP_S3_*`.
- `pyground-cron-expire-orders`: `MIDTRANS_SERVER_KEY`, `MIDTRANS_IS_PRODUCTION`, `ACCESS_PASS_PRICE_IDR`
  (same values as `pyground-api`).
- `DATABASE_PUBLIC_URL` is only for running migrations or restores from your machine:
  `DATABASE_URL="$DATABASE_PUBLIC_URL" bun run db:deploy`.

After the first deploy of an environment: seed the admin once (`railway run --service pyground-api bun run db:seed`
with `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`), then set the Midtrans Notification URL for that environment's
dashboard (sandbox for staging, production for production) to `https://<api-domain>/api/payments/midtrans/notification`.

The image pins Bun 1.4.4 (CI uses the same). Bun 1.3.x can't load react-dom's production server build, which
breaks every email when `NODE_ENV=production`; `tests/emails.test.ts` guards this.
