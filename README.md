# Paedavic — Telegram Notification Platform

API-first notification platform. A Telegram bot is one client of an internal
service layer; a web dashboard (email/password) is another. Built as a monorepo
so the backend, the bot, the delivery worker, and the web app share one
contract and one tenant-isolated service layer.

## Architecture

```
apps/
  api/        NestJS + Fastify — REST controllers + grammY bot runtime (thin)
  worker/     NestJS standalone context — BullMQ delivery worker (thin)
  web/        Next.js dashboard (second API client)            [later]
packages/
  core/       ★ service layer — the single source of truth, tenant-scoped
  database/   Prisma schema + migrations + PrismaService
  contracts/  zod DTOs + types — shared by api AND web (no drift)
  telegram/   grammY client + 429-aware send wrapper (used by api AND worker)
  queue/      BullMQ producer + connection + backoff (api enqueues, worker consumes)
  config/     zod-validated env loader
```

**Why a package for `telegram` and not an app:** both `api` (receives commands)
and `worker` (sends broadcasts) must talk to Telegram, so the client is a shared
capability. The *runtime loop* is app-shaped and lives in `apps/api`.

**Tenant isolation:** every transport — JWT (web), API key (programmatic),
Telegram id (bot) — resolves to one `AuthPrincipal { sourceId }`, and every
service query is scoped by it. A Source can never read or target another's data.

## Stack

NestJS (Fastify) · grammY · PostgreSQL + Prisma · Redis + BullMQ · pnpm +
Turborepo · Docker Compose. Node ≥ 20.

## Slices

| # | Slice | Status |
|---|-------|--------|
| 1 | Source provisioning + idempotent `/start` deep-link | ✅ done |
| 2 | Notification gallery CRUD + placeholder validation | ✅ done |
| 3 | Groups CRUD + membership (implicit All) | ✅ done |
| 4 | InviteLink issue/open/revoke + attribution | ✅ done |
| 5 | Broadcast: queue → worker → status → rate-limit | ✅ done |
| 6 | `/stop` consent + audit log | ✅ done |

## Quick start

```bash
pnpm install
cp .env.example .env            # fill TELEGRAM_BOT_TOKEN to enable the bot
docker compose up -d postgres redis
pnpm db:generate                # generate Prisma client
pnpm --filter @paedavic/database migrate   # apply migrations (dev)
pnpm build
pnpm --filter @paedavic/api dev # or: pnpm --filter @paedavic/worker dev
```

Full stack in containers: `docker compose up --build`.

## Exercise Slice 1

Provisioning is admin-guarded; everything else uses the issued credential.

```bash
ADMIN=dev-admin-key-change-me

# 1) Provision a workspace (returns apiKey + start link, key shown once)
curl -s -X POST localhost:3000/sources \
  -H "x-admin-key: $ADMIN" -H 'content-type: application/json' \
  -d '{"ownerEmail":"a@ex.com","ownerPassword":"password123","name":"Acme"}'

# 2) Read your workspace with the API key
curl -s localhost:3000/sources/me -H "Authorization: Bearer pk_..."

# 3) Web-style auth: register (creates account + workspace), returns a JWT
curl -s -X POST localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"b@ex.com","password":"password123","workspaceName":"Beta"}'

# 4) Same /sources/me works with the JWT — identical tenant scoping
curl -s localhost:3000/sources/me -H "Authorization: Bearer <jwt>"
```

**Bot:** set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_BOT_USERNAME`, open the `startLink`
from step 1 in Telegram, press Start. It idempotently binds your Telegram
account to the workspace; reopening the link re-confirms without duplicating.

## Bot admin UI (button-driven, no curl needed)

Once your Telegram account is linked, the entire workspace is manageable from
chat — no commands to memorize, everything is buttons.

**Commands** (also in the `/` menu + menu button): `/start` `/menu`
`/notifications` `/groups` `/links` `/send` `/help` `/stop`.

**What you can do by tapping:**

- **📝 Notifications** — browse (paginated), **create** (guided name → body),
  **edit** (name/body with "keep current"), duplicate, archive (with confirm).
- **👥 Groups** — create, delete (confirm), and **assign subscribers** by
  tapping ✅/⬜; the implicit **All** group is shown but not editable.
- **🔗 Invite links** — create (optionally **bound to a group** so joiners are
  auto-added), view join count, revoke (confirm).
- **📣 Broadcast** — pick a notification → **multi-select groups** → fill any
  `{placeholders}` one prompt at a time → send. Delivery needs the worker
  running; result shows `✅ Queued · N group(s) · M recipient(s)`.

Every screen edits one message in place, has **Back / Cancel**, and shows a
success/error line after each action. Multi-step input uses grammY
conversations (cancel at any step). Subscribers only ever see the join
confirmation and `/stop`.

> The bot layer is pure presentation over the same service methods the REST API
> uses — no business logic or tenant scoping lives in the handlers.

## Tests

```bash
pnpm --filter @paedavic/core test   # crypto, tenant isolation, /start idempotency
```

## Conventions

- Service layer (`packages/core`) is the only place business logic lives;
  controllers and bot handlers are thin and call it.
- Every mutating service method takes/!scopes by `sourceId`.
- No secrets in code — everything via env (`packages/config`, validated by zod).
