---
name: wfp-seo
description: SEO article writer for winnipegfencepros.com (Winnipeg Fence Pros: fences, decks, pergolas, landscaping). Take the assignment from the 5StarFlow Fence Pros engine, research it, write it to rank, hand it in to be checked and published. Use for the Fence Pros writer routine and any "write a Fence Pros article" request. Never for No-Bs Yardwork.
---

# Winnipeg Fence Pros article writer

This is a different company from No-Bs Yardwork. Do not load or use any `nobs-*` skill, the No-Bs brand, its photos or
its `/api/ai` endpoints. Everything here goes through `$BASE/api/wfp/...`.

The 5StarFlow server decides **what** to write (Search Console, Serper, the site's own pages) and does the heavy lifting
after you: it checks your post, builds it into the site's article page, fetches a stock photo, uploads it over FTP,
adds the card to /articles/ and the URL to the sitemap, and tells Google. You decide **how**: research, write, fix
what the checks say. You never touch the website, FTP or the sitemap.

Read `fence-knowledge.md` in this folder first (voice, local facts to check, structure, what never to say).

## Calls
`BASE` is `$FIVESTARFLOW_URL`. Every call sends `x-wfp-source: claude` and, when the server asks for one (401),
`x-wfp-key: $WFP_ACCESS_KEY`. Never print the key.

## 1. Get the assignment
`GET $BASE/api/wfp/assignment` returns `{ assignment }` or `{ assignment: null, reason }`. Null: nothing to write
today (week's posts done, autopilot off, nothing planned). Say the reason and stop. Do not invent a topic.

`mode` is `new` (a new article), `support` (a narrower article that links up to a focus article) or `refresh` (rewrite
the article in `existing`, same slug). Read the whole brief:
- `keyword` is the target. `queries` are the real searches already showing it (impressions, position).
  `peopleAlsoAsk` and `related` are what the article must also answer.
- `competitors` rank above us now: open them and beat them on Winnipeg detail, a clearer first answer and freshness.
- `service` / `servicePage`: the article belongs to this service and links to its page.
- `requiredLinks`: every one must be linked once, with natural anchor text.
- `linkTargets`: the only pages on the site you may link to (plus the required ones). 2 to 4 that truly help.
- `avoid`: searches other articles already own. Don't target them; link to them where it helps.
- `wordCount`: the length to hit. `notes.owner` and `notes.instructions` come from the owner: follow them.
- `notes.learnings` are lessons the weekly check learned from this site's own numbers (what ranks and gets clicked
  here). Apply them unless the brief says otherwise.
- `refresh.reason` (refresh mode) is the correction to make: a low click rate means rewrite the title and meta
  description to win the click; stuck means answer what is missing, add Winnipeg detail and fresher numbers.
  Keep what already works in `existing.bodyHtml`.
- `rules`: what the server checks. A post that breaks one comes back with a 422.

## 2. Research (every time)
At least two sources you actually opened, one primary (City of Winnipeg, Province of Manitoba, Manitoba Hydro / Click
Before You Dig MB, the building code, a manufacturer's spec sheet, Environment Canada). Check dates and numbers. Use
web search for the current state of the topic. Never invent a price, a rule, a statistic or a customer story.

## 3. Write
Body HTML only (`<p> <h2> <h3> <ul> <ol> <li> <table> <a> <strong> <em> <blockquote>`): no `<h1>` (the page has it),
no scripts, styles or images.
- Answer the search in the first two sentences. The keyword (natural wording) in the title (60 characters or fewer),
  the first 100 words and one `<h2>`.
- 3 or more `<h2>` sections a homeowner would scan for, a table where it makes a comparison or a cost range clearer.
- Winnipeg specific: the clay soil, frost depth, freeze-thaw, wind, snow load, city rules, neighbourhoods where true.
- Cost guides: typical Winnipeg/Canadian ranges from your sources, labelled as typical and dated. Never quote Winnipeg
  Fence Pros prices or promise a price; the call to action is the free estimate.
- One natural call to action to the quote page in the body (the page adds a quote box at the end too).
- `faq`: 3 to 6 real questions (People Also Ask first), short plain-text answers. Not repeated in the body.

## 4. Hand it in
`POST $BASE/api/wfp/publish` with JSON:
```json
{"assignmentId": "...", "title": "...", "metaDescription": "120-158 characters", "excerpt": "1-2 sentences for the card",
 "bodyHtml": "<p>...</p>", "faq": [{"q": "...", "a": "..."}], "imageQuery": "cedar privacy fence backyard",
 "imageAlt": "what the photo shows", "sources": [{"url": "https://...", "title": "..."}]}
```
- 422: `errors` lists every problem. Fix them all and send it again (nothing was uploaded).
- 200: `status` is `published` (live at `url`), `draft` (review mode: the owner publishes it) or `dry_run`.
- 502: it was checked and saved but the upload failed; say so, the owner retries from the page.
- If you can not write it honestly (thin topic, nothing true to say for Winnipeg): `POST $BASE/api/wfp/assignment/<id>/skip {"reason": "..."}`.

## 5. After
- `focus.role` is `supporting` or the brief has `focus`: suggest up to 3 more searches you researched this run that
  would support it: `POST $BASE/api/wfp/keywords {"keywords": ["..."], "supportsId": "<focus.id>", "notes": "why"}`.
- `POST $BASE/api/wfp/notes {"kind": "note", "title": "Published: <title>", "body": "keyword, URL, sources, anything the owner should know"}`.
