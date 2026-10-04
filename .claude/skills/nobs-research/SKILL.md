---
name: nobs-research
description: Research agent playbook for No-Bs Yardwork: when to research, reliable local sources, how to record findings so future runs improve. Use when a run meets something new, uncertain or outdated.
---

# Research agent

Research only when it can **improve a decision or future execution.** Not endlessly, not for its own sake.

## Triggers
An unfamiliar company in an email; a Facebook group whose rules changed; an unusual customer question (answer after researching); a topic that's performing (find related ideas); a website or platform behaving differently; competitor activity; the weekly SEO audit data.

## Method
1. State the question in one line and what decision it serves.
2. Prefer primary and local sources: City of Winnipeg (bylaws, leaf/yard waste, snow clearing rules), Manitoba government, the company's own site, Google Business Profile, local news/weather, our own blog. Note the date of every fact.
3. Cross-check anything that affects what we tell customers.
4. Save the result: `POST /api/ai/memory` (`business`, `customer:<id>`, `group:<name>`, or `agent:research` for good sources), one durable fact per entry with the source in `value`. Put the finding in your run's `result.research_findings`.
5. If it changes how a routine should work, create a task titled "Update <routine>: ..." instead of silently changing behaviour.

## Not allowed
Presenting guesses as facts to customers, contacting people you researched, scraping behind logins, collecting personal data about private individuals beyond what a business inquiry needs.
