# SEO Growth Engine: setup on the MSI PC (for the local Claude)

> The step-by-step version the owner's request points to is `docs/seo/pc-request.md`. This file is the background.

The 5StarFlow backend now plans the blog (keywords from Serper, Search Console and the site crawl), checks every
page and sitemap daily, submits sitemaps to Google and shows progress on **SEO Growth** (`/seo-growth.html`).
This file is the one-time work on the PC where the site lives:
`C:\Users\steph\Desktop\No-Bs Yardwork\Website Stuff\public_html` (call it `SITE` below).
Show the owner each change before saving, as usual. The repo is pulled hourly by the request gate, so the
helper script and the skill stay current without touching the PC again.

## 0. Before you start
- `~/.5starflow/env` already has `FIVESTARFLOW_URL` and `FIVESTARFLOW_TOKEN`. Add one line: `FSF_REPO=<path to this 5starflow checkout>`.
- `python <FSF_REPO>\backend\ai\prompts\msi\seo_site.py check` must print `"ok": true`. Its `instructions` list says what is still missing on the server side (step 1).
- Back up `SITE` (zip it) before step 2.
- Search Console needs two clicks first (step 1): the API switch in Google Cloud and the user in Search Console.

## 1. Search Console access (the owner, 2 minutes; Claude in Chrome can click it)
Checked on production 2026-10-10: the service account is `google-analytics-api-service@axial-analyzer-420702.iam.gserviceaccount.com` (it signs in fine), `SERPER_API_KEY` is set and DRY_RUN is off, so no Railway variable is needed. Two things are missing:
1. **Turn the API on:** open https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=944252538921 signed in as the Google account that owns that Cloud project, and press **Enable**.
2. **Give it access:** Search Console > property `https://www.no-bs-yardwork.com/` > Settings > Users and permissions > **Add user** > `google-analytics-api-service@axial-analyzer-420702.iam.gserviceaccount.com` > permission **Full** (Restricted cannot submit sitemaps).
3. Press **Sync now** on SEO Growth (or wait for 6:07 am). The setup card disappears when it works; the first sync backfills 16 months.

## 2. One-time site fixes (found by the first crawl; each one is also a task on SEO Growth > Index health)
Open SEO Growth > Index health for the current lists. On 2026-10-10 they were:

| Problem | Fix |
|---|---|
| `sitemap.xml` frozen since 2026-04-18 with 16 `.html` URLs that 301 | step 3 rebuilds it from the real files on every deploy |
| `https://no-bs-yardwork.com/` answers 200 (duplicate site) | `.htaccess`, top: `RewriteEngine On` / `RewriteCond %{HTTPS} off [OR]` / `RewriteCond %{HTTP_HOST} !^www\. [NC]` / `RewriteRule ^ https://www.no-bs-yardwork.com%{REQUEST_URI} [L,R=301]` |
| Duplicate pages: `/premium-lawn-care` = `/lawn-care-premium` = `/premium-packages`; `/basic-packages` vs `/lawn-care-winnipeg`; `/Spring-Fall-Cleanups` = `/spring-fall-cleanups` | Compare them, keep the best one (ask the owner if unsure), merge anything useful into it, then `Redirect 301 /lawn-care-premium /premium-lawn-care` (etc.) in `.htaccess`, and fix the links that point at the old ones. `build-sitemaps` reads these redirects and keeps them out of the sitemap |
| 20 pages whose canonical is a `.html` URL (which redirects) or missing | **Automatic** since 2026-10-10: the nightly job (`fixPages` in `seo-site.json`) sets every self-canonical to the clean URL and adds missing ones; canonicals that point at another page are left for the owner |
| Broken links: `/lawn-care-basic` (404, linked from lawn-care-premium), `.../blog/partnership-opportunities` (500, on the spring/fall cleanup page) | The `/blog/<page>` link is fixed by the nightly job; `lawn-care-basic` is handled in `pc-request.md` step 3 |
| 11 live posts missing from posts.json and blog.html; 35 posts with no link to them | step 2b + `blog-index` (step 3) |
| Internal links use `.html` (each one is a redirect hop) | Optional but good: nav/footer links to the clean URLs |

