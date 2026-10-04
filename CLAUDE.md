# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 5StarFlow — Claude Code Context

## What this is
Multi-tenant SaaS automation platform for home service businesses using Jobber.
Core flow: Jobber paid invoice webhook → delay queue → Twilio SMS + Gmail → Google review link.
Extended features: rain alerts + reschedule notifications, SMS marketing campaigns, SEO audits, website audits, loyalty/referral engine, analytics.

## Repo Layout
```
5starflow/                      ← root = marketing website (static HTML)
  index.html, pricing.html      ← public landing pages
  case-study.html, privacy.html, terms.html
  css/, js/                     ← shared styles + vanilla JS
  backend/                      ← Node.js app (see below)
```

## Stack
- Node.js/Express backend, port 3001
- Prisma ORM + **PostgreSQL** (`DATABASE_URL` in .env)
- Jobber GraphQL API — version header: `X-JOBBER-GRAPHQL-VERSION: 2026-03-10`
- Twilio SMS + Gmail OAuth2 (nodemailer)
- ngrok static domain: `oxydasic-elia-crenate.ngrok-free.dev`

## Commands

All backend commands run from `backend/`:

```bash
# Development
npm run dev                                    # nodemon server.js (auto-restart)

# Tests (pure-logic only, no DB required)
npm test                                       # node --test test/*.test.js

# Database
npx prisma migrate dev --name <name>           # apply schema change + generate client
npx prisma migrate deploy                      # production-safe apply (no interactive prompt)
npx prisma studio                              # local GUI at localhost:5555
npx prisma generate                            # regenerate client after schema edit without migrating

# Railway (must run railway:link once per machine first)
npm run railway:logs:latest                    # last 200 lines from latest deploy
npm run railway:http-logs                      # last 200 HTTP logs
npm run railway:deploy                         # push to Railway
```

The test suite (`test/ai.test.js`) covers pure-logic units: conversation classifier, brand QA lint, renderer validation, timezone helpers, ledger normalizer, and vault auto-tagging. DB-backed flows (campaign caps, task dedup, publish flow) have no automated tests — verify by smoke-running the relevant API endpoints.

## Startup (every session)
```
Terminal 1: ~/Desktop/ngrok http 3001
Terminal 2: cd ~/5starflow/backend && npm run dev
Browser:    http://localhost:3001
```

## Critical File Map
```
backend/
  server.js                      — Express entry point, mounts all routes + schedulers
  routes/
    auth.js                      — Jobber OAuth2 flow (callback, token exchange)
    portal.js                    — Login/logout, session auth, Google OAuth login
    status.js                    — /api/* status endpoints (pending-reviews, test-*, probe-*)
    webhook.js                   — POST /webhook/jobber (Jobber webhooks). Inbound SMS is POST /api/marketing/inbound-sms in server.js (Twilio-signature verified)
    ai.js                        — /api/ai/* AI OS tool layer (bearer AI_TOKEN for Claude routines, or admin session)
    connections.js               — Integration connection state + verification
    settings.js                  — Per-user app settings
    weather.js                   — Rain check triggers, reschedule sends, history
    marketing.js                 — SMS marketing: templates, audiences, campaigns, sync-status
    messageSettings.js           — Review request email/SMS customization
    messageTemplates.js          — Reusable message template CRUD
    gmail.js                     — Gmail OAuth2 connect flow
    analytics.js                 — GA4 + Search Console data
    seo.js                       — SEO audit runs, proposals, change apply
    websiteAudit.js              — FTP-based website audit (pull, audit, push)
    leaderboard.js               — Loyalty/referral leaderboard
  services/
    jobberClient.js              — jobberGraphQL() helper + token refresh + returnExtensions opt
    reviewRequester.js           — Fetches invoice from Jobber, queues PendingReview
    deliveryQueue.js             — Cron: sends SMS+email when scheduledAt passes
    tokenManager.js              — Cron: refreshes Jobber tokens every 5 min
    smsService.js                — Twilio SMS (DRY_RUN guard)
    emailService.js              — Gmail send (DRY_RUN guard)
    invoicePoller.js             — Polls Jobber for new paid invoices (fallback to webhook)
    weatherService.js            — OpenWeather rain check + reschedule notification sender
    marketingService.js          — Jobber client import, campaign send with adaptive throttling
    jobberClientSync.js          — Background Jobber client cache sync (every 4h at :15)
    seoService.js                — PageSpeed + Search Console + Claude AI SEO audits (weekly cron)
    analyticsService.js          — GA4 query helpers
    loyaltyService.js            — Points, referral slugs, multipliers
    auditService.js              — FTP pull/push, HTML audit scoring
    ftpService.js                — FTP connection wrapper
    browserAuth.js               — Playwright browser auth helper
  middleware/
    requireAuth.js               — Session auth guard
    verifyWebhook.js             — HMAC signature check (uses JOBBER_CLIENT_SECRET)
  lib/
    auth.js                      — Shared auth helpers
    prismaClient.js              — Singleton Prisma client
  prisma/
    schema.prisma                — Full DB schema (PostgreSQL)
  HTML pages (all require auth except login):
    login.html                   — Login (email/password or Google OAuth)
    index.html                   — Main dashboard (review queue stats)
    review-dashboard.html        — Review request history + resend
    marketing.html               — SMS marketing: build audiences, campaigns, inbox
    weather-dashboard.html       — Rain check history + manual trigger
    connections.html             — Integration status + OAuth connect buttons
    settings.html                — Account settings
    message-settings.html        — Customize review request email/SMS
    seo-dashboard.html           — SEO audit results + proposal approval
    website-audit.html           — FTP audit scanner
    admin.html                   — Admin panel (admin role only)
```

