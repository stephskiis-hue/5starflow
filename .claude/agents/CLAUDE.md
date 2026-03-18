# Agents Index

Each agent is a separate file. Claude auto-selects based on the task.

| File | Triggers on |
|---|---|
| `copywriter.md` | Writing/rewriting copy, headlines, CTAs, visible text |
| `ui-reviewer.md` | Auditing HTML/CSS for design system compliance |
| `seo-auditor.md` | SEO, meta tags, title tags, search visibility |
| `debugger.md` | Something broken, not rendering, or not working |
| `coder.md` | Any HTML/CSS/JS implementation task |
| `ui-verifier.md` | Screenshot + visual QA after any HTML/CSS edit |

## Verification Flow

After any HTML or CSS change, the `ui-verifier` agent must run:
1. Takes desktop (1440px) + mobile (390px) screenshots using headless Chrome
2. Reads and inspects both images
3. Fixes anything that looks wrong
4. Re-screenshots until both pass

Screenshots are saved to `.claude/screenshots/`.
