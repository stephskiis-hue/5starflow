# 5StarFlow — Claude Code Context

## What this is
Automated Google review requester for "No-Bs Yardwork" lawn care.
Flow: Jobber paid invoice webhook → 60-min delay → Twilio SMS + Gmail → Google review link.

## Stack
- Node.js/Express backend, port 3001
- Prisma ORM + SQLite (`backend/prisma/dev.db`)
- Jobber GraphQL API — version header: `X-JOBBER-GRAPHQL-VERSION: 2026-03-10`
- Twilio SMS + Gmail OAuth (nodemailer)
- ngrok static domain: `oxydasic-elia-crenate.ngrok-free.dev`

## Startup (every session)
```
Terminal 1: ~/Desktop/ngrok http 3001
Terminal 2: cd "/Users/macos/5starflow app/backend" && npm run dev
Browser:    http://localhost:3001
```

## Critical File Map
```
backend/
  server.js                    — Express entry point, mounts all routes
  routes/
    auth.js                    — Jobber OAuth2 flow (callback, token exchange)
    status.js                  — All /api/* endpoints (pending-reviews, test-*, probe-*)
    webhook.js                 — POST /webhook/jobber receiver
    portal.js                  — Login/logout, session auth
  services/
    jobberClient.js            — jobberGraphQL() helper + token refresh
    reviewRequester.js         — Fetches invoice from Jobber, queues PendingReview
    deliveryQueue.js           — Cron: sends SMS+email when scheduledAt passes
    tokenManager.js            — Cron: refreshes tokens every 5 min
    smsService.js              — Twilio SMS (DRY_RUN guard)
    emailService.js            — Gmail send (DRY_RUN guard)
  middleware/
    requireAuth.js             — Session auth guard
    verifyWebhook.js           — HMAC signature check (uses JOBBER_CLIENT_SECRET)
  prisma/
    schema.prisma              — DB schema
    dev.db                     — SQLite database
  dashboard.html               — Single-page dashboard UI
  login.html                   — Login page
```

## Absolute Rules
1. Jobber GraphQL header required: `X-JOBBER-GRAPHQL-VERSION: 2026-03-10`
2. `account_id` and `exp` are in the JWT payload — NOT in Jobber token response body. Decode with: `JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'))`
3. Webhook payload path: `payload.data.webHookEvent.{topic, itemId, accountId}`
4. Invoice status field is `invoiceStatus` (type: `InvoiceStatusTypeEnum`) — NOT `status`
5. `DRY_RUN=true` in `.env` during development — set false only to go live
6. `FRONTEND_ORIGIN=http://localhost:3001` — dashboard accessed locally, ngrok is server-only
7. Always run `npx prisma migrate dev --name <name>` after any schema change
8. HMAC webhook signature uses `JOBBER_CLIENT_SECRET` as the key

## Known Working Patterns
- Token refresh: decodes JWT `.exp` for expiry — Jobber does not return `expires_in`
- Webhook dedup: `PendingReview.invoiceId` is `@unique` — Prisma P2002 error = already queued, silent skip
- Delivery dedup: `ReviewSent.clientId` is `@unique` — prevents re-sending to same client
- Throttle guard: invoicePoller backs off 120s on 429 — expected behavior, not a bug
- `allowReviewRequest` field on Invoice — Jobber's own boolean for review eligibility

## Key env vars
```
JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET
JOBBER_REDIRECT_URI=https://oxydasic-elia-crenate.ngrok-free.dev/auth/callback
JOBBER_GRAPHQL_URL=https://api.getjobber.com/api/graphql
JOBBER_API_VERSION=2026-03-10
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
DRY_RUN=true
FRONTEND_ORIGIN=http://localhost:3001
SETUP_TOKEN=b43c6b82001e7c4af4867a149f7e2cbe
REVIEW_DELAY_MINUTES=60
SESSION_SECRET
```
