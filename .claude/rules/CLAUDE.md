# Rules — Coding Standards & Constraints

## Hard Rules (never break these)

1. **No build tools.** No npm, no webpack, no bundler, no framework. Static site only.
2. **No hardcoded colors.** Always use CSS variables from `:root`. Never write hex/rgb/hsl directly in rules.
3. **No new files unless necessary.** Add CSS to existing `styles.css` or `pricing.css`. Add JS to `main.js`.
4. **No trailing summaries.** Do not summarize what you just did at the end of a response.
5. **Read before editing.** Always read a file before modifying it.
6. **Mobile must work.** Every UI change must hold up below 375px width.

## CSS Rules

- Use only vars from the brand color palette — see `context/css-reference.md`
- New section always wraps in `<section><div class="container">...</div></section>`
- Add new component styles at the bottom of the appropriate CSS file with a `/* --- ComponentName --- */` comment header
- Never add inline styles for layout or color — use classes
- Breakpoints are `@media (max-width: 768px)` for mobile, `@media (max-width: 1024px)` for tablet

## HTML Rules

- One `<h1>` per page
- All `<img>` tags need `alt` attributes
- CTAs must be action verbs ("Get My Free Audit", not "Learn More")
- Avoid banned words in copy: "leverage", "seamlessly", "game-changer", "cutting-edge", "revolutionize"
- Section IDs must match the canonical section order (see `context/css-reference.md`)

## JS Rules

- Vanilla JS only — no libraries, no CDN imports (except what's already there)
- All JS lives in `js/main.js`
- Do not use `document.write()`
- Event listeners use `addEventListener`, not inline `onclick`

## Editing Approach

- Prefer the **minimum change** that solves the problem
- Do not refactor surrounding code while fixing a bug
- Do not add error handling for scenarios that can't happen
- Do not add comments unless the logic is genuinely non-obvious
- Copy changes on one card/section must be mirrored if the same text appears on other cards

## When Adding a New Section

1. Use the section scaffold pattern from `context/css-reference.md`
2. Insert at the correct canonical position — do not append to end
3. Use `.reveal` class for scroll animation
4. Add `.section-label` above h2, `.section-sub` below if needed
5. Pad with `5rem 0`, reduce to `3rem 0` at mobile breakpoint

## Commit / File Safety

- Do not delete or rename existing HTML files — they may be linked from external sources
- Do not change the `thankyou-k4r9x2m7qp.html` filename — the obfuscated name is intentional
- Do not touch `privacy.html` or `terms.html` content without explicit instruction

## Efficiency Shortcuts

- To find where a section starts in HTML: search for the `id=` attribute (e.g., `id="pricing"`)
- To find a CSS component: search for the class name — all classes are defined once
- Nav dropdown styles are in `pricing.css`, not `styles.css`
- The `.reveal` animation is driven by an IntersectionObserver in `main.js`
- The FAQ accordion is in `main.js` — uses `data-faq` attributes on triggers
