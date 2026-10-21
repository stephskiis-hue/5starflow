---
name: nobs-seo
description: SEO blog writer for no-bs-yardwork.com: take the day's assignment from the 5StarFlow SEO engine (new post, refresh, landing page or a link edit), research and write it to rank, send it to the server to be checked, built and published, and write the weekly recap. Use for the daily blog autopilot run and any "write a blog post" or "make a landing page" request.
---

# SEO blog writer

The 5StarFlow SEO engine decides **what** to write (keyword data from Search Console, Serper and the site crawl). You decide **how**: research, write, fix what the checks say, report. The server does everything else: it checks your page, builds it into the site's template (head tags, JSON-LD, navigation, footer, hero image, byline, closing quote box), uploads it over FTP, updates the blog index and the sitemaps, and reports it to the engine. You never touch site files, FTP, `posts.json` or sitemaps, and you have no copy of the website.

Read `nobs-brand` (voice), `nobs-research` (sources) and `blog-knowledge.md` in this folder (title formulas, section menu, hooks, CTAs, local signals, learning log) first. API conventions are in `nobs-5starflow-api`; every call below is `$BASE/api/ai/seo/...` with the `Authorization` header from that skill and `X-Agent: content`.

## 1. Get the assignment
`GET /seo/assignment?modes=new,refresh,page,links` returns one of four modes. Do exactly that mode; do not swap topics because another one seems more fun.

| mode | what you make |
|---|---|
| `new` | a new 700 to 950 word post for `keyword`, at `suggestedSlug` |
| `refresh` | rewrite and improve the existing post at `targetUrl`, same slug |
| `page` | a service or neighbourhood landing page (800 to 1300 words), at `suggestedSlug` |
| `links` | no new page: add one sentence with a link to the focus page inside an existing post (section 1b) |

`assignment` is `null` when nothing is worth writing: report the run as skipped (section 6) and stop. Do not invent a topic.

