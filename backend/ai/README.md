# 5StarFlow AI Operating System

5StarFlow is the **memory, control layer, task list, approval queue, content vault and activity log** for No-Bs Yardwork.
Normal code does the deterministic work. Claude routines (the "agents") reason, write and drive Chrome. The backend never
calls the Anthropic API for these agents; the routines call the backend (`/api/ai/*`).

```
Claude routines (claude.ai, MSI PC)  ──Bearer AI_TOKEN──▶  /api/ai/*  ──▶ Postgres
   Night Studio · Social Shift · Inbox Watch · Morning Brief ·            Routine, RoutineRun, Task, Memory, AgentActivity,
   the 9 existing business routines                                        ContentAsset, ContentItem, SocialGroup, SocialAction, CommMessage
Backend schedulers (all wrapped by runRoutine) ────────────────────────▶ same ledger
Ollama worker on the MSI (scripts/ollama-worker.js, drafts only) ──────▶ same ledger
Dashboard: /ai.html (admin session)
```

## Execution model
`runRoutine(slug, tick)` wraps every job: trigger → execute → structured result `{status, items_found, requires_attention, summary, actions_taken, learnings, research_findings, items}` → ledger → learnings into Memory (only structured, durable facts). Per-routine mutex + DB lease; failures classified (`rate_limit | throttled | auth | network | validation | unknown`); 3 consecutive failures create an urgent Task. `quiet` routines (every-minute jobs) only write a run row when something happened. `ai/heartbeat.js` flags any routine that should have reported and didn't.

## API (all under `/api/ai`, bearer or admin session; owner-only = admin session)
| Area | Endpoints |
|---|---|
| Work packet | `GET /brief?agent=` · `GET /status` |
| Routines | `GET /routines` · `GET /routines/:slug` · `PATCH /routines/:slug` (owner) · `POST /routines/:slug/run` · `POST /runs` · `GET /runs` |
| Tasks | `GET/POST /tasks` (idempotent on `dedupKey`) · `PATCH /tasks/:id` |
| Memory | `GET/POST /memory` (upsert by scope+key) · `DELETE /memory/:id` (owner) |
| Activity | `GET/POST /activity` |
| Approvals | `GET /approvals` · `POST /approvals/:id/respond` (owner) |
| Inbox | `GET /inbox/unanswered-sms` (`?channel=textnow` for the TextNow line) · `GET /customers/context` |
| TextNow (read-only) | `GET /textnow/cursor` · `POST /textnow/ingest` · `POST /textnow/health` · `GET /textnow/status` · `GET /textnow/threads?days=&limit=&offset=` · `POST /textnow/insights` · `GET /textnow/readiness` · `POST /textnow/digest` |
| Vault | `POST/GET /assets` · `GET /assets/:id` · `PATCH /assets/:id` · `POST /assets/:id/edit` · `DELETE` (owner) |
| Content | `GET /content/layouts` · `POST /content/lint` · `POST /content/preview` (PNG) · `GET/POST /content` · `PATCH /content/:id` · `POST /content/:id/render|approve|reject|published|metrics` · `GET /content/queue` · `GET /content/performance` |
| Social | `GET /social/budget` · `GET/POST /social/actions` (409 at the daily cap) · `GET/POST /social/groups` · `GET /social/groups/next` |
| SEO | `GET /seo/recent-jobs` · `POST /seo/recent-jobs/backfill` (owner) · `POST /seo/recommendations/refresh` · `POST /seo/recommendations/:id/dismiss` (owner) · `GET /seo/focus` · `POST/PATCH /seo/keywords/:id/focus` (owner) · `GET /seo/assignment?modes=` · `POST /seo/assignment/:id/skip` · `POST /seo/published` · `GET/POST /seo/keywords` · `PATCH /seo/keywords/:id` (owner) · `GET /seo/pages` · `GET /seo/progress` · `GET/POST /seo/reports` · `POST /seo/sitemaps/check` · `GET /seo/gsc-status` · `GET /seo/site-access` · `POST /seo/site-access/verify|htaccess|htaccess/revert` · `PATCH /seo/config` (owner) |

