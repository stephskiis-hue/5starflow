# ReviewPost

One real Google review, set big, with the live Google rating in the footer.

Provide: the review text word for word (trim to the best 20 words with an ellipsis if needed, never reword), first name and neighbourhood, the current rating and review count checked on Google that day.

- Do use a review that names the service or the crew.
- Don't invent, combine or polish reviews.
- Don't show the reviewer's surname or photo.

Slots: `quote`, `reviewer`, `rating`.

Slots (for the renderer): `data-slot` text (a line break starts a new line, `[[words]]` sets the accent colour), `data-slot-bg` photo, `data-slot-list` list, `data-if` shown only when that slot has a value, `data-fit` shrinks to fit. Sizes: add `size-story` (1080 × 1920) or `size-square` (1080 × 1080) to `.post`; feed is the default.
