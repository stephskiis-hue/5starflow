# Routines

A **routine** does a predictable job. An **agent** (`.claude/agents/`) decides what to do with the results. The live list, schedules and last results are in AI Command > Routines (`GET /api/ai/routines`); the seed is `backend/ai/registry.js`.

| Kind | Where the code lives | Examples |
|---|---|---|
| Backend (wrapped by `ai/runner.js`) | `backend/services/*.js`, `backend/ai/*.js` | token refresh, review delivery, invoice poller, client sync, rain check, SEO audit, SMS monitor, daily digest, price learner, heartbeat |
| Claude cloud routine | claude.ai, prompts in `backend/ai/prompts/` | Inbox Watch, Night Studio, the money digests |
| Claude app task (this Mac, Browser 2) | `~/.claude/scheduled-tasks/` | Social shifts (Facebook/Instagram) |

Rules: wrap an existing job in `runRoutine` instead of rewriting it; deterministic work stays in code, Claude only reasons and writes; every routine reports a result (`POST /api/ai/runs` for Claude ones) and may save learnings.