## TextNow Watch (`ai/textnow.js`, `lib/textnow.js`, `scripts/textnow-watch.js`, `prompts/textnow-insight.md`)
The owner's TextNow line (textnow.com/messaging) is read by a script on the MSI PC and written into the same `CommMessage` ledger as Twilio (`channel: 'textnow'`, `providerId` = TextNow message id, so re-reads dedup). `comms.js` takes a `channel` option (default `sms`, so Twilio behaviour is unchanged); `sms-monitor` runs a second pass for TextNow and raises `textnow:<last10>` tasks.
- **Phase 1 is read-only.** Nothing ever sends to a customer on TextNow. The watcher (`local-textnow-watch`, no Claude) runs every 2 hours from 7 am to 9 pm via `msi/request-gate.ps1`. A daily Claude run (`ext-textnow-insight`, after 7 pm, Claude in Chrome) classifies each thread's intent, records the reply and action it WOULD have taken (`CommInsight`), learns FAQs, the owner's style and customer facts (memory scopes `channel:textnow`, `customer:<id>`), cross-checks the TextNow page and posts a summary.
- **Quiet by design.** The summary is texted every `digestEveryDays` days (routine config on `ext-textnow-insight`, default 2; set 1 for daily). Immediate texts only for a cancel/skip for a near date, complaint or damage wording (`urgentCheck`, once per thread per day), and a broken watcher (once per day). Everything else is the Inbox tab card and the brief (`inbound.textnow`).
- **Earning autonomy (Phase 2).** `textnow-shadow-score` (hourly) compares each draft with what the owner actually sent (`agreementScore`); `GET /textnow/readiness` shows cases and agreement per intent. An intent is suggested for more autonomy at 20+ cases and 90%+ agreement; the owner changes `config.intentAutonomy[intent]` (`read → draft → approve → execute`). Acting (cancel/skip in Jobber, replying through TextNow) is not built yet; it will go through `OperatorProposal` YES/NO approvals first.
- Both routines are registered disabled; the first healthy watcher run and the first summary switch their heartbeat on.

## Design system → graphics
`ai/design/` holds the No-Bs Yardwork design system exported from the claude.ai artifact: `tokens.json`, vendored fonts + logos, and the 12 layout templates (`layouts/<Name>.html` + `.md` slot docs). `renderer.js` fills `data-slot` markers and screenshots 1080×1350 / 1080×1920 / 1080×1080 PNGs (~150 ms each). `qa.js` is the deterministic brand lint (no prices, no mid-sentence dashes, exact name, phone, banned words). To re-sync after the design system changes: re-export `project/tokens.json` and `project/components/*/preview.html`, replace the files here, re-run the render smoke (all 12 layouts) and eyeball them.
Chromium: Railway builds `backend/Dockerfile` (official Playwright image, Chromium and its system libraries included). Dev uses `npx playwright install chromium`; `CHROMIUM_PATH` and `@sparticuz/chromium` remain as fallbacks.
No owner approval: a render that passes QA (brand lint, a source URL for tip/seasonal posts, text that fits the canvas) goes straight to `queued` and the owner gets a Notification Centre note; anything else is `qa_failed` for the Content Director to fix. The owner can pull a post. The `ext-social-daily` autonomy (execute) is the pause switch for posting.
Placement (owner rule, `placementErrors` in `ai/content.js`): tips/advice = Facebook stories, ads = reels (Facebook + Instagram), Instagram = reels only. Reels: the queue hands the Social agent the PNG frames to post as a photo Reel with in-app music, plus an MP4 fallback made by `ai/design/reel.js` (ffmpeg, installed in the Dockerfile).
Stories (guardrail, `storyAudited` in `ai/content.js`): `GET /content/queue` only hands out a story whose every frame passed the story audit (`qa.story`: 1080×1920, fills the frame, phone-legible text, clear of the safe zones). A story rendered before the audit, or with a frame count that no longer matches, is held back and re-rendered in the background; it comes back on the next queue call if it passes, else it lands in `qa_failed`. Never loosen this to get a post out — fix the layout.

