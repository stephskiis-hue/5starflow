# 5StarFlow AI Operating System

5StarFlow is the **memory, control layer, task list, approval queue, content vault and activity log** for No-Bs Yardwork.
Normal code does the deterministic work. Claude routines (the "agents") reason, write and drive Chrome. The backend never
calls the Anthropic API for these agents; the routines call the backend (`/api/ai/*`).

```
Claude routines (claude.ai, MSI PC)  ──Bearer AI_TOKEN──▶  /api/ai/*  ──▶ Postgres
   Night Studio · Social Shift · Inbox Watch · Morning Brief ·            Routine, RoutineRun, Task, Memory, AgentActivity,
   the 9 existing business routines                                        ContentAsset, ContentItem, SocialGroup, SocialAction, CommMessage
Backend schedulers (all wrapped by runRoutine) ────────────────────────▶ same ledger
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
| Vault | `POST/GET /assets` · `GET /assets/:id` · `PATCH /assets/:id` · `DELETE` (owner) |
| Content | `GET /content/layouts` · `POST /content/lint` · `POST /content/preview` (PNG) · `GET/POST /content` · `PATCH /content/:id` · `POST /content/:id/render|approve|reject|published|metrics` · `GET /content/queue` · `GET /content/performance` |
| Social | `GET /social/budget` · `GET/POST /social/actions` (409 at the daily cap) · `GET/POST /social/groups` · `GET /social/groups/next` |

## Design system → graphics
`ai/design/` holds the No-Bs Yardwork design system exported from the claude.ai artifact: `tokens.json`, vendored fonts + logos, and the 12 layout templates (`layouts/<Name>.html` + `.md` slot docs). `renderer.js` fills `data-slot` markers and screenshots 1080×1350 / 1080×1920 / 1080×1080 PNGs (~150 ms each). `qa.js` is the deterministic brand lint (no prices, no mid-sentence dashes, exact name, phone, banned words). To re-sync after the design system changes: re-export `project/tokens.json` and `project/components/*/preview.html`, replace the files here, re-run the render smoke (all 12 layouts) and eyeball them.
Chromium: Railway builds `backend/Dockerfile` (official Playwright image, Chromium and its system libraries included). Dev uses `npx playwright install chromium`; `CHROMIUM_PATH` and `@sparticuz/chromium` remain as fallbacks.
No owner approval: a render that passes QA (brand lint, a source URL for tip/seasonal posts, text that fits the canvas) goes straight to `queued` and the owner gets a Notification Centre note; anything else is `qa_failed` for the Content Director to fix. The owner can pull a post. The `ext-social-daily` autonomy (execute) is the pause switch for posting.

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