## AI Operating System (backend/ai/, backend/routes/ai.js, backend/ai.html)
Read `backend/ai/README.md` first. Short version:
```
ai/runner.js        runRoutine(slug, tick, opts) — EVERY scheduler goes through it (mutex, lease, ledger row, failure tasks)
ai/registry.js      Routine Registry seed (backend jobs + the Claude routines on claude.ai)
ai/heartbeat.js     flags routines that went quiet (e.g. Claude plan limit) as Tasks
ai/tasks.js memory.js ledger.js brief.js comms.js smsMonitor.js   tasks (dedupKey), selective memory, activity, work packet, conversation states
ai/design/          design-system layouts + renderer.js (Playwright) + qa.js (brand lint)   ai/vault.js content.js social.js (daily caps)
ai/prompts/         prompts for the Claude routines (Night Studio, Social Shift, Inbox Watch, Morning Brief)
.claude/skills/nobs-*   skills the routines load (api, brand, content, facebook, communication, research)
```
Rules: deterministic work stays in code, Claude only reasons/writes; do not rebuild a working routine — wrap it in `runRoutine`; new customer-facing sends must go through `sendSmsSafely`/`logComm` and check `isOptedOut`; social caps are enforced server-side in `ai/social.js`; `/api/ai` mounts BEFORE `requireAuth` and authenticates itself.

## Absolute Rules
1. Jobber GraphQL header required: `X-JOBBER-GRAPHQL-VERSION: 2026-03-10`
2. `account_id` and `exp` are in the JWT payload — NOT in Jobber token response body. Decode: `JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())`
3. Webhook payload path: `payload.data.webHookEvent.{topic, itemId, accountId}`
4. Invoice status field is `invoiceStatus` (type: `InvoiceStatusTypeEnum`) — NOT `status`
5. `DRY_RUN=true` in `.env` during development — set false only to go live. DRY_RUN also blocks Jobber WRITES (tags, visit moves). Never point a local dev server at the Railway `DATABASE_URL`: the schedulers would consume production work
6. `FRONTEND_ORIGIN=http://localhost:3001` — dashboard is local only, ngrok is server-only
7. Always run `npx prisma migrate dev --name <name>` after any schema change
8. HMAC webhook signature uses `JOBBER_CLIENT_SECRET` as the key
9. **Jobber query cost limit is 10,000 pts.** Always add `first:` on ALL nested connections in GraphQL queries or queries will be rejected before running (each uncapped connection assumes 100 nodes = instant budget exhaustion).
10. **`phones` and `emails` on Jobber `Client` are plain lists — they do NOT accept `first:` or any pagination args.** Writing `phones(first: 1) { ... }` causes a GraphQL schema error. Fetch them as bare selections: `phones { number isPrimary }`.

## AI OS Status
Done: M0 security + correctness · M1 registry/ledger/tasks/memory/activity/heartbeat/API/dashboard · M2 renderer, QA, vault, content pipeline, social caps/groups, skills + prompts · M3 communication ledger, conversation states, SMS monitor, Twilio reconcile, pure-logic unit tests (15 tests).

Pending in code (see `backend/ai/TODO.md`): Gmail monitor (needs `gmail.readonly` Production OAuth), website-inquiry `REQUEST_CREATE` webhook, live Jobber context in `customers/context`, Google Ops Log import, deterministic cores of money routines ported to backend `run(ctx)`, metrics learning loop, autonomy ratchet UI, `marketing.html` campaign-poll infinite loop + missing `deliveryStatus` in conversation thread.

Pending owner actions: Railway env (`AI_TOKEN`, `OPERATOR_USER_ID`), claude.ai network allowlist + bearer credential, update routine prompts from `ai/prompts/`, set `expectedEveryMinutes` per routine after first run, confirm Google OAuth app in Production mode for Gmail read scope.

