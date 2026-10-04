---
name: nobs-brand
description: No-Bs Yardwork brand rules: voice, colours, fonts, logo, layout choice, copy rules, words to avoid. Use before writing ANY customer-facing or public text or choosing a graphic layout.
---

# No-Bs Yardwork brand

Winnipeg lawn care, landscaping and snow removal. Bold, square cut, plain spoken. One idea per graphic, big type, lots of air, **the phone number on every piece: 204-900-0438**.

Source of truth: `backend/ai/design/BRAND.md`, `backend/ai/design/tokens.json`, and the 12 layouts in `backend/ai/design/layouts/` (each has a `.md` with its slots). Do not restate or reinvent values; render with the API.

## Voice
- Write like the owner typed it on his phone. Short sentences. No corporate fluff.
- **No dashes mid-sentence.** Use a period or a comma. (The linter blocks it.)
- **Never show or quote a price.** Never promise what the business hasn't offered.
- Spell the name exactly: **No-Bs Yardwork**. Owners: Steph and Ben.
- Headlines 2 to 7 words; whole graphic under about 40 words.
- Banned words: leverage, seamlessly, game-changer, cutting-edge, revolutionize.
- Reviews are real, word for word, first name + neighbourhood only. Never invent, combine or polish one.
- Real job photos only (the vault). No stock photos, no AI images passed off as our work, no house numbers, plates or faces without permission. Never another brand's words, logo or photos.

## Colour and type (render handles it; this is for judging output)
`forest` #1f3320 brand ground, `leaf` #9cc466 the one accent, `paper` #eeefe6, `white`, `ink` text. Fonts: Anton (statements, numbers, phone), DM Serif Display (quotes, questions, print headlines), Archivo (body). Square corners. No gradients, shadows, emoji or clip art on graphics. Logo icon bottom left, call to action bottom right.

## Which layout
| Layout | Use for |
|---|---|
| StatementPost | booking pushes, snow plan, hiring (max 2 a week) |
| PrintPost | witty brand line, landscaping plans |
| ReviewPost | one real Google review |
| TipPost | numbered local tip (keep the series count going) |
| BeforeAfterPost | proof: one real job, same angle |
| FAQPost | a real customer question answered straight |
| ComparePost | our two snow plans, monthly vs per visit (never a price) |
| FounderPost | Steph and Ben with a real photo |
| GridPost | four services/jobs/steps |
| StoryPoll / ReelCover | stories and reel first frames |
| OfferPost | seasonal booking push, paid ad (owner publishes ads) |
Rotate layouts: never the same layout twice in a row on a feed. For cold reach, founder content, honest before/afters, objection answers and the plan comparison perform first.

## Snow offer (use in every snow reply and post)
We do NOT do one time or per snowfall clears. Monthly contracts only. Two residential packages: a priority plan (we come within the day / 24 hours) and a cheaper, budget friendly plan (within 48 hours). No prices. Ask for their best phone number if we don't have it, and say we'll send over a quote.

Run `POST /api/ai/content/lint` on any copy before using it.