Read the whole brief before writing:
- `keyword` is the primary target. `secondary` and `questions` (Google's "People also ask") are what the page must also answer.
- `evidence.why` says why this was picked; `evidence.queries` are the real searches already landing near it; `evidence.competitors` are the top 3 results. Open them and do better: more specific to Winnipeg, more current, clearer answer up top.
- `avoid` lists searches another page already owns. Do not target them; link to them where it helps the reader.
- `internalLinks`: every `required: true` link must appear in the body with exactly the anchor text given.
- `onPage.wordCount` is the length to hit. `seasonal` + `.claude/skills/nobs-content/seasonal-calendar.md` give this month's Winnipeg facts.
- `focus` (when present) means the owner chose this keyword to win; see 1b.

## 1b. Focus campaigns
When the brief has a `focus` block, this piece is part of a campaign: `focus.role` says whether you are writing the focus keyword's own page or a supporting post, and `focus.goal` is the Google position being chased.
- Include the focus link from `internalLinks` (`required: true`) with exactly the given anchor text. The anchors rotate on purpose: do not reword them or link twice.
- A supporting post answers a narrower question than the focus page and sends the reader up to it. It must not compete: never target the focus keyword itself.
- `ideasWanted` above 0: after publishing, suggest up to 3 more searches the campaign should cover, only ones you researched this run (People Also Ask, autocomplete, what the competitors answer): `POST /seo/keywords {"supportsId": focus.id, "keywords": [{"keyword": "...", "notes": "why"}]}`. 5StarFlow filters and scores them, so a rejected idea is not an error.
- **`links` mode:** the brief names the post to edit (`targetUrl`) and the link to add (`linkTo.url`, `linkTo.anchor`). `GET /seo/site/page?path=<path of targetUrl>` returns its `bodyHtml`. Pick one existing paragraph where the topic already comes up, then `POST /seo/site/link {"assignmentId", "path", "afterText", "sentenceHtml"}`: `afterText` is 12+ characters copied exactly from that paragraph (it must match one place in the page), `sentenceHtml` is a single `<p>` of at most 60 words that reads naturally and contains the link with the given anchor. The server inserts it right after that paragraph and changes nothing else. If there is no honest place for the link, `POST /seo/assignment/<assignmentId>/skip {"reason": "..."}`.
- Never promise or print rankings in a post. Rank movement is measured by the server.

## 2. Research (every time)
Follow `nobs-research`: at least two sources, one primary (City of Winnipeg, Province of Manitoba, Trees Winnipeg, University of Minnesota or NDSU Extension, Environment Canada), pages actually opened, dates and numbers checked. Use web search for the current state of the topic, then our own experience (real jobs, the vault, the owner's notes in memory). Never invent a statistic, a study or a customer story.

## 3. Write to rank and to convert
Write the **body only** as HTML (the rules are at the top of `blog-knowledge.md`): H2 sections, an FAQ from `questions` (H3 question, short answer), lists where they help, two `blog-inline-cta` boxes, and the required links.
- The primary keyword (natural wording) goes in the title (60 characters or fewer, keyword first), the h1, the first 100 words and the meta description (155 or fewer, ends with a reason to click). Secondary keywords and questions become H2s or FAQ answers. If a sentence sounds written for Google, rewrite it.
- Answer the search in the first two sentences (AI overviews and featured snippets quote this). Then the detail: what, when in Winnipeg, how much, why, the common mistake.
- Winnipeg specific: Red River clay, zone 3, the frost dates, City rules, neighbourhood names where true. That is what generic national sites cannot match.
- Cost guides: typical Winnipeg market ranges from your research, labelled as typical ranges and dated ("2026"). Never quote No-Bs prices or promise a price; the call to action is the free quote.
- Landing pages sell one service (or one service in one neighbourhood): what is included, how it works, why us (real proof: reviews word for word, real years and crew), the seasonal timing, an FAQ, the quote call to action. **Area pages must be genuinely about that neighbourhood** (streets, landmarks, soil or tree issues, jobs we did there). If you cannot write 300+ words that would be untrue anywhere else, skip the assignment with the reason. Doorway pages get the whole site demoted.
- Refresh: keep the slug, the h1 topic and what already works (`GET /seo/site/page?path=` gives the live fields and `bodyHtml`). Fix what the brief says: `refresh.lowCtr` means rewrite the title and meta description to win the click (the content can stay); stalled or page 2 means add the missing questions, a better first answer, fresher numbers, more Winnipeg detail and the required links; `coverageState` "Crawled - currently not indexed" means the page looked thin or duplicate: make it clearly more useful than the pages in `avoid`.

## 4. Hero image (new posts)
Send `heroAssetId`: a non-private vault photo that fits the topic. `GET /assets?usable=true&tag=<TAG>` lists candidates (tags like SOD, FALL, PATIOS, CREW); open a few and pick the one that really matches. Real job photos beat stock. Send `imageAlt` describing the photo for a screen reader. A refresh keeps its existing image unless you send a new `heroAssetId`.

## 5. Publish
`POST /seo/site/publish` with JSON:
```json
{"assignmentId": "<from the brief>", "mode": "new", "slug": "<suggestedSlug, or the existing slug>",
 "title": "...", "description": "...", "h1": "...", "crumb": "short breadcrumb label", "keyword": "<brief.keyword>",
 "keywords": ["meta", "keywords"], "secondaryKeywords": ["..."], "contentType": "cost guide", "category": "Lawn Care",
 "heroAssetId": "<vault id>", "imageAlt": "...", "bodyHtml": "<p>...</p><h2>...</h2>..."}
```
- **422** means a check failed: the response lists every problem (`errors`) and notes (`warnings`). Fix them all and send the same request again. Nothing was uploaded. Common ones: title or description too long, keyword missing from the title, h1 or first 100 words, a required link missing, a link to a page that does not exist, a banned word, a mid-sentence dash, the wrong length.
- **201** means it is live: the response has `url`, `files` changed, `reportDue` and `postsSinceReport`. It is already reported to the engine; there is no separate report call. If `indexError` is set, the page is live and the daily 6:15 job will fix the blog index: mention it in the run summary.
- **403** (publishing is switched off) or **503** (the FTP login is not set up) are not yours to fix: record the run as failed with the message and stop.

## 6. Weekly recap (when `reportDue` is true)
`GET /seo/progress?view=report` gives the numbers (the server snapshots them; do not change them). Write 150 to 300 plain words for the owner: what moved (keywords up or down, pages newly indexed, campaign progress from `focus`), what went live this week, open problems that matter, and the next focus. No hype, no invented numbers. `POST /seo/reports {"narrative": "...", "nextFocus": "..."}`.

## 7. Finish
`POST /runs` with slug `ext-blog-autopilot` (`nobs-5starflow-api`): status `completed`, `skipped` (nothing to write) or `failed`, a one-line summary (what went live, the keyword, the URL), and `result` with `actions_taken`, `research_findings` (source URLs) and `learnings`. Save durable lessons to memory scope `agent:content` (for example "refreshing titles on page-1 posts doubled clicks"); the learning log in `blog-knowledge.md` is history and is no longer appended.
