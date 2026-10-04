# FAQPost

A real customer question on paper, answered straight on forest. The objection handler: it answers what people actually ask in DMs and comments.

Provide: the question as the customer asked it (tidied, not reworded in meaning), a 2 to 3 word answer headline, one or two sentences of why.

- Do pull the question from real messages, comments or reviews.
- Do answer first, sell second.
- Don't answer with a price.

Slots: `kicker`, `question`, `answer_headline`, `answer`.

Slots (for the renderer): `data-slot` text (a line break starts a new line, `[[words]]` sets the accent colour), `data-slot-bg` photo, `data-slot-list` list, `data-if` shown only when that slot has a value, `data-fit` shrinks to fit. Sizes: add `size-story` (1080 × 1920) or `size-square` (1080 × 1080) to `.post`; feed is the default.
