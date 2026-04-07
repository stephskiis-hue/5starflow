# OpenAI Memory File — 5StarFlow

This file is meant to let a future session (or another device) jump back into this repo quickly without re-auditing everything.

## Repo Layout

- `/backend` is the Node/Express app (served on `PORT`).
- Root `/index.html` etc are the marketing website (static).

## Backend Stack (Current)

- Node.js + Express
- PostgreSQL on Railway (via Prisma)
- Jobber GraphQL API (header required): `X-JOBBER-GRAPHQL-VERSION` (env: `JOBBER_API_VERSION`, default `2026-03-10`)
- Twilio + Gmail exist in the app, but **do not send** when `DRY_RUN=true`.

Backend entry: [`/backend/server.js`](./backend/server.js)

## What Was Implemented / Changed (Campaign System + Jobber Fix)

### 1. Jobber GraphQL schema fix (phones/emails)

Jobber `phones` / `emails` are lists and **do not accept** pagination args like `first`.

Edits:

- [`/backend/services/marketingService.js`](./backend/services/marketingService.js): changed `phones(first: ...)` to `phones { ... }`
- [`/backend/services/weatherService.js`](./backend/services/weatherService.js): changed `phones(first: ...)`/`emails(first: ...)` to simple lists

### 2. Campaign Management System (v2) tables (Prisma + migration)

New Prisma models mapped to new snake_case tables:

- `CampaignClient` → `clients`
- `Campaign` → `campaigns`
- `CampaignMember` → `campaign_members`

Schema: [`/backend/prisma/schema.prisma`](./backend/prisma/schema.prisma)

Migration (Railway applies on deploy because `npm start` runs `prisma migrate deploy`):

- [`/backend/prisma/migrations/20260407_add_campaign_system_v2/migration.sql`](./backend/prisma/migrations/20260407_add_campaign_system_v2/migration.sql)

Important constraints:

- `clients` unique: (`jobberAccountId`, `jobberClientId`)
- `campaign_members` primary key: (`campaignId`, `clientId`)
- `campaigns` unique: (`jobberAccountId`, `name`, `type`)
- GIN index on `clients.tags` (jsonb) for fast tag filtering

### 3. Consent-safe sync engine (Jobber → `clients` table)

Files:

- [`/backend/services/campaignSync.js`](./backend/services/campaignSync.js)
- [`/backend/services/jobberSchema.js`](./backend/services/jobberSchema.js) (GraphQL introspection to discover consent fields)
- [`/backend/services/campaignUtils.js`](./backend/services/campaignUtils.js) (primary contact + strict eligibility computation)

Key behaviors:

- Fetches Jobber clients in pages of 50.
- Flattens `phones[]` + `emails[]` into `primaryPhone` / `primaryEmail`.
- Reads Jobber throttle points (`extensions.cost.throttleStatus`) and waits when low.
- Upserts into Postgres to avoid duplicates.
- Strict opt-in allowlist (configurable):
  - `SMS_OPT_IN_VALUES` (default `OPT_IN,OPTED_IN`)
  - `EMAIL_OPT_IN_VALUES` (default `OPT_IN,OPTED_IN`)
- Consent field discovery overrides (if needed):
  - `JOBBER_SMS_CONSENT_FIELD` + `JOBBER_SMS_CONSENT_ON=client|phone`
  - `JOBBER_EMAIL_CONSENT_FIELD` + `JOBBER_EMAIL_CONSENT_ON=client|email`

## Railway Notes

- Pushing to GitHub auto-deploys to Railway (GitHub integration).
- Backend `package.json` includes Railway CLI helpers, but CLI login may be blocked in non-interactive environments:
  - [`/backend/RAILWAY.md`](./backend/RAILWAY.md)

## Environment Variables (Quick)

Minimum needed for backend to boot on Railway:

- `DATABASE_URL` (Railway Postgres)
- `SESSION_SECRET`
- `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`
- `JOBBER_REDIRECT_URI`
- `JOBBER_GRAPHQL_URL`, `JOBBER_TOKEN_URL`, `JOBBER_AUTH_URL`
- `JOBBER_API_VERSION` (default `2026-03-10`)

Recommended for safe testing:

- `DRY_RUN=true` (prevents Twilio/Gmail sends; sync still runs)

## What To Do Next (Most Likely)

- Add `/api/campaigns/*` routes + `campaigns.html` UI so you can:
  - Sync Jobber → `clients`
  - Create campaigns
  - Bulk add by tag
  - Toggle per-member channel override with eligibility enforcement
- Ensure STOP/opt-out updates `clients.optedOut` too (not just `CachedJobberClient`).