## Known Working Patterns
- Token refresh: decodes JWT `.exp` for expiry — Jobber does not return `expires_in`
- Webhook dedup: `PendingReview.invoiceId` is `@unique` — Prisma P2002 = already queued, silent skip
- Delivery dedup: `ReviewSent.clientId` is `@unique` — prevents re-sending to same client
- Throttle handling: 429 is NOT retried immediately (removed from RETRYABLE_STATUS). `jobberClientSync.js` backs off 10 min on 429. `invoicePoller.js` backs off 120s.
- Adaptive query cost: `jobberGraphQL({ returnExtensions: true })` returns `extensions.cost.throttleStatus` — use `currentlyAvailable / restoreRate` to compute adaptive delay between pages
- Jobber client sync: `jobberClientSync.js` runs every 4h at :15 (avoids :00 overlap with invoicePoller). Startup delay 3 min. Live polling via GET `/api/marketing/sync-status` (polls every 3s in UI).
- Inbound SMS: POST `/api/marketing/inbound-sms` (server.js; there is no `/webhook/twilio`) — `lib/twilioSignature.js` verifies X-Twilio-Signature (needs `APP_URL`; `TWILIO_SKIP_SIGNATURE=true` for local dev only), matches sender phone to `CachedJobberClient`, stores `InboundSMS` + a `CommMessage`, auto-handles STOP opt-out
- `allowReviewRequest` field on Invoice — Jobber's own boolean for review eligibility
- **SMS dispatch vs delivery are separate columns.** `MarketingMessage.status` is our
  lifecycle (pending/queued/retrying/failed/skipped) — `queued` means Twilio accepted the
  API call, NOT that a phone received it. `deliveryStatus`/`deliveredAt`/`carrierErrorCode`
  are Twilio's, written only by `/api/marketing/twilio-callback`. Never let the callback
  write `status`: receipts arrive out of order and will corrupt the state machine.
  Legacy rows carry `status='sent'`, a synonym for `queued`.
- **SMS bills per segment.** GSM-7 = 160 chars/segment (153 multipart); one character
  outside it (any emoji, a curly `'`) switches the body to UCS-2 at 70/67. Use
  `calculateSegments()` / `stripToGsm7()` in `smsService.js` — never estimate from
  `body.length`.
- Sender selection goes through `senderParams(creds)` in `smsService.js`. A Messaging
  Service SID and a from-number are mutually exclusive in the Twilio API.

## Key env vars
```
# Database
DATABASE_URL                      # PostgreSQL connection string

# Server
PORT=3001
SESSION_SECRET
SETUP_TOKEN
APP_URL=https://oxydasic-elia-crenate.ngrok-free.dev
FRONTEND_ORIGIN=http://localhost:3001
DRY_RUN=true

# Jobber
JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET
JOBBER_REDIRECT_URI=https://oxydasic-elia-crenate.ngrok-free.dev/auth/callback
JOBBER_GRAPHQL_URL=https://api.getjobber.com/api/graphql
JOBBER_API_VERSION=2026-03-10
JOBBER_AUTH_URL, JOBBER_TOKEN_URL
JOBBER_PAGE_DELAY_MS              # ms between paginated Jobber queries
THROTTLE_COOLDOWN_SECONDS         # invoicePoller backoff (default 120s); jobberClientSync hard-codes 600s

# Twilio
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER               # display only; all sends use TwilioCredential.fromNumber (or a Messaging Service)
TWILIO_FROM_NUMBER                # env fallback sender
TWILIO_MESSAGING_SERVICE_SID      # optional MG... — used INSTEAD of a from-number
SMS_SEGMENTS_PER_SECOND           # pacing for a single number (default 1 = long code rate)
SMS_MESSAGING_SERVICE_SEGMENTS_PER_SECOND  # pacing when a Messaging Service is set (default 10)
SMS_MIN_DELAY_MS                  # floor on the gap between sends

# Gmail
GMAIL_USER, GMAIL_APP_PASSWORD
GMAIL_REDIRECT_URI
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI, GOOGLE_LOGIN_REDIRECT_URI

# Weather
OPENWEATHER_API_KEY
WEATHER_CITY                      # default city override

# SEO / Analytics
GOOGLE_API_KEY
GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY  # service account
SERPER_API_KEY                    # competitor SERP lookups
SEO_TRIGGER_SECRET                # webhook secret for manual SEO run
GA                                # GA4 property ID shorthand

# AI
ANTHROPIC_API_KEY                 # Claude API for SEO deep analysis

# Other
REVIEW_DELAY_MINUTES=60
REVIEW_LINK                       # Google review URL
POLL_INTERVAL_MINUTES, POLL_WINDOW_MINUTES, MAX_PAGES_PER_POLL, PAGE_DELAY_MS
REFERRAL_BASE_URL, REFERRAL_REDIRECT_URL
FTP_ENCRYPTION_KEY                # AES key for stored FTP passwords
ALERT_EMAIL                       # admin alert address
SLACK_WEBHOOK_URL                 # optional Slack notifications

# AI OS
AI_TOKEN                          # bearer for Claude routines calling /api/ai (falls back to OPERATOR_TOKEN)
OPERATOR_TOKEN, OPERATOR_USER_ID  # operator API + the portal user the AI OS acts as
OPERATOR_APPROVER_PHONE           # owner's phone for approvals / urgent customer alerts
BUSINESS_TZ=America/Winnipeg      # crons, day boundaries, social caps
CHROMIUM_PATH                     # optional chromium for the graphic renderer (else Playwright's / @sparticuz/chromium)
TWILIO_SKIP_SIGNATURE             # local dev only
```

