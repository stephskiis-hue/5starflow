# ComparePost

Two options side by side: our two plans, or the monthly way against the per-visit way. The highlighted column is the one we want picked.

Provide: a headline, a label and a big figure for each column (a real response time like "24H", never a price), 3 short points each.

- Do keep points under 5 words and parallel across the columns.
- Don't name or mock a competitor; compare approaches, not companies.
- Don't use figures the business doesn't promise.

Slots: `kicker`, `headline`, `a_label`, `a_big`, `a_items`, `b_label`, `b_big`, `b_items`. Column A is highlighted in leaf.

Slots (for the renderer): `data-slot` text (a line break starts a new line, `[[words]]` sets the accent colour), `data-slot-bg` photo, `data-slot-list` list, `data-if` shown only when that slot has a value, `data-fit` shrinks to fit. Sizes: add `size-story` (1080 × 1920) or `size-square` (1080 × 1080) to `.post`; feed is the default.
