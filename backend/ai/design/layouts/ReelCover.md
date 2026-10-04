# ReelCover

The first frame and grid cover of a reel: three words over a real job photo, the logo up top, the phone number down low.

Provide: a real job photo, a kicker with the job and neighbourhood, a title of 2 or 3 words (two lines).

- Do keep the title inside the middle 1080 × 1350 so the profile grid crop shows it.
- Don't use a photo with a house number or a face without permission.

Slots: `kicker`, `title`, `photo`. Size: 1080 × 1920.

Slots (for the renderer): `data-slot` text (a line break starts a new line, `[[words]]` sets the accent colour), `data-slot-bg` photo, `data-slot-list` list, `data-if` shown only when that slot has a value, `data-fit` shrinks to fit. Sizes: add `size-story` (1080 × 1920) or `size-square` (1080 × 1080) to `.post`; feed is the default.
