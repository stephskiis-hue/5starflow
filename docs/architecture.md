# Architecture

```
Claude routines / Claude app tasks (the departments)  --HTTPS + bearer-->  /api/ai/*  --> Postgres
Backend schedulers (wrapped by runRoutine)             ------------------------------->  same ledger
Dashboard /ai.html (AI Command)
```
5StarFlow is the memory, task list, approval queue, content vault, activity log and learning store. Claude is the reasoning layer; Claude in Chrome (Browser 2 = the MSI PC) is the hands for Facebook. Details: `backend/ai/README.md`; routines: `backend/routines/README.md`; agents: `.claude/agents/`; how the system learns: `ai/learning/` (price learner, run analysis) plus memory written by every agent.

Owner contact policy: the system never texts the owner per event. One summary text a day at 5 pm, only if something needs them (`ai/digest.js`).
Customer replies: the Communication agent replies itself; the server holds money topics (holding reply + the daily summary) and never answers complaints (`ai/reply.js`).
