# CSS Reference — styles.css + pricing.css

## Brand Colors (CSS vars — never use hardcoded hex)

```css
--color-primary:      #1A3C2E   /* dark green */
--color-primary-dark: #0F2219
--color-accent:       #D4A017   /* gold/amber */
--color-accent-hover: #B8860B
--color-bg:           #F9F7F2   /* off-white page bg */
--color-surface:      #FFFFFF
--color-text:         #1C1C1C
--color-text-muted:   #6B7280
--color-border:       #E5E0D5
--color-success:      #22C55E
```

## Type Scale (CSS vars)

```css
--text-xs:   0.75rem
--text-sm:   0.875rem
--text-base: 1rem
--text-lg:   1.125rem
--text-xl:   1.25rem
--text-2xl:  1.5rem
--text-3xl:  1.875rem
--text-4xl:  2.25rem
--text-5xl:  3rem
```

## Radii & Shadows

```css
--radius-sm: 6px    --radius: 12px    --radius-lg: 20px
--shadow-sm / --shadow / --shadow-lg
```

## Buttons

Base class: `.btn` — always pair with a variant:

| Class | Style |
|---|---|
| `.btn-primary` | Gold bg, white text |
| `.btn-accent` | Gold bg, larger (0.875rem 2rem padding, text-lg) |
| `.btn-outline` | Transparent, dark green border |
| `.btn-dark` | Very dark green bg, larger |
| `.btn-dark-outline` | Transparent, very dark green border, larger |

## Section Pattern

Every section uses this structure:
```html
<section id="section-id">
  <div class="container">
    ...
  </div>
</section>
```
Standard section padding: `5rem 0` (mobile: `3rem 0`)

## Key Utility Classes

| Class | Purpose |
|---|---|
| `.container` | max-width 1100px, centered, 1.5rem side padding |
| `.reveal` | Scroll animation (opacity 0→1, translateY 24px→0), JS adds `.visible` |
| `.section-label` | Gold, uppercase, small — used above h2s |
| `.section-sub` | Muted text, max-width 640px — used below h2s |
| `.badge` | Pill badge (gold border/bg on dark — used in hero) |

## index.html — Canonical Section Order

1. `#hero` — dark green bg, flex layout with service notification cards visual
2. `#trust` — animated scrolling ticker, "Works with:" label
3. `#features` — 3-column feature cards
4. `#problem` — 3-column problem cards
5. `#how-it-works` — 3 steps (trigger→action for all 3 services)
6. `#how-powered` — dark green (#132D22), Zapier explainer with app flow nodes
7. `#pricing` — 3-column pricing cards (featured card: translateY(-12px) scale(1.02))
8. `#roi-calc` — dark green bg, interactive slider
9. `#testimonials` — dark green bg, 3 testimonials + stats bar
10. `#faq` — accordion
11. `#cta-final` — gold bg
12. `#get-started-cta` — 2-col: book a call + email capture

## pricing.html — Canonical Section Order

1. `.pricing-hero` — dark green bg
2. `.zapier-notice-section` — amber/yellow bg info box
3. `.plans-overview` — 3 overview cards linking to anchors
4. `#diy` `.plan-section-light` — DIY plan detail
5. `#done-for-you` `.plan-section-featured` — Done For You (gold border-top, banner)
6. `#managed` `.plan-section-light` — Fully Managed plan detail
7. `.comparison-section` — feature comparison table
8. `.pricing-faq` — FAQ accordion
9. `#cta-final` — gold bg CTA

## pricing.html Layout Pattern

Each plan section uses `.plan-inner` grid: `1fr 340px` gap `4rem`
- Left: `.plan-info` (title, price, service chips, checklist, limit box, who-is-it-for)
- Right: `.plan-sidebar` (sticky top 88px) → `.plan-cta-card` + upsell link

## Hero Visual

```
.hero-visual        — flex column, gap 0.6rem, width 320px desktop / full-width mobile
.service-notif      — white card, flex row, shadow-lg, icon + body + green check badge
.service-notif-2    — margin-left: 1rem, opacity 0.88 (stagger effect)
.service-notif-3    — margin-left: 2rem, opacity 0.7
```
On mobile: no margin-left, opacity 1 for all three.

## Hero Service Chips

```
.hero-service-chips  — flex wrap, centered on mobile (justify-content: center)
.hero-chip           — pill (white 8% bg, white 15% border, gold-ish text, nowrap)
```

Chip labels (exact — do not change):
- "★ Review Requests"
- "⚡ Instant Lead Replies"
- "📍 Google Posting"

## Pricing Plan Service Names (exact — must stay identical across all 3 cards)

- "★ Review Requests"
- "⚡ Lead Response"
- "📍 Google Posting"

```css
.plan-service-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

## Nav

- Sticky, 64px height, white bg
- Desktop: horizontal menu + CTA button right
- Mobile: hamburger → slide-in panel from right
- Dropdown: `.nav-dropdown-wrap` + `.nav-dropdown` (absolute positioned, animated)
- **Nav dropdown CSS lives in `pricing.css`** (not styles.css)

## Featured Plan Fix

`.plan-section-featured` has `padding-top: 0` so `.plan-featured-banner` (gold strip) sits flush at top.
`.plan-section-featured .plan-inner` has `padding-top: 5rem` to restore content spacing.

## Component Classes Added (pricing.css)

| Class | Purpose |
|---|---|
| `.video-after-purchase` / `.video-yt-badge` / `.video-after-text` | YouTube after-purchase notice |
| `.limit-list` / `.limit-list li` | Bullet list in Zapier account info box |
| `.zapier-plain-explain` | Blue callout box for DIY Zapier explanation |
| `.plan-services-summary` / `.plan-service-chip` / `.chip-included` / `.chip-excluded` | Service chip pills at top of plan sections |
