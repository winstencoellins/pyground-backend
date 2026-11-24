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
`{ snapToken, orderId }`; pyground-web opens Snap with `MIDTRANS_CLIENT_KEY`. Snap redirects to
`${WEB_URL}/payment/result?orderId=…`, which polls `GET /api/payments/orders/:orderId`.
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

## Cron jobs

Both run as separate Railway cron services from the same image (schedules are UTC):

| Service          | Command                  | Schedule                      |
| ---------------- | ------------------------ | ----------------------------- |
| Expiry reminders | `bun run cron:reminders` | `0 1 * * *` (08:00 WIB)       |
| Database backup  | `bun run cron:backup`    | e.g. `0 20 * * *` (03:00 WIB) |

**Reminders** email STUDENTs with a verified email whose pass ends in 3 days or today (Asia/Jakarta
calendar), in their language. Each `(user, kind, accessUntil)` is recorded in `reminder_emails`, so
re-runs never double-send and a renewal re-arms them. Undelivered emails (Resend down or no key) are
released for the next run and make the job exit non-zero.

**Backups** run `pg_dump --format=custom` (credentials passed as `PG*` env vars, never argv) and upload
`pyground/YYYY/MM/pyground-YYYYMMDD-HHMMSSZ.dump` to the bucket. `pg_dump` must match the server's
major version (Postgres 17 locally). Set a lifecycle rule on the bucket to expire old dumps.
Restore: `pg_restore --clean --no-owner -d "$DATABASE_PUBLIC_URL" pyground-….dump`.
