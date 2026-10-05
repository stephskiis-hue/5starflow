---
name: nobs-content
description: Content Director + Design workflow for No-Bs Yardwork: research a topic, pick audience and layout, write copy, render graphics with the design system, QA, and queue them in 5StarFlow. Use for the nightly content run and any "make a post" request.
---

# Content engine

Read `nobs-brand` and `nobs-5starflow-api` first. Goal: keep a **pool of 7+ days of ready posts** so nobody has to ask for individual posts.

## Curate the vault first (new photos only, max 20 per run)
`GET /api/ai/assets?kind=photo&uncurated=true&limit=20`, then look at each image (`GET /api/ai/assets/<id>` returns the bytes) and `PATCH /api/ai/assets/<id>` with `{quality: 1-5, tags: [...], private: true|false, pairKey}`. Quality: 5 sharp, well lit, clearly shows the work; 3 usable; 1 blurry or unusable. `private: true` when a face, licence plate or house number is readable. Tag with the service (PATIOS, SOD, LAWNS, FALL, SNOW, LANDSCAPING, DRAINAGE, COMMERCIAL), BEFORE or AFTER, CREW, EQUIPMENT. Give matching before/after shots of the same spot the same `pairKey` (for example `job-<name>-<date>`). The renderer refuses private photos and the Content Director only uses `usable=true` ones (`GET /api/ai/assets?usable=true&tag=BEFORE`).

## Nightly loop
1. `GET /api/ai/brief?agent=content`; `GET /api/ai/content?status=queued` and `?status=published` (don't repeat topics from the last 3 weeks); `GET /api/ai/content/performance` (what worked: weight winners up, repeated losers down).
2. Check `rejected` items: `GET /api/ai/content?status=rejected` → each has the owner's note. Learn from it (`POST /api/ai/memory scope agent:content`).
3. Pick topics that are true for Winnipeg **this month**: open `seasonal-calendar.md` (next to this file) at the current month (and the next, since posts go out over the coming week). Then **research each post** (below). A real review, a real job photo or our own site still count as grounding for proof, review and offer posts.
4. Choose audience (homeowner, property manager, commercial), pillar (`tip|proof|review|faq|offer|founder|story|group|seasonal`), and a layout that differs from the previous post.
5. Photos: `GET /api/ai/assets?tag=BEFORE` etc. Use real ones (`"photo":"vault:<id>"`). No suitable photo → pick a layout that doesn't need one (Statement, Tip, FAQ, Compare, Review).
6. Create + render in one call. Use the exact slot names per layout (below). Fix every lint error; do not argue with the linter.

```bash
curl -sS -X POST -H "$AUTH" -H "X-Agent: content" -H "Content-Type: application/json" "$BASE/api/ai/content" -d '{
  "title": "Drop the mower. Slowly.", "pillar": "tip", "layout": "TipPost", "format": "post",
  "platforms": ["facebook","instagram"],
  "slots": {"number":"03","kicker":"WINNIPEG FALL TIP","headline":"Drop the mower. Slowly.","body":"Your last cut of the year should be 2 to 2.5 inches. Lower the deck over your last 2 or 3 mows."},
  "caption": "Winnipeg fall tip: ...\n\nCall or text 204-900-0438.",
  "captionIg": "...\n\n#Winnipeg #LawnCare #fallcleanup",
  "grounding": "UMN Extension https://extension.umn.edu/about/our-stories/news/late-fall-lawn-care", "render": true }'
```
Result `item.status`: `queued` (every check passed; it goes out automatically and the owner gets a note, there is **no owner approval step**) or `qa_failed` (read `qa.errors`, fix it yourself, `PATCH /api/ai/content/:id` then `POST /api/ai/content/:id/render`). Never leave a `qa_failed` item behind: fix it in the same run or reject it with a note.

**Before you render, check it yourself** like the owner would: is every fact backed by the source you cite, is it useful to a Winnipeg homeowner this week, is it different from the last 3 weeks, does it read right out loud. After rendering, open the PNG (`GET /api/ai/assets/<id>`) and look at it: text fully on the graphic, nothing cut off or crammed against the footer, the right layout. The server rejects text that runs off the edge or into the footer, but you are the last eye before it posts.

## Research every post (no shallow tips)
The owner wants depth, not "drop the mower a bit". For every tip, seasonal or FAQ post:
1. Write the question it answers in one line ("When should Winnipeg lawns get their last fertilizer, and what kind?").
2. Find at least **two sources**, one of them primary (City of Winnipeg, Province of Manitoba, Trees Winnipeg, University of Minnesota or NDSU Extension, Environment Canada). Open the page; never cite from a search snippet. If sources disagree, go with the primary one and say less.
3. Pull out the **specifics**: the date window, the number (inches, cm, °C, rate), the Winnipeg rule, the why, and the common mistake.
4. Put every URL in `grounding` (the server refuses a `tip` or `seasonal` post without a source URL), e.g. `"UMN Extension https://extension.umn.edu/lawncare/fertilizing-lawns ; City of Winnipeg https://www.winnipeg.ca/yardwaste"`.
5. Depth goes into the **caption** (3 to 6 short lines: what, when, how much, why, the mistake, the phone) or a **carousel** (one step per slide) for a full how-to. The graphic stays one idea and under about 40 words.
6. Save each verified fact once: `POST /api/ai/memory` scope `agent:research`, key `fact:<topic>`, value = fact + URL + date checked. Reuse it next time after a quick re-check. If the calendar is wrong or missing something useful, save the correction to memory (`agent:research`) and list it in your run's `learnings` so the file gets updated.

## Slots by layout (all required unless marked optional)
- StatementPost: `kicker, headline, body`, optional `photo`. `[[words]]` = accent colour, `\n` = new line.
- TipPost: `number, kicker, headline, body`.
- ReviewPost: `quote, reviewer ("MIKE · RIVER HEIGHTS"), rating ("5.0 ★ 65 REVIEWS", checked on Google that day)`.
- PrintPost: `headline, body`, optional `photo`.
- BeforeAfterPost: `kicker, headline, before, after` (both vault photos, same angle), optional `before_label, after_label`.
- FAQPost: `kicker, question, answer_headline, answer`. Question comes from real DMs/comments.
- ComparePost: `kicker, headline, a_label, a_big ("24H"), a_items[1-4], b_label, b_big, b_items`. Never a price.
- FounderPost: `kicker, headline, body, signature, photo` (real photo of Steph/Ben, their own words).
- GridPost: `kicker, headline, tiles:[{num,label,photo?} x4]`.
- StoryPoll (story only): `kicker, question, body`. ReelCover (story only): `kicker, title`, optional `photo`.
- OfferPost: `kicker, headline, points[1-4]`, optional `photo, flag, cta_label`.
Formats: `post` (1080x1350), `carousel` (`slots:{slides:[{layout,slots}...]}`, 3 to 10 slides, first slide = hook, last = ask), `story`/`reel_cover` (1080x1920), `group_post` (1080x1080, rewrite the text per group).

## Weekly cadence (in season Apr to mid Nov): 5 Facebook + 4 Instagram posts incl. 1 reel cover + 1 carousel, 1 to 2 stories a day. Off season: 3 + 3.
Never publish yourself: the Social agent publishes from `GET /api/ai/content/queue` whenever it runs. Don't set `scheduledFor` unless a post is date bound (an event, a deadline); the queue posts oldest first. Ads are drafted only; the owner publishes ads and approves any spend.
After posts have been live 48h, the Social agent records `POST /api/ai/content/:id/metrics`; use `/content/performance` to decide what to make more or less of. Save durable lessons to memory (`agent:content`).
