# AI OS: what is left

## Needs the owner (outward-facing, not done by code)
- [ ] Railway env: `AI_TOKEN`, `OPERATOR_USER_ID`, `APP_URL`, `BUSINESS_TZ`. Confirm `DRY_RUN` is what you want in prod.
- [ ] claude.ai environment: network allowlist for the Railway domain + Bearer credential + `FIVESTARFLOW_URL` (see `ai/prompts/README.md`).
- [ ] Routine changes on claude.ai (prompts in `ai/prompts/`): create Night Studio + Inbox Watch; replace the Social routine prompt and re-enable it; replace the Runner prompt; stop Saturday 12:00 UTC pile-up; Sonnet for finance/digest runs; stale-visit cron only on days it acts.
- [ ] After the first run of each routine reports in, set its `expectedEveryMinutes` (Routines tab → API) so the heartbeat can flag silence.
- [ ] Confirm: do you reply to customers from Jobber/your phone (ledger can't see those)? Where does the website contact form go? Google OAuth app Testing vs Production (Gmail read scope)?
- [ ] Verify the graphic renderer on Railway (chromium); fall back to rendering on the MSI if needed.

- [ ] SEO Growth Engine: add the service account as a **Full** user in Search Console; Railway `SEO_SUBMIT=on`, `GSC_SITE_URL`, confirm `SERPER_API_KEY`; then on the MSI follow `docs/seo/windows-setup.md` (sitemap + blog-index hooks in `_deploy.py`, site fixes, new blog task prompt).

## Code
- [ ] Gmail monitor in the backend: the `gmail.readonly` reader exists now (`ai/etransfer/gmail.js`, Interac deposits only) and can be reused for client email; Inbox Watch still uses the Gmail connector for everything else.
- [ ] E-transfer matcher go-live: publish the Google OAuth app to Production (Testing-mode refresh tokens expire after 7 days), reconnect Gmail, check the backfill score on the E-transfers tab ("wrong" must be 0), make sure Jobber is signed in on the MSI Chrome, then switch to live.
- [ ] Website inquiries: register Jobber `REQUEST_CREATE` webhook → CommMessage/Task; or a form endpoint.
- [ ] `customers/context`: add live Jobber jobs/quotes/invoices (capped query with `first:`), email identity (`ClientIdentity`).
- [ ] Import the Google "Claude Ops Log" sheet once (FlagLog → Tasks, Corrections/PayrollHistory → Memory, ActionLog/Recovered → Activity).
- [ ] Port deterministic cores of the money routines into backend `run(ctx)` (stale-visit auto-mark, invoice buckets, payroll hours) so they stop depending on the plan limit.
- [ ] Metrics loop: Social agent records `POST /content/:id/metrics`; Content Director weights layouts/pillars by `/content/performance` (endpoint exists, routine prompt uses it).
- [ ] Per-routine autonomy ratchet UI (read → draft → approve → execute) with auto-suggest after N clean runs.
- [ ] Facebook group memory UI (edit rules/promo policy from the dashboard).
- [x] Pure-logic unit tests (`npm test`, 15 tests: classifier, QA lint, renderer validation/escaping, tz, ledger). Still missing: DB-backed tests for caps, task dedup, publish flow (verified by smoke scripts only).
- [ ] marketing.html (from the merged SMS-status branch): campaign progress poll never stops for rows that never get a delivery receipt, and the conversation thread doesn't show `deliveryStatus` (a carrier-rejected direct reply looks sent).
- [ ] SEO: neighbourhood evidence from real jobs (capped Jobber query of property postal codes per area) to gate area pages; year-over-year seasonality from `SeoQueryMonth` once 12 months exist.
- [ ] Re-run the adversarial review's verification stage: it hit a session limit, so only the security findings got the full 3-skeptic vote; the others were checked by hand and fixed.
