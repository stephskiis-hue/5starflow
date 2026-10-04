# StatementPost

Big bold statement on the forest ground with the mow-stripe pattern. The loudest layout: use it for the post that has to sell.

Provide: a kicker (the plan or service name, uppercase), a headline of two short lines (line 1 white, line 2 in `leaf`), one supporting sentence under 20 words. Optional: a real job photo, which replaces the stripes under a `forest` overlay at about 70%.

- Do keep the headline to 2 to 4 words a line and 3 lines at most. About 9 letters a line keeps it full size.
- Don't use it more than twice a week; it loses punch.
- Don't put prices or more than one call to action on it.

Slots: `kicker`, `headline`, `body`, optional `photo`.

Slots (for the renderer): `data-slot` text (a line break starts a new line, `[[words]]` sets the accent colour), `data-slot-bg` photo, `data-slot-list` list, `data-if` shown only when that slot has a value, `data-fit` shrinks to fit. Sizes: add `size-story` (1080 × 1920) or `size-square` (1080 × 1080) to `.post`; feed is the default.
