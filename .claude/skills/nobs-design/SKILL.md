---
name: nobs-design
description: How to turn a content idea into an on-brand graphic with the 5StarFlow renderer: pick the layout, fill the slots, check the output. Use whenever a graphic is needed.
---

# Design

The design system lives in `backend/ai/design/` (tokens, vendored fonts and logos, 12 layout templates with their slot docs in `layouts/<Name>.md`). You never draw by hand: you choose a layout and fill its slots; `POST /api/ai/content` with `"render":true` produces the PNG.

1. Pick the layout from the table in `nobs-brand` (rotate: never the same layout twice in a row).
2. Fill the slots exactly (`nobs-content` lists them). Text: `\n` = new line, `[[words]]` = accent colour. Headlines 2 to 7 words per line, whole graphic under about 40 words.
3. Photos are `vault:<assetId>` only, from `GET /api/ai/assets?usable=true`. Never invent a photo; no suitable photo means a layout that needs none.
4. Preview cheaply with `POST /api/ai/content/preview` (returns the PNG, nothing stored) before creating the item.
5. Check the render: readable on a phone in one second, phone number present, nothing cut off (`X-Overflow: false`). Fix every QA error; do not argue with the linter.
6. Record what worked or failed in memory (`agent:design`), for example "headlines over 5 words overflow on StatementPost".
