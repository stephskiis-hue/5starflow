# Project Overview — 5StarFlow

## What It Is

**5StarFlow** is a marketing/landing page for an automation **bundle** for home service businesses (landscapers, cleaners, pressure washers, etc.). The service automates 3 things via Zapier workflows:

1. **Google Review Requests** — triggered when an invoice is paid
2. **Instant Lead Replies** — triggered when a new form submission arrives
3. **Google Business Profile Posting** — triggered on a schedule

## Positioning

Marketed as a complete 3-service bundle. NOT just a review tool. NOT just for Jobber.
Works with any invoicing/CRM/payment system that has a Zapier integration:
QuickBooks, Xero, Stripe, Square, Jobber, Housecall Pro, Dubsado, FreshBooks, etc.

## Target Customer

Home service business owners. Non-technical. Jobber is most common but the site is platform-agnostic.

## Business Model — Pricing Plans

| Plan | Price | Type |
|---|---|---|
| DIY Setup | $99 one-time | User sets up with provided template |
| Done For You | $299 one-time | Team sets up all 3 services (most popular) |
| Fully Managed | $49/month | Team hosts and runs everything, no Zapier account needed |

**Contact email:** hello@5starflow.com — all purchase CTAs are `mailto:` links. No payment processor yet.

## Pages

- `index.html` — Main landing page
- `pricing.html` — Full pricing detail (each plan has its own section)
- `case-study.html` — Client case study
- `thankyou-k4r9x2m7qp.html` — Post-conversion thank-you
- `privacy.html`, `terms.html` — Legal pages

## Tech Stack

- Pure HTML5, CSS3 (custom properties), vanilla JS
- **No npm, no bundler, no framework** — static site only
- Font: Inter via Google Fonts (weights 400/500/600/700/800)
- Container: max-width 1100px, padding 0 1.5rem

## Breakpoints

- Mobile: `< 768px`
- Tablet: `768px–1024px`
- Desktop: `> 1024px`

## File Map

```
index.html
pricing.html
case-study.html
thankyou-k4r9x2m7qp.html
privacy.html
terms.html
css/
  styles.css       — global styles (all pages)
  pricing.css      — pricing page + shared nav dropdown styles
js/
  main.js          — nav toggle, FAQ accordion, scroll reveal, ROI calculator
images/            — images folder
```
