# Skills — Custom Slash Commands

---

## /audit-copy [file]

Reviews all visible text on a page against copywriter standards.

**Steps:**
1. Read the target HTML file
2. Extract all user-facing text: headlines, subheads, body, CTAs, labels
3. Flag banned words/phrases (see agents/CLAUDE.md — copywriter)
4. Flag CTAs that are not action verbs
5. Flag hero/CTA paragraphs longer than 2 sentences
6. Output: numbered list — element + issue + suggested fix

**Example:** `/audit-copy index.html`

---

## /audit-ui [file]

Reviews HTML/CSS for design system compliance.

**Steps:**
1. Read the target file(s)
2. Search for hardcoded colors (hex, rgb, hsl) outside `:root`
3. Verify all buttons use approved variant classes
4. Check section order matches canonical order
5. Flag missing `alt` attributes on `<img>` tags
6. Output: pass/fail checklist

**Example:** `/audit-ui index.html` or `/audit-ui css/styles.css`

---

## /new-section

Scaffolds a new HTML section.

**Steps:**
1. Confirm: section name, purpose, and target page
2. Generate semantic HTML using existing CSS class patterns
3. Use only established CSS variables
4. Insert at the correct canonical position
5. Add any new CSS rules to the existing appropriate file (not a new file)

**Example:** `/new-section`

---

## /check-placeholders

Scans all HTML files for known placeholder content.

**Looks for:**
- Calendly URL placeholder or `mailto:` standing in for a booking link
- YouTube iframe placeholders or `href="#"` on video blocks
- Form `action` attributes pointing nowhere
- Any `href="#"` on a CTA that should be a real link

**Output:** File-by-file list with line references.

**Example:** `/check-placeholders`

---

## /mobile-check [file]

Reviews a page for mobile layout issues.

**Steps:**
1. Read the HTML and linked CSS
2. Check for fixed pixel widths that overflow small screens
3. Check media queries use correct `max-width`/`min-width`
4. Verify touch targets (buttons, links) are at least 44px tall
5. Flag any `overflow: hidden` on `body` that might clip scroll

**Example:** `/mobile-check index.html`

---

## /section-order [file]

Verifies or prints the current section order of a page.

**Steps:**
1. Read the HTML file
2. List all `<section>` tags in order with their `id` attribute
3. Compare against canonical order from `context/css-reference.md`
4. Flag any section that is out of place or missing

**Example:** `/section-order index.html`

---

## /find-class [classname]

Locates where a CSS class is defined and all places it is used.

**Steps:**
1. Search `css/styles.css` and `css/pricing.css` for the class definition
2. Search all HTML files for usage
3. Output: definition location + all usages with file and rough context

**Example:** `/find-class hero-chip`
