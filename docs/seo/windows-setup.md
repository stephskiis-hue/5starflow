# SEO Growth Engine: setup on the MSI PC (for the local Claude)

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

## 1. Search Console access (the owner, 2 minutes; Claude in Chrome can click it)
1. Open SEO Growth in 5StarFlow. The setup card shows the service account email.
2. Search Console > the `https://www.no-bs-yardwork.com/` property > Settings > Users and permissions > Add user > that email > permission **Full** (Restricted cannot submit sitemaps).
3. If the card says there is no service account: Google Cloud console > IAM & Admin > Service Accounts > create one, add a JSON key, enable "Google Search Console API" in that project, then put `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY` on Railway.
4. Railway variables: `SEO_SUBMIT=on` (production runs with DRY_RUN, which would otherwise only log sitemap submits), `GSC_SITE_URL=https://www.no-bs-yardwork.com/`, and confirm `SERPER_API_KEY` is set (keyword discovery + weekly Google and map-pack rank checks; about 150 calls a week).
5. Press **Sync now** on SEO Growth. The setup card disappears when it works.

## 2. One-time site fixes (found by the first crawl; each one is also a task on SEO Growth > Index health)
Open SEO Growth > Index health for the current lists. On 2026-10-10 they were:

| Problem | Fix |
|---|---|
| `sitemap.xml` frozen since 2026-04-18 with 16 `.html` URLs that 301 | step 3 rebuilds it from the real files on every deploy |
| `https://no-bs-yardwork.com/` answers 200 (duplicate site) | `.htaccess`, top: `RewriteEngine On` / `RewriteCond %{HTTPS} off [OR]` / `RewriteCond %{HTTP_HOST} !^www\. [NC]` / `RewriteRule ^ https://www.no-bs-yardwork.com%{REQUEST_URI} [L,R=301]` |
| Duplicate pages: `/premium-lawn-care` = `/lawn-care-premium` = `/premium-packages`; `/basic-packages` vs `/lawn-care-winnipeg`; `/Spring-Fall-Cleanups` = `/spring-fall-cleanups` | Compare them, keep the best one (ask the owner if unsure), merge anything useful into it, then `Redirect 301 /lawn-care-premium /premium-lawn-care` (etc.) in `.htaccess`, and fix the links that point at the old ones. `build-sitemaps` reads these redirects and keeps them out of the sitemap |
| 20 pages whose canonical is a `.html` URL (which redirects) or missing | Every page: `<link rel="canonical" href="https://www.no-bs-yardwork.com/<file name without .html>">` (home: `.../`) |
| Broken links: `/lawn-care-basic` (404, linked from lawn-care-premium), `blog/partnership-opportunities` (500, a relative link on the spring/fall cleanup page) | Point them at real pages; use root-relative links (`/partnership-opportunities`) |
| 11 live posts missing from posts.json and blog.html; 35 posts with no link to them | step 2b + `blog-index` (step 3) |
| Internal links use `.html` (each one is a redirect hop) | Optional but good: nav/footer links to the clean URLs |

### 2b. blog.html markers (once)
`blog-index` keeps three things in sync from the real post files: `posts.json`, the page's own `var POSTS = [...]` array, and a crawlable `<ul>` of every post (search engines do not wait for the JS cards). Add, once:
1. Just before `<div id="blog-posts-container">`: `<!-- seo:post-list:start -->` and `<!-- seo:post-list:end -->` on two lines.
2. Wrap the array literal: `var POSTS = /* seo:posts:start */[` ... `]/* seo:posts:end */;`
3. A small style for `.seo-post-list` in the page CSS (a simple two-column list under the cards is fine; it must stay visible, not `display:none`).
Then `python seo_site.py blog-index "SITE" --dry-run` should list the 11 posts it adds.

## 3. `_deploy.py` (the 3 AM upload)
Before the upload:
```
python <FSF_REPO>\backend\ai\prompts\msi\seo_site.py blog-index "SITE"
python <FSF_REPO>\backend\ai\prompts\msi\seo_site.py build-sitemaps "SITE"
```
`build-sitemaps` writes `sitemap.xml` (pages), `blog-sitemap.xml` (posts) and `sitemap_index.xml` from the files that are really there: clean URLs, lastmod that only moves when a page's text changes (it keeps `_sitemap-state.json`), and it leaves out noindex pages, `.htaccess` 301 sources, canonical-elsewhere pages, case duplicates and anything listed in `_sitemap-exclude.txt`. Both commands only rewrite files that changed, so the deploy uploads them only when needed.
Make sure those five files are in the upload set when changed (`sitemap.xml`, `blog-sitemap.xml`, `sitemap_index.xml`, `posts.json`, `blog.html`), and that `_sitemap-state.json`, `_sitemap-exclude.txt`, `_blog-*` and `.htaccess`-backup files are never uploaded.
After a successful upload:
```
python <FSF_REPO>\backend\ai\prompts\msi\seo_site.py sitemaps-check
```
That tells 5StarFlow to re-read the live sitemaps and submit any that changed to Google (and new URLs to Bing via IndexNow). Log the JSON line to `_deploy.log`. The server also checks daily at 6:23 am, so a missed call is caught the next morning.

## 4. `_blog-autopilot.py`
- **One generator:** replace its own sitemap / posts.json / `POSTS` editing with the two `seo_site.py` calls from step 3, run right after it writes the post (so the post, the image, posts.json, blog.html and the sitemaps go up together by FTP, as today).
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
- `seo_site.py build-sitemaps "SITE" --dry-run` lists every page (no `.html` URLs) and what it skipped and why.
- After the next run: SEO Growth > Content log shows the post; Index health shows the sitemaps as submitted and, within a few days, "Google read it"; the issue list shrinks as the fixes go live (tasks close themselves).
- `~/.5starflow/seo-site.log` has one line per helper call; `~/.5starflow/seo-pending.jsonl` should stay empty (it holds publish reports that could not be sent).
