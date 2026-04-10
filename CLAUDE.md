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
    webhook.js                   — POST /webhook/jobber + POST /webhook/twilio (inbound SMS)
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

## Absolute Rules
1. Jobber GraphQL header required: `X-JOBBER-GRAPHQL-VERSION: 2026-03-10`
2. `account_id` and `exp` are in the JWT payload — NOT in Jobber token response body. Decode: `JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())`
3. Webhook payload path: `payload.data.webHookEvent.{topic, itemId, accountId}`
4. Invoice status field is `invoiceStatus` (type: `InvoiceStatusTypeEnum`) — NOT `status`
5. `DRY_RUN=true` in `.env` during development — set false only to go live
6. `FRONTEND_ORIGIN=http://localhost:3001` — dashboard is local only, ngrok is server-only
7. Always run `npx prisma migrate dev --name <name>` after any schema change
8. HMAC webhook signature uses `JOBBER_CLIENT_SECRET` as the key
9. **Jobber query cost limit is 10,000 pts.** Always add `first:` on ALL nested connections in GraphQL queries or queries will be rejected before running (each uncapped connection assumes 100 nodes = instant budget exhaustion).

## Known Working Patterns
- Token refresh: decodes JWT `.exp` for expiry — Jobber does not return `expires_in`
- Webhook dedup: `PendingReview.invoiceId` is `@unique` — Prisma P2002 = already queued, silent skip
- Delivery dedup: `ReviewSent.clientId` is `@unique` — prevents re-sending to same client
- Throttle handling: 429 is NOT retried immediately (removed from RETRYABLE_STATUS). `jobberClientSync.js` backs off 10 min on 429. `invoicePoller.js` backs off 120s.
- Adaptive query cost: `jobberGraphQL({ returnExtensions: true })` returns `extensions.cost.throttleStatus` — use `currentlyAvailable / restoreRate` to compute adaptive delay between pages
- Jobber client sync: `jobberClientSync.js` runs every 4h at :15 (avoids :00 overlap with invoicePoller). Startup delay 3 min. Live polling via GET `/api/marketing/sync-status` (polls every 3s in UI).
- Inbound SMS: POST `/webhook/twilio` — matches sender phone to `CachedJobberClient`, updates `InboundSMS`, auto-handles STOP opt-out
- `allowReviewRequest` field on Invoice — Jobber's own boolean for review eligibility

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
THROTTLE_COOLDOWN_SECONDS         # override default 600s throttle backoff

# Twilio
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER               # review request number
TWILIO_FROM_NUMBER                # marketing number (may differ)

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
```
