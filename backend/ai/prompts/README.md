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
