# TipPost

A useful local tip with a big number, magazine style. The number is the tip's place in a running series (01, 02, 03), so keep the count going across the season.

Provide: the series number, a kicker ("WINNIPEG FALL TIP", "SNOW TIP"), a headline that is the tip itself in 3 to 5 words, one or two sentences of why.

- Do make the tip true for Winnipeg and the current month.
- Don't sell in the tip itself; the footer does that.

Slots: `number`, `kicker`, `headline`, `body`. The badge gets a forest ring here so it reads on leaf.

Slots (for the renderer): `data-slot` text (a line break starts a new line, `[[words]]` sets the accent colour), `data-slot-bg` photo, `data-slot-list` list, `data-if` shown only when that slot has a value, `data-fit` shrinks to fit. Sizes: add `size-story` (1080 × 1920) or `size-square` (1080 × 1080) to `.post`; feed is the default.
