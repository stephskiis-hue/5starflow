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
| Inbox | `GET /inbox/unanswered-sms` · `GET /customers/context` |
| Vault | `POST/GET /assets` · `GET /assets/:id` · `PATCH /assets/:id` · `POST /assets/:id/edit` · `DELETE` (owner) |
| Content | `GET /content/layouts` · `POST /content/lint` · `POST /content/preview` (PNG) · `GET/POST /content` · `PATCH /content/:id` · `POST /content/:id/render|approve|reject|published|metrics` · `GET /content/queue` · `GET /content/performance` |
| Social | `GET /social/budget` · `GET/POST /social/actions` (409 at the daily cap) · `GET/POST /social/groups` · `GET /social/groups/next` |

## Design system → graphics
`ai/design/` holds the No-Bs Yardwork design system exported from the claude.ai artifact: `tokens.json`, vendored fonts + logos, and the 12 layout templates (`layouts/<Name>.html` + `.md` slot docs). `renderer.js` fills `data-slot` markers and screenshots 1080×1350 / 1080×1920 / 1080×1080 PNGs (~150 ms each). `qa.js` is the deterministic brand lint (no prices, no mid-sentence dashes, exact name, phone, banned words). To re-sync after the design system changes: re-export `project/tokens.json` and `project/components/*/preview.html`, replace the files here, re-run the render smoke (all 12 layouts) and eyeball them.
Chromium: Railway builds `backend/Dockerfile` (official Playwright image, Chromium and its system libraries included). Dev uses `npx playwright install chromium`; `CHROMIUM_PATH` and `@sparticuz/chromium` remain as fallbacks.
No owner approval: a render that passes QA (brand lint, a source URL for tip/seasonal posts, text that fits the canvas) goes straight to `queued` and the owner gets a Notification Centre note; anything else is `qa_failed` for the Content Director to fix. The owner can pull a post. The `ext-social-daily` autonomy (execute) is the pause switch for posting.
Placement (owner rule, `placementErrors` in `ai/content.js`): tips/advice = Facebook stories, ads = reels (Facebook + Instagram), Instagram = reels only. Reels: the queue hands the Social agent the PNG frames to post as a photo Reel with in-app music, plus an MP4 fallback made by `ai/design/reel.js` (ffmpeg, installed in the Dockerfile).

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
`DRIVE_IMPORT_PER_RUN` (30) photos: anything new since the last sync first, then one page of the older backlog
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
