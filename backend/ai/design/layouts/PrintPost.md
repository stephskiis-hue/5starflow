# PrintPost

Classic print ad structure: one small subject up top, a witty two-line headline low on the page, a short two-column paragraph, the footer.

Provide: a small square subject (a cropped job photo or the mow-stripe swatch), a headline of two short sentences, a paragraph under 40 words.

- Do let the empty space do the work; never fill the top half.
- Do write the headline as a benefit the customer feels ("More weekend"), not a service list.
- Don't use it for urgent offers; that's the Statement post's job.

Slots: `headline`, `body`, optional `photo` (the subject grows to 240px when it's a photo).

Slots (for the renderer): `data-slot` text (a line break starts a new line, `[[words]]` sets the accent colour), `data-slot-bg` photo, `data-slot-list` list, `data-if` shown only when that slot has a value, `data-fit` shrinks to fit. Sizes: add `size-story` (1080 × 1920) or `size-square` (1080 × 1080) to `.post`; feed is the default.