## SEO Growth Engine (`ai/seo/`, `routes/aiSeo.js`, `seo-growth.html`)
Turns the daily blog into a keyword programme for no-bs-yardwork.com. Deterministic parts are code; Claude only writes.
- `seo-gsc-sync` (daily 6:07): Search Console `[date]` totals (headline numbers, include anonymized queries), `[date, query, page]` detail for `retentionDays`, monthly rollups back 16 months, `[page]` 28-day stats; then `roadmap.rescore`. Auth: service account with the `webmasters` scope (must be a **Full** user on the property), OAuth token as read-only fallback.
- Site access without the PC (`ai/seo/siteAccess.js`): when the service account can't see the property, the sync makes it an owner itself (Site Verification API, META tag on the homepage; the tag goes up over FTP when the server has the site's FTP login). `POST /seo/site-access/htaccess` applies the pc-request.md redirect block over FTP, checks the live table and puts the saved copy back on any 5xx, loop or wrong target. `seo_site.py nightly` copies both into the PC's site folder so the 3 AM deploy keeps them.
- `seo-index-watch` (daily 6:23 + light run after every publish/deploy): crawls the live site and sitemaps, keeps `SeoPage`, submits changed sitemaps (respects DRY_RUN unless `SEO_SUBMIT=on`), URL-inspects new pages first (60/run of Google's 2000/day), IndexNow for new URLs (`INDEXNOW_KEY`), and raises/closes `seo:*` tasks (redirecting sitemap URLs, missing pages, canonicals, duplicates, broken links, www, orphan posts, not indexed after 14 days, cannibalization).
- `seo-roadmap` (Monday 6:37): seeds service + neighbourhood keywords, imports existing posts, Serper weekly rank + map-pack check for up to 30 keywords and Serper discovery (autocomplete, related, People also ask), budget `serperWeeklyBudget`.
- Keyword lifecycle `idea → planned → assigned → published → indexed → ranking → page1 → top3` (`stalled` after 60 days without gain, `retired` by the owner). `scoring.js` estimates extra clicks from the CTR curve (calibrated to the site) × intent × season (from `seasonal-calendar.md`). `assignPick.js` picks new post / refresh (max 2 a week) / landing page (max 1 a week, area pages gated by real demand); "service + Winnipeg" head terms are reserved for service pages.
- The writer is the MSI blog task (`ext-blog-autopilot`, prompt `ai/prompts/blog-autopilot.md`, skill `nobs-seo`, helper `ai/prompts/msi/seo_site.py`, setup `docs/seo/windows-setup.md`). The PC is the only thing that writes site files: `request-gate.ps1` runs `seo_site.py nightly` once a day after 7 pm (`ext-seo-site-nightly`), which rebuilds the sitemaps and blog index from the real files; the 3 AM deploy uploads them and the 6:23 index watch submits them.
- Weekly recap: the run writes the words, the server snapshots the numbers (`SeoProgressReport`).
- **Keyword research** (`ai/seo/research.js`, top of the Focus tab): every Monday, at the end of `seo-roadmap`, `researchTick` ranks the keywords Search Console shows people really searched and keeps up to `recommendMax` (5): page 2 (position 8-20), close to the top 3 (4-7), searches rising 1.5x over 4 weeks, searches with no page of their own, demand in a neighbourhood. At most 2 per service. Each carries a plain `why` built from the real numbers, the actual queries and (one Serper search each, only if the last check is a week old) who ranks above us. Stored in `growthState.recommendations`; the owner is notified of new ones. "Target" reuses `startFocus`; "Not now" hides a keyword for 8 weeks (`recDismissed`).
- **Recent jobs on pages** (`ai/seo/recentJobs.js`, Health tab, `recentJobs` growth config, off by default): each paid Jobber invoice becomes a `SiteJob` row (service from the line items, neighbourhood from the first 3 characters of the billing postal code via `FSA_AREAS`, month). Never a name, street or house number. `recordInvoice` runs from `reviewRequester` with its own small query, so a wrong field can not break review requests; `backfill` walks older invoices a few pages per weekly roadmap run (cursor in `growthState.jobsBackfill`). `GET /seo/recent-jobs` returns one entry per service page and neighbourhood page (jobs, a 4-month count, up to 3 real Content Vault photos matched by tag via `SERVICE_TAGS`, never AI images). `seo_site.py nightly` renders it between `<!-- 5sf:recent-jobs:start/end -->` markers just above the footer, downloads photos into `images/work/`, and empties the sections again when the switch is turned off.
- **Focus campaigns** (`ai/seo/focus.js`, rules in `focusRules.js`, `SeoFocusStep`, Focus tab): the owner focuses up to `focusMax` (3) keywords with a goal of top 3 or top 10. 5StarFlow plans the page, a round of supporting posts (from Search Console queries, People Also Ask, related searches, autocomplete and existing ideas, filtered to the same topic; Claude may add researched ideas through `POST /seo/keywords` with `supportsId`), a refresh once the page is 21 days old and short of the goal, internal links, and one social post per live piece. The picker (`assignPick.js`) puts campaign pieces first (tier 1) while fewer than `focusPerWeek` went out in 7 days, and supporting posts wait for the focus page to be live. The brief gets a `focus` block and a rotating-anchor required link to the focus page (also for other posts in the same cluster). `advanceFocus` runs after every rescore, publish and crawl and judges each step from the database (page live, link seen in `SeoPage.linkedFrom`, content item citing the url), never from what Claude reported; it also writes milestones (top 10, goal reached, not moving) and notifies the owner. Night Studio gets `seoFocus.promote` in the content brief. `links` mode (editing an existing post) stays off until `focusLinks` is set in the growth config, because it needs the PC to republish an existing page.

## Guardrails that live in code (not prompts)
Daily social caps (`ai/social.js`), QA gate before content can be queued (no owner approval for content), owner-only approvals for everything else, task/memory dedup, opt-out (`isOptedOut`) on every customer SMS, Twilio signature validation on public webhooks, DRY_RUN blocks Jobber writes, Winnipeg-timezone crons.

## Status
Done: M0 security + correctness fixes · M1 registry/ledger/tasks/memory/activity/heartbeat/API/dashboard · M2 renderer, QA, vault, content pipeline, social caps/groups, Content/Social/Vault tabs, skills + prompts · M3 communication ledger, conversation states, SMS monitor, Twilio reconcile.
Next (see `ai/TODO.md`): create/update the Claude routines (needs the owner), Gmail monitor, website inquiries, Jobber context in `customers/context`, measured-content learning loop, autonomy ratchet.
Known limits: single-tenant (OPERATOR_USER_ID); in-process mutex + DB lease (one Railway replica); Gmail is send-only in the backend (Inbox Watch reads Gmail through the connector).

## Local dev
Use a **separate** Postgres (never the Railway URL; the schedulers act on whatever DB they see). `DRY_RUN=true`, `TWILIO_SKIP_SIGNATURE=true` if testing inbound by hand, `SESSION_SECRET` ≥ 32 chars, `AI_TOKEN`, `OPERATOR_USER_ID`. `npx prisma migrate deploy` then `npm run dev`.

## Notifications
Nothing texts or emails the owner daily. Every update goes through `lib/notify.js` into the Notification Centre (top of the home page). Only `urgent: true` items are texted immediately (approvals, rain reschedule, customer waiting 24h+, auth failures, failed/stuck owner requests). The rest is summed up in one weekly text (`ai/digest.js`, default Saturday 3 pm, editable in the Notification Centre). Claude routines post with `POST /api/ai/notify`.

## Google Drive photo import
`ai/driveImport.js` (routine `vault-drive-import`, nightly 1:30 am, before the Night Studio) reads the Drive connected on
the Connections page (`routes/drive.js`, scope `drive.readonly`, `DriveCredential`). Each run imports up to
`DRIVE_IMPORT_PER_RUN` (12) photos: anything new since the last sync first, then one page of the older backlog
(`backfillPageToken`) until the whole Drive has been seen. Code only drops facts-based rejects (short edge under 600px, screenshots,
over 15 MB, black or blown-out frames); the curator judges the rest.
Every photo is stored twice: the untouched original (`kind: 'original'`, hidden from listings) and an enhanced copy
(`ai/enhance.js`: EXIF rotation, auto levels only when dull or badly exposed, light saturation and sharpening, ≤2048px JPEG,
all metadata stripped including GPS) with `originalId` pointing at it. `POST /assets/:id/edit` re-runs the enhancement from
the original with straighten/rotate/crop/brightness/saturation, or `{revert: true}`. Deleting a Drive photo leaves an empty
`kind: 'skipped'` marker so the import doesn't bring it back.
Setup: enable the Drive API on the Google OAuth client, add the redirect URI `<APP_URL or localhost>/api/drive/callback`
and set `GOOGLE_DRIVE_REDIRECT_URI`. `drive.readonly` is a restricted scope: while the OAuth app is in Testing mode
Google expires the refresh token after 7 days (the routine then fails with "reconnect it on the Connections page").
Storage: photo bytes live in Postgres, whose Railway volume is small. The import stops once the vault holds
`VAULT_MAX_MB` (default 150) and says so on the Connections card; originals are capped at 3072px. On 2026-10-05
an unbounded first import filled the volume and Postgres would not start.
