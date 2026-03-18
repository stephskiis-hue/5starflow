# 5StarFlow Website

Marketing website for **5StarFlow** — an automation service for home service businesses using Jobber.

## File Structure

```
5starflow/
├── index.html         ← Main landing page
├── pricing.html       ← Detailed pricing + plan comparison
├── case-study.html    ← Client success story
├── privacy.html       ← Privacy Policy
├── terms.html         ← Terms of Service
├── styles.css         ← Main stylesheet (shared by all pages)
├── pricing.css        ← Pricing page + nav dropdown styles
└── main.js            ← All JavaScript (no libraries)
```

## Design Tokens

| Token | Value | Use |
|-------|-------|-----|
| `--color-primary` | `#1A3C2E` | Nav, headings, footer |
| `--color-primary-dark` | `#0F2219` | Footer bg, dark hover states |
| `--color-accent` | `#D4A017` | Gold CTAs, stars, badges |
| `--color-bg` | `#F9F7F2` | Page background (warm off-white) |
| `--color-surface` | `#FFFFFF` | Cards |
| Font | Inter (Google Fonts) | All text |

## Plans

| Plan | Price | Services | Zapier |
|------|-------|----------|--------|
| DIY Setup | $99 one-time | Review Requests only | Client's free account (50/mo limit) |
| Done For You | $299 one-time | All 3 services | Client buys Zapier Pro |
| Fully Managed | $49/month | All 3 services | We buy + manage Pro for client |

## The 3 Services
1. ★ **Automated Review Requests** — Sends a review ask after every paid Jobber invoice
2. ⚡ **Instant Lead Response** — Auto-replies to website contact forms in seconds
3. 📍 **Google Business Profile Posting** — Posts to GBP on a schedule to boost local SEO

## Contact / CTA
All buttons use `mailto:hello@5starflow.com` with pre-filled subjects.
Replace with a real payment link or booking system when ready.

## TODO
- [ ] Replace YouTube video placeholder in pricing.html DIY section with real URL
- [ ] Replace Calendly placeholder with real booking link
- [ ] Replace email capture form with real Mailchimp/ConvertKit embed
- [ ] Add real testimonials when available
- [ ] Add Jobber, Google, Zapier logo images to trust badges section
- [ ] Deploy to a real domain (Netlify, GitHub Pages, Vercel — all work with static HTML)

## How to Edit
- Open any `.html` file in VS Code and edit the text directly
- Colors and fonts are controlled in `styles.css` at the top under `:root {}`
- No build step needed — just refresh the browser
