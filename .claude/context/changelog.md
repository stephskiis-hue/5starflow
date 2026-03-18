# Changelog — What Was Built & Changed

Running log of all significant changes made across sessions.

---

## Bundle Repositioning (index.html)

### Hero
- Badge: "Works With Any Invoice System"
- h1: "Three Automations. One Setup. More Reviews, More Leads, Better Rankings."
- Sub: "5StarFlow is a complete automation bundle for home service businesses. Connect your invoicing system once..."
- Hero visual: Replaced 2 review cards with 3 `.service-notif` cards:
  - "★ Review Request Sent — Invoice paid → client notified automatically"
  - "⚡ Lead Reply Sent — New form submit → reply in 30 seconds"
  - "📍 Google Post Published — Scheduled → posted to your listing automatically"
- Service chips: Replaced inline-style `<div>` with `.hero-service-chips` + `.hero-chip` pills

### Section Order Change
Features moved from position 5 → position 3 (now appears above the fold on first scroll):
`hero → trust → features → problem → how-it-works → how-powered → pricing → roi → testimonials → faq → cta → get-started`

### Features Section
- Moved from after `#how-it-works` to right after `#trust`
- Removed `feature-plan-badge` spans ("✓ All Plans", "✓ Done For You & Managed")
- Fixed Jobber-specific copy → platform-agnostic: "The moment an invoice is paid in your system"
- New heading: "Three Services. One Setup. Runs on Autopilot."
- New label: "What's Included"

### How It Works (full rewrite)
Old: 3 steps showing the review request flow only
New: 3 steps showing all 3 automations as trigger→action pairs:
1. "Invoice Paid → Review Request Sent"
2. "Lead Submits Form → Reply in Seconds"
3. "Scheduled Time → Google Post Published"
Added callout: "🔄 All three run simultaneously on autopilot."

### Pricing Cards — Service Name Shortening
- "★ Automated Review Requests" → "★ Review Requests"
- "⚡ Instant Lead Response" → "⚡ Lead Response"
- "📍 Google Business Posting" → "📍 Google Posting"
- "Jobber + website form connections built" → "Invoice system + website form connections built"

---

## CSS — styles.css Additions

### New Components
- `.hero-visual` — flex column, gap 0.6rem, width 320px
- `.service-notif` + `.service-notif-2` + `.service-notif-3` — white notification cards with stagger indent/opacity
- `.service-notif-icon` / `.service-notif-body` / `.service-notif-title` / `.service-notif-desc` / `.service-notif-check`
- `.hero-service-chips` — flex wrap centered
- `.hero-chip` — pill with semi-transparent bg and border

### Fixes
- `.plan-service-name` — added `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`
- `.plan-services` — reduced padding from `1rem 1.25rem` to `0.875rem 1rem`
- `.plan-service-check` / `.plan-service-x` — added `flex-shrink: 0`
- `.problem-card p` — added `margin-top: 0.25rem; line-height: 1.7`
- `.step p` — added `margin-top: 0.25rem; line-height: 1.7`

### Mobile Overhaul (comprehensive)
- Hero: column layout, h1 at text-3xl, sub at text-base, actions stack vertically full-width
- Service chips: centered flex-wrap with smaller font (0.75rem)
- `.service-notif-2` / `.service-notif-3`: no margin-left, opacity 1 on mobile
- All sections: padding reduced to `3rem 0`
- CTA final: h2 at text-2xl, buttons full-width stacked
- How-powered: app nodes get smaller padding, flow goes vertical

---

## CSS — pricing.css Additions

- Mobile: comprehensive overhaul — hero smaller, zapier notice stacks, plan sections tighter, plan inner goes 1-col, video-after-purchase stacks vertically