### 2b. blog.html markers (once)
`blog-index` keeps three things in sync from the real post files: `posts.json`, the page's own `var POSTS = [...]` array, and a crawlable `<ul>` of every post (search engines do not wait for the JS cards). Add, once:
1. Just before `<div id="blog-posts-container">`: `<!-- seo:post-list:start -->` and `<!-- seo:post-list:end -->` on two lines.
2. Wrap the array literal: `var POSTS = /* seo:posts:start */[` ... `]/* seo:posts:end */;`
3. A small style for `.seo-post-list` in the page CSS (a simple two-column list under the cards is fine; it must stay visible, not `display:none`).
Then `python seo_site.py blog-index "SITE" --dry-run` should list the 11 posts it adds.

## 3. Sitemaps + blog index: automatic (nothing to install)
`request-gate.ps1` (already on Task Scheduler, already pulling this repo) runs `seo_site.py nightly` once a day at its first check after 7 pm. It rebuilds, from the files that are really in `SITE`:
- `sitemap.xml` (pages), `blog-sitemap.xml` (posts) and `sitemap_index.xml`: clean URLs, a lastmod that only moves when a page's text changes, and none of the noindex pages, `.htaccess` 301 sources, canonical-elsewhere pages, case duplicates or pages excluded in `backend/ai/prompts/msi/seo-site.json` (the three duplicate lawn-care package pages until they are 301'd);
- `posts.json` from every live `blog-*.html` (adds the posts that were missing), plus the static list and the `POSTS` array in `blog.html` once the markers from 2b exist.

Files are only rewritten when they change; the previous copy goes to `~/.5starflow/seo-backup/<date>/`, the state file is `~/.5starflow/sitemap-state.json` (outside `SITE`, so it is never uploaded) and the log is `~/.5starflow/seo-site.log`. The 3 AM `_deploy.py` uploads the changed files as usual; the server re-reads the live sitemaps at 6:23 am and submits them to Google. The site folder is `siteDir` in `seo-site.json`; override with `SEO_SITE_DIR` (and `PYTHON_BIN` if `python` is not on the PATH) in `~/.5starflow/env`.

Optional, for same-morning submission: at the end of a successful `_deploy.py` upload run `python <FSF_REPO>\backend\ai\prompts\msi\seo_site.py sitemaps-check` and log its JSON line to `_deploy.log`.

## 4. `_blog-autopilot.py`
- **Sitemaps:** it can keep writing `blog-sitemap.xml` and `posts.json` as today; the nightly rebuild reconciles them. Better: after writing a post call `python <FSF_REPO>\backend\ai\prompts\msi\seo_site.py nightly` so the post, its image, posts.json, blog.html and the sitemaps go up together by FTP right away.
- **Template:** canonical = the clean URL; internal links to clean URLs; keep the Article + BreadcrumbList JSON-LD and add `dateModified`.
- **`--refresh <slug>`:** overwrite the existing `blog-<slug>.html` in place (same URL), keep `datePublished`, set `dateModified` to today, keep the image unless a new one is asked for. Do not add a new posts.json entry.
- **`--page <slug>`:** a landing page at `SITE\<slug>.html` built from an existing service page (e.g. `weed-control-winnipeg.html`: same header, nav, footer, quote form, LocalBusiness schema), not added to posts.json or the blog. Add it to the site nav/services page in the same run.
- `CONTENT_TYPES` and `_blog-state.json` stay as the fallback when the API has no assignment or is down.

## 5. `_blog-knowledge.md`
Add a short section at the top:
> Topics, keywords, refreshes and landing pages come from the 5StarFlow SEO engine (`seo_site.py assignment`) and the rules in `.claude/skills/nobs-seo/SKILL.md`. This file keeps the template, tone and title formulas. The keyword list below is now only a seed list: add new target keywords on SEO Growth > Keywords instead.

## 6. The scheduled task
Claude desktop app > Scheduled tasks > the blog task: replace its prompt with the block in `backend/ai/prompts/blog-autopilot.md`, model Sonnet, keep the schedule (daily). It then reads `nobs-seo` from the repo on every run, so later improvements arrive through `git pull`.

## 7. Check it worked
- `python seo_site.py nightly --dry-run` lists every page (no `.html` URLs), what it skipped and why, and what it would rewrite.
- After the next run: SEO Growth > Content log shows the post; Index health shows the sitemaps as submitted and, within a few days, "Google read it"; the issue list shrinks as the fixes go live (tasks close themselves).
- `~/.5starflow/seo-site.log` has one line per helper call; `~/.5starflow/seo-pending.jsonl` should stay empty (it holds publish reports that could not be sent).
