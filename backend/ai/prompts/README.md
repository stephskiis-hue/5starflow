# Routine prompts + setup

These are the prompts for the Claude routines that act as the agents. They are deliberately short: the knowledge lives in the repo skills (`.claude/skills/nobs-*`) and the work packet from `GET /api/ai/brief`, so each run uses fewer tokens than the old self-contained prompts.

## One-time setup (the owner does these; secrets are never put in prompts)
1. **Railway env vars** (Variables tab): `AI_TOKEN` (long random string), `OPERATOR_USER_ID` (your portal user id), `APP_URL` (public URL; Twilio signature checks need it), `BUSINESS_TZ=America/Winnipeg`. Keep `DRY_RUN=false` only on Railway.
2. **Cloud routines (claude.ai environment settings)**:
   - Network access: **Custom**, add your Railway domain.
   - Add an API credential: type Bearer, header `Authorization`, value = the same `AI_TOKEN`, allowed website = your Railway domain (Pro/Max plans). Otherwise set the token as an environment variable `FIVESTARFLOW_TOKEN` on the environment.
   - Environment variable `FIVESTARFLOW_URL` = `https://<your-app>.up.railway.app`.
   - Attach the GitHub repo as a source so `.claude/skills/nobs-*` load in the run.
3. **MSI desktop routine** (Claude in Chrome): put `FIVESTARFLOW_URL` and `FIVESTARFLOW_TOKEN` in a local env file the routine sources (e.g. `~/.5starflow/env`); keep Chrome logged into the page account and leave the PC awake.
4. In the dashboard (AI Command → Routines) check each routine reports after its first run. Then set `expectedEveryMinutes` so the heartbeat can flag a silent routine.

## Frugality rules (the weekly plan limit is the constraint)
- Fetch `/api/ai/brief` instead of crawling; do nothing and report `skipped` when the brief shows nothing to do.
- Sonnet for routine/triage runs; Opus only for Night Studio (creative strategy).
- Never schedule several routines in the same minute.
- A routine that finds nothing to do should exit in seconds.

## Owner request inbox (event-gated, zero tokens when idle)
A Claude routine that wakes on a timer pays 20-40k tokens just to load context, even when there is nothing to do. So `ext-request-inbox` is not scheduled in Claude. Instead `prompts/msi/request-gate.ps1` runs from Windows Task Scheduler on the MSI PC (every 10 minutes, 6 am to 10 pm, "run whether user is logged on or not"), calls `GET /api/ai/requests/pending-count` (a single DB count), and only launches `claude -p ... --chrome --dangerously-skip-permissions --model sonnet` with the prompt from `request-inbox.md` when the count is above 0. Leave `expectedEveryMinutes` empty for this routine.
