# GridPost

Four tiles in a 2 × 2 grid: four services, four jobs or four steps. Tiles take a real photo with a label bar, or a flat colour with a big number.

Provide: a headline, and four tiles with a number and a 1 to 3 word label, each with a photo if you have one.

- Do keep labels to 3 words.
- Don't mix unrelated services in one grid; it's one idea in four parts.

Slots: `kicker`, `headline`, `tiles` (list of `num`, `label`, optional `photo`).

Slots (for the renderer): `data-slot` text (a line break starts a new line, `[[words]]` sets the accent colour), `data-slot-bg` photo, `data-slot-list` list, `data-if` shown only when that slot has a value, `data-fit` shrinks to fit. Sizes: add `size-story` (1080 × 1920) or `size-square` (1080 × 1080) to `.post`; feed is the default.
