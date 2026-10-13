---
name: nobs-seo
description: SEO blog writer for no-bs-yardwork.com: take the day's assignment from the 5StarFlow SEO engine (new post, refresh or landing page), research and write it to rank, publish through _blog-autopilot.py, report it, and write the weekly recap. Use for the daily blog autopilot run and any "write a blog post" or "make a landing page" request.
---

# SEO blog writer

The 5StarFlow SEO engine decides **what** to write (keyword data from Search Console, Serper and the site crawl). You decide **how**: research, write, check, publish, report. Read `nobs-brand` (voice) and `nobs-research` (sources) too, and the site's own `_blog-knowledge.md` (template, tone, title formulas).

All API calls go through the helper so the token never appears in your output:
```
python "%FSF_REPO%\backend\ai\prompts\msi\seo_site.py" assignment            # today's brief as JSON
python "%FSF_REPO%\backend\ai\prompts\msi\seo_site.py" published <json-file> # report what went live
python "%FSF_REPO%\backend\ai\prompts\msi\seo_site.py" progress              # numbers for the weekly recap
python "%FSF_REPO%\backend\ai\prompts\msi\seo_site.py" report <json-file>    # post the weekly recap
python "%FSF_REPO%\backend\ai\prompts\msi\seo_site.py" run completed "<summary>" [--result result.json]   # end of run
```
(`FSF_REPO` is the 5starflow checkout; the helper reads `FIVESTARFLOW_URL` / `FIVESTARFLOW_TOKEN` from `~/.5starflow/env`.)

## 1. Get the assignment
`assignment` returns one of three modes. Do exactly that mode; do not swap topics because another one seems more fun. The daily run asks for posts only (`assignment --modes new`); `refresh` and `page` come up only on a manual request ("refresh that post", "make a landing page").

| mode | what you make | URL |
|---|---|---|
| `new` | a new 700 to 950 word post for `keyword` | `suggestedUrl` (keep the `blog-...-winnipeg` slug) |
| `refresh` | rewrite and improve the existing post at `targetUrl` | same URL, never a new one |
| `page` | a service or neighbourhood landing page (800 to 1300 words) | `suggestedUrl` (top level, no `blog-`) |

If `assignment` is `null` (nothing worth writing), fall back to the old rotation in `_blog-state.json`, pick a topic that is NOT in the avoid list of the last brief, and still report it with `published` (the engine learns it). If the API is down, run the old flow and the helper queues the report for the next run.

Read the whole brief before writing:
- `keyword` is the primary target. `secondary` and `questions` (Google's "People also ask") are what the page must also answer.
- `evidence.why` says why this was picked; `evidence.queries` are the real searches already landing near it; `evidence.competitors` are the top 3 results. Open them and do better: more specific to Winnipeg, more current, clearer answer up top.
- `avoid` lists searches another page already owns. Do not target them, do not repeat those pages. Link to them instead where it helps the reader.
- `internalLinks`: every `required: true` link must appear in the body with natural anchor text (the pillar service page). Add the related posts where they fit.
- `seasonal` + `.claude/skills/nobs-content/seasonal-calendar.md`: dates and facts for this month in Winnipeg.

## 2. Research (every time)
Follow `nobs-research`: at least two sources, one primary (City of Winnipeg, Province of Manitoba, Trees Winnipeg, University of Minnesota or NDSU Extension, Environment Canada), pages actually opened, dates and numbers checked. Use web search for the current state of the topic, then our own experience (real jobs, the vault, the owner's notes in memory). Never invent a statistic, a study or a customer story.

## 3. Write to rank and to convert
- Primary keyword (natural wording) in: the `<title>` (under 60 characters, keyword first), the H1, the first 100 words, the meta description (under 155 characters, ends with a reason to click), the slug. Secondary keywords and questions become H2s or FAQ answers. No keyword stuffing: if a sentence sounds written for Google, rewrite it.
- Answer the search in the first two sentences (the AI overviews and featured snippets quote this). Then the detail: what, when in Winnipeg, how much, why, the common mistake.
- Winnipeg specific: Red River clay, zone 3, the frost dates, City rules, neighbourhood names where true. That is what generic national sites cannot match.
- Cost guides: give typical Winnipeg market ranges from your research, labelled as typical ranges and dated ("2026"). Never quote No-Bs prices or promise a price; the call to action is the free quote.
- One clear call to action to the free quote / 204-900-0438, plus the related service page.
- Schema: keep the template's Article + BreadcrumbList. Self-referencing canonical on the clean URL (no `.html`). Real photos from the vault or a relevant Pexels image with descriptive alt text.

### Refresh mode
Keep the URL, the H1 topic and what already works. Fix what the brief says: `refresh.lowCtr` → rewrite the title and meta description to win the click (the content can stay); stalled or page 2 → add the missing questions, a better first answer, fresher numbers, more Winnipeg detail, the required internal links; `coverageState` "Crawled - currently not indexed" → the page looked thin or duplicate: make it clearly more useful than the pages in `avoid`. Update `dateModified` in the schema and the date shown on the page.

### Page mode
A landing page sells one service (or one service in one neighbourhood). Structure: H1 "<Service> in Winnipeg" (or "in <Neighbourhood>"), what is included, how it works, why us (real proof: reviews word for word, real photos, years, crew), the seasonal timing, FAQ from `questions`, the quote form or call button. Link down to the posts listed in `internalLinks` and `avoid` (they are now this page's supporting articles). **Area pages must be genuinely about that neighbourhood** (streets and landmarks we work around, local soil or tree issues, jobs we did there, reviews from there). If you cannot write 300+ words that would be untrue anywhere else, skip it: `seo_site.py skip <assignmentId> "not enough local detail"`. Doorway pages get the whole site demoted.

## 4. Check before publishing
Word count in range; title under 60 and meta under 155 characters; one H1; every required link present and working; no banned words (nobs-brand); no mid-sentence dashes; facts sourced; nothing that contradicts the avoid-list pages.

## 5. Publish and report
Publish through `_blog-autopilot.py` as before (it uploads, updates posts.json, the static blog list and the sitemaps). Then write a JSON file and report it:
```json
{"assignmentId": "<from the brief>", "url": "https://www.no-bs-yardwork.com/blog-...", "mode": "new",
 "title": "...", "primaryKeyword": "...", "secondaryKeywords": ["...", "..."], "contentType": "cost guide",
 "wordCount": 880, "kind": "blog"}
```
`python ...\seo_site.py published report.json` → the response says `reportDue`.

## 6. Weekly recap (when `reportDue` is true)
`python ...\seo_site.py progress` gives the numbers (the server snapshots them; do not change them). Write 150 to 300 plain words for the owner: what moved (keywords up or down, pages newly indexed), what went live this week, open problems that matter, and the next focus. No hype, no invented numbers. Save as `{"narrative": "...", "nextFocus": "..."}` and run `seo_site.py report recap.json`.

## 7. Finish
`seo_site.py run completed "<what went live, the keyword>" --result result.json` (status `skipped` or `failed` when that is what happened). `result.json` follows the run format in `nobs-5starflow-api` (`actions_taken`, `research_findings` with the source URLs, `learnings`). It records the run for the heartbeat even when nothing was published. Save durable lessons to memory `agent:content` (for example "refreshing titles on page-1 posts doubled clicks").
