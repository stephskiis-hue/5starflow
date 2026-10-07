# TextNow → 5StarFlow: export every number, then monitor the line

## Context
The owner ran the business on a TextNow number. We want to (1) pull every conversation's phone number (plus message history) into 5StarFlow as a contact/campaign list, and (2) keep monitoring that number so new TextNow texts show up in the 5StarFlow inbox and raise "waiting on a reply" tasks, just like Twilio SMS does. TextNow has no public API, so we drive TextNow web (`https://www.textnow.com/messaging`) with Playwright. Decisions: runs on the **MSI PC** (always on, Task Scheduler). Monitoring is **read-only for now**, and the design leaves room for sending replies through TextNow later.

## Approach
**Read TextNow's JSON, not the page.** The web app loads conversations and messages from its own JSON endpoints (`/api/users/<username>/...`). The worker opens the page and records those responses with `page.on('response')`, then scrolls the conversation list and each thread until it reaches the start. This holds up better than scraping CSS selectors. Phase 0 confirms which endpoints and fields are real.

**Login stays on the owner's side.** The first run opens a visible browser with a persistent profile (`%LOCALAPPDATA%\5starflow\textnow-profile`), and the owner logs in by hand. Claude never types the password. Later runs use the same profile in headless mode. If the session expires or a captcha shows up, the worker stops and reports `needs_login` to 5StarFlow, which raises a Task. It never tries to get past the captcha. Pacing stays human-like: one sweep every 5 minutes, with a pause of about 1–2 s between requests.

### Phase 0: Discovery spike (on the MSI, 30 min)
- Use `scripts/textnow/probe.js` (headed) to log in, record every `textnow.com/api` response to a HAR/JSON file, and write down the endpoints, the pagination cursor, and the fields for contact number, contact name, message id, direction, and timestamp.
- Check whether headless runs with the saved profile get through. If they're blocked, fall back to headed with the window minimized. That's fine on the MSI.

### Phase 1: One-time full export (the "scrape every number" request)
- `scripts/textnow/export.js` (Node + Playwright, same style as `services/browserAuth.js`):
  - Walk every conversation and every message in it.
  - Write `textnow-export-<date>.csv` (number E.164, name, first/last message date, message count, last message in/out) and `.json` (the full threads) on the MSI. You get a usable file even before any server work.
  - POST batches to prod: `POST /api/ai/textnow/ingest` (bearer `AI_TOKEN`, the same pattern the MSI gate uses with `FIVESTARFLOW_URL`/`FIVESTARFLOW_TOKEN`).
- Skip short codes (5–6 digits), TextNow system/verification senders, and the owner's own numbers.

### Phase 2: Server side (backend, in this repo)
- **`routes/ai.js`**: add `POST /textnow/ingest`. It takes `{ messages:[{id, phone, name, direction, body, at}], conversations:[...] }`, then:
  - Calls `logComm(userId, { channel:'textnow', direction, phone, body, providerId:'tn:'+id, source:'textnow', clientName, at })` from `lib/commLedger.js`. It's idempotent: the upsert on `providerId` dedupes, so the same backfill can run again safely.
  - Upserts each number into the contact list (below) and matches it to `CachedJobberClient` by last-10 phone digits (`last10` in `lib/commLedger.js`) to attach `jobberClientId`/name.
  - Records the run with `recordActivity` (`ai/ledger.js`).
- **Contact/campaign list**: check `prisma/schema.prisma` and `routes/marketing.js` for an existing non-Jobber contact or manual-audience model. Reuse it if there is one. If not, add a `MarketingContact` model `{userId, phone (E.164), phoneKey, name, source:'textnow', jobberClientId?, firstSeenAt, lastSeenAt, messageCount, consentBasis, consentAt}` with `@@unique([userId, phoneKey])`, then run `npx prisma migrate dev --name textnow_contacts`. Add a "TextNow contacts" audience option in `marketing.html`/`routes/marketing.js` that sits next to the Jobber-client audiences.
- **Consent gate (CASL, Manitoba):** a number counts as campaign-eligible only with implied consent. That means a past customer (Jobber match, or a job in the last 2 years) or an inquiry in the last 6 months, based on `lastSeenAt`. Store `consentBasis` and expiry, and exclude expired or unknown numbers from campaign audiences by default. All sends still go through `sendSmsSafely` and check `isOptedOut`. A TextNow thread that contains STOP/unsubscribe is imported as opted out.
- **Monitoring comes for free:** `ai/smsMonitor.js` builds tasks from `getConversationStates()` in `ai/comms.js`. Check whether that function filters on `channel:'sms'`. If it does, widen it to include `'textnow'` so TextNow texts raise "X is waiting on a reply" tasks and urgent owner alerts with no new monitor logic. Tag the task "via TextNow" so the owner knows where to reply.
- **Heartbeat:** register a `textnow-sync` routine in `ai/registry.js` (an external/desktop routine like the MSI gate). `ai/heartbeat.js` then raises a Task if the MSI stops checking in, which covers expired logins and a powered-off PC.

### Phase 3: Ongoing monitor on the MSI
- `scripts/textnow/sync.js --since <cursor>`: headless, pulls only conversations updated since the last cursor (stored in a local state file), then posts to the same ingest endpoint. It reports `needs_login` / `blocked` / `ok` counts.
- A Task Scheduler job every 5 min, next to `request-gate.ps1`, using the same env file and the same lock-file pattern so runs never overlap.

### Later: replies through TextNow (not built now)
- An outbound queue: 5StarFlow creates `CommMessage` rows with `status:'pending', channel:'textnow'`, the MSI worker types and sends them in TextNow web, then marks them sent. This is held behind its own flag and the existing approval rules. It's left out of this build on purpose.

## Files
- New: `scripts/textnow/{probe,export,sync}.js`, `scripts/textnow/README.md` (MSI setup, first login, Task Scheduler line)
- Edit: `backend/routes/ai.js` (ingest), `backend/ai/comms.js` (channel filter, if needed), `backend/ai/registry.js` (routine), `backend/prisma/schema.prisma` + migration (contacts, if no existing model), `backend/routes/marketing.js` + `backend/marketing.html` (TextNow audience)
- Reuse: `logComm`/`last10` (`lib/commLedger.js`), `createTask` (`ai/tasks.js`), `recordActivity` (`ai/ledger.js`), `sendSmsSafely`/`isOptedOut`, the Playwright CDP pattern in `services/browserAuth.js`

## Risks
- Automating TextNow is against its ToS, so the account could be flagged or the number lost. Running from one home IP at a slow pace with a real profile keeps the risk low, not zero. **Do the Phase 1 export first** so the contact list is safe whatever happens next.
- TextNow can change its internal endpoints at any time. The heartbeat and `needs_login`/`blocked` Tasks make a breakage show up right away.

## Verification
1. Phase 0: the probe log shows conversation and message endpoints. A headless run with the saved profile returns at least one page of conversations.
2. Export: the CSV row count matches the conversation count in the TextNow sidebar. Spot-check 5 numbers and names.
3. Ingest: send the same batch twice to the local backend (`DRY_RUN=true`, local DB, never the Railway `DATABASE_URL`). The second run creates 0 new `CommMessage` rows, and contacts are matched to Jobber clients where the phones match.
4. Monitor: text the TextNow number from another phone. Within about 5 min a `channel:'textnow'` CommMessage shows up, and after 10 min `smsMonitorTick` opens a "waiting on a reply" Task. Replying in TextNow closes it on the next sweep.
5. The marketing audience preview shows TextNow contacts with the expired-consent and opted-out ones excluded.
6. Merge to main when done (per standing preference).
