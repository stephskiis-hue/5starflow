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

## What Was Implemented / Changed (Current State)

### 1. Jobber GraphQL schema fix (phones/emails)

Jobber `phones` / `emails` are lists and **do not accept** pagination args like `first`.

Edits:

- [`/backend/services/marketingService.js`](./backend/services/marketingService.js): changed `phones(first: ...)` to `phones { ... }`
- [`/backend/services/weatherService.js`](./backend/services/weatherService.js): changed `phones(first: ...)`/`emails(first: ...)` to simple lists

### 2. SMS Marketing improvements kept

The extra standalone Campaign Manager was removed so `SMS Marketing` remains the only user-facing campaign system.

The following improvements were intentionally kept because they help the existing SMS Marketing flow:

- Jobber GraphQL list-field fix:
  - [`/backend/services/marketingService.js`](./backend/services/marketingService.js)
  - [`/backend/services/weatherService.js`](./backend/services/weatherService.js)
- Safer Jobber client cache sync that preserves opt-outs and normalizes phone numbers:
  - [`/backend/services/jobberClientSync.js`](./backend/services/jobberClientSync.js)
- Better opt-out phone matching in the marketing routes and inbound SMS handling:
  - [`/backend/routes/marketing.js`](./backend/routes/marketing.js)
  - [`/backend/server.js`](./backend/server.js)

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

- Verify Railway env vars are set correctly for Jobber, Twilio, Gmail, and `DATABASE_URL`.
- Confirm the existing `SMS Marketing` audience import and send flow works end-to-end on Railway.
- If the removed Campaign Manager tables were already deployed to Railway Postgres, apply the rollback migration that drops them.
