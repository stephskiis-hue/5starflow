# StoryPoll

A story question with an empty band where the Instagram or Facebook poll sticker goes. Stories only.

Provide: a kicker, a question of 2 to 5 words (two lines), one short line telling people to tap.

- Do ask something fun and local that a homeowner can answer in one tap.
- Don't cover the sticker band; it is left clear on purpose (the dashed guide is hidden when rendered).

Slots: `kicker`, `question`, `body`. Size: 1080 × 1920.

Slots (for the renderer): `data-slot` text (a line break starts a new line, `[[words]]` sets the accent colour), `data-slot-bg` photo, `data-slot-list` list, `data-if` shown only when that slot has a value, `data-fit` shrinks to fit. Sizes: add `size-story` (1080 × 1920) or `size-square` (1080 × 1080) to `.post`; feed is the default.
