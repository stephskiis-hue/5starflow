# AI OS: what is left

## Needs the owner (outward-facing, not done by code)
- [ ] Railway env: `AI_TOKEN`, `OPERATOR_USER_ID`, `APP_URL`, `BUSINESS_TZ`. Confirm `DRY_RUN` is what you want in prod.
- [ ] claude.ai environment: network allowlist for the Railway domain + Bearer credential + `FIVESTARFLOW_URL` (see `ai/prompts/README.md`).
- [ ] Routine changes on claude.ai (prompts in `ai/prompts/`): create Night Studio + Inbox Watch; replace the Social routine prompt and re-enable it; replace the Runner prompt; stop Saturday 12:00 UTC pile-up; Sonnet for finance/digest runs; stale-visit cron only on days it acts.
- [ ] After the first run of each routine reports in, set its `expectedEveryMinutes` (Routines tab → API) so the heartbeat can flag silence.
- [ ] Confirm: do you reply to customers from Jobber/your phone (ledger can't see those)? Where does the website contact form go? Google OAuth app Testing vs Production (Gmail read scope)?
- [ ] Verify the graphic renderer on Railway (chromium); fall back to rendering on the MSI if needed.

## Code
- [ ] Gmail monitor in the backend (needs `gmail.readonly` + Production OAuth) — until then Inbox Watch uses the Gmail connector.
- [ ] Website inquiries: register Jobber `REQUEST_CREATE` webhook → CommMessage/Task; or a form endpoint.
- [ ] `customers/context`: add live Jobber jobs/quotes/invoices (capped query with `first:`), email identity (`ClientIdentity`).
- [ ] Import the Google "Claude Ops Log" sheet once (FlagLog → Tasks, Corrections/PayrollHistory → Memory, ActionLog/Recovered → Activity).
- [ ] Port deterministic cores of the money routines into backend `run(ctx)` (stale-visit auto-mark, invoice buckets, payroll hours) so they stop depending on the plan limit.
- [ ] Metrics loop: Social agent records `POST /content/:id/metrics`; Content Director weights layouts/pillars by `/content/performance` (endpoint exists, routine prompt uses it).
- [ ] Per-routine autonomy ratchet UI (read → draft → approve → execute) with auto-suggest after N clean runs.
- [ ] Facebook group memory UI (edit rules/promo policy from the dashboard).
- [ ] Unit tests for `classifyConversation`, `lintContent`, `recordAction` caps (currently verified by smoke scripts only).
