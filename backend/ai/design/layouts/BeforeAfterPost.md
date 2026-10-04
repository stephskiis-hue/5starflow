# BeforeAfterPost

A real job shown before over after, same angle, with the job and neighbourhood on top. The proof post.

Provide: two real photos of the same spot from the same angle (before and after), a kicker with the service and neighbourhood, a headline of 3 to 5 words about the change ("Same yard. One morning.").

- Do use only our own job photos, same angle and light; after goes on the bottom.
- Don't show house numbers, plates or faces without permission.
- Don't claim a timeframe you can't back up.

Slots: `kicker`, `headline`, `before`, `after` (both required), optional `before_label`, `after_label`. Square size puts the photos side by side.

Slots (for the renderer): `data-slot` text (a line break starts a new line, `[[words]]` sets the accent colour), `data-slot-bg` photo, `data-slot-list` list, `data-if` shown only when that slot has a value, `data-fit` shrinks to fit. Sizes: add `size-story` (1080 × 1920) or `size-square` (1080 × 1080) to `.post`; feed is the default.
