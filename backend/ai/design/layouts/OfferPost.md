# OfferPost

The booking push and the paid ad layout: a real photo on top, the offer on forest, three points and a big call-or-text bar. Works in all three sizes.

Provide: a real job photo, a kicker (service and area), a two-line headline, three short points of what they get, optional flag line ("SPOTS FILLING UP" only when true).

- Do use only offers the business actually has; no prices, discounts or guarantees.
- Do keep points under 6 words each.
- Don't use it more than once in four posts organically.

Slots: `kicker`, `headline`, `points`, optional `photo`, optional `flag`, optional `cta_label`.

Slots (for the renderer): `data-slot` text (a line break starts a new line, `[[words]]` sets the accent colour), `data-slot-bg` photo, `data-slot-list` list, `data-if` shown only when that slot has a value, `data-fit` shrinks to fit. Sizes: add `size-story` (1080 × 1920) or `size-square` (1080 × 1080) to `.post`; feed is the default.
