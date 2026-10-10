# SEO setup on the MSI PC (the owner's request)

The owner asked, from the 5StarFlow request box: "git pull the 5starflow repo and follow docs/seo/pc-request.md".
That request is the go-ahead for everything below. Work through the steps in order. After each step, write one line of what you did; the final PATCH response is those lines.

**Rules (the same as `request-inbox.md`):**
- Never type a password, a 2FA code or card details. A login, 2FA or CAPTCHA screen is a stop: mark that step `needs_owner` and carry on with the rest.
- Never delete a page. A duplicate is only redirected.
- Back up anything before you change it.

Background on why: `docs/seo/windows-setup.md`.

**Folders:**
- `SITE` = `C:\Users\steph\Desktop\No-Bs Yardwork\Website Stuff\public_html`
- `REPO` = this checkout (`FSF_REPO` in `~/.5starflow/env`; the request gate adds it)

## 1. Search Console access (Claude in Chrome)
1. Open https://search.google.com/search-console/users?resource_id=https%3A%2F%2Fwww.no-bs-yardwork.com%2F
2. Add user: `google-analytics-api-service@axial-analyzer-420702.iam.gserviceaccount.com`, permission **Full**, then save.
3. If a `sc-domain:no-bs-yardwork.com` property also exists in the property picker, add the same user there too.
4. Check it: `python REPO\backend\ai\prompts\msi\seo_site.py check` should show `"propertyFound": true` within a minute or two. The API was turned on 2026-10-10.

## 2. Backup
Zip `SITE` to `~\.5starflow\site-backup-<date>.zip`. Keep a separate copy of `SITE\.htaccess` as `~\.5starflow\htaccess-<date>.bak`.

## 3. `.htaccess` redirects (verify live, revert on any error)
Edit `SITE\.htaccess`. Put these lines directly after the first `RewriteEngine On`, or add `RewriteEngine On` at the top if there is none. Do not touch the existing rules.
```
# --- SEO: one address for the whole site (added by the SEO setup) ---
RewriteCond %{HTTPS} off [OR]
RewriteCond %{HTTP_HOST} !^www\. [NC]
RewriteRule ^ https://www.no-bs-yardwork.com%{REQUEST_URI} [L,R=301]
# --- SEO: duplicates of real pages ---
RewriteRule ^Spring-Fall-Cleanups(\.html)?$ /spring-fall-cleanups [L,R=301]
RewriteRule ^lawn-care-premium(\.html)?$ /premium-lawn-care [L,R=301,NC]
RewriteRule ^premium-packages(\.html)?$ /premium-lawn-care [L,R=301,NC]
```
- **Spring-Fall-Cleanups:** the rule is case-sensitive on purpose. It matches only the upper-case address, so the lowercase page is unaffected.
- **basic-packages:** leave it. It may be a real packages page, so ask the owner in the final response.

Upload `.htaccess` by FTP **now**, the same way `_deploy.py` connects; read its settings, never ask for a password. Then check with `curl -s -o NUL -w "%{http_code} %{redirect_url}\n" <url>`:

| URL | Expected |
|---|---|
| `https://www.no-bs-yardwork.com/` | 200 |
| `https://www.no-bs-yardwork.com/blog` | 200 |
| `https://www.no-bs-yardwork.com/spring-fall-cleanups` | 200 |
| `https://www.no-bs-yardwork.com/contact` | 200 |
| `https://www.no-bs-yardwork.com/blog-fence-repair-cost-winnipeg` | 200 |
| `https://no-bs-yardwork.com/` | 301 → `https://www.no-bs-yardwork.com/` |
| `http://www.no-bs-yardwork.com/` | 301 → `https://www.no-bs-yardwork.com/` |
| `https://www.no-bs-yardwork.com/Spring-Fall-Cleanups` | 301 → `/spring-fall-cleanups` |
| `https://www.no-bs-yardwork.com/lawn-care-premium` | 301 → `/premium-lawn-care` |
| `https://www.no-bs-yardwork.com/premium-lawn-care` | 200 |

**Any 500, any redirect loop (more than 2 hops), or any wrong target:**
1. Upload the saved copy back at once.
2. Re-check that `/` is 200.
3. Restore the local file from the copy too.
4. Report the exact curl lines.

Don't try a second variant. That decision goes to the owner.

Then fix the links that point at the redirected pages. On `lawn-care-premium.html`, the link `lawn-care-basic.html` is a 404; point it at `/lawn-care-winnipeg`. Change only `href` values.

## 4. `blog.html`: crawlable post list
1. Just before `<div id="blog-posts-container">`, add two lines: `<!-- seo:post-list:start -->` and `<!-- seo:post-list:end -->`.
2. Change `var POSTS = [` to `var POSTS = /* seo:posts:start */[`, and its closing `];` to `]/* seo:posts:end */;`.
3. Add a small visible style for `.seo-post-list` in the page's CSS, using the site's existing variables: a two-column list of links under the cards, one column on mobile. It must not be hidden.
4. Run `python REPO\backend\ai\prompts\msi\seo_site.py nightly --dry-run`. Check it plans to add the 11 posts and to fill the list. Then run it for real.
5. Open `blog.html` in Chrome from `SITE` and check the cards still render and the list shows.

The nightly run also fixes the canonical tags and the broken `/blog/partnership-opportunities` link on its own (`fixPages` in `seo-site.json`).

## 5. `_blog-autopilot.py` and `_blog-knowledge.md`
Follow `windows-setup.md` sections 4 and 5. Read the script first, keep its current behaviour, and back it up as `_blog-autopilot.py.bak-<date>`.

`--refresh` and `--page` are new. Implement them only if the script structure makes that clear. Otherwise leave them out and say so: the blog task can still do refreshes by rewriting the file itself.

## 6. The blog scheduled task prompt
1. Find the scheduled task under `~\.claude\scheduled-tasks\` whose SKILL.md runs `_blog-autopilot.py`.
2. Back up that SKILL.md.
3. Keep its frontmatter (the lines between `---`) and replace the body with the prompt block (inside the ``` fence) from `REPO\backend\ai\prompts\blog-autopilot.md`.

If no such task exists or the file can't be edited, say so. The owner then pastes it in the Claude desktop app under Scheduled tasks.

## 7. Finish
1. Upload the changed files: either let the 3 AM deploy do it, or run `_deploy.py` now if it supports a manual run.
2. Run `python REPO\backend\ai\prompts\msi\seo_site.py sitemaps-check`.
3. `PATCH /api/ai/requests/<id>`:
   - `done`, with one short line per step;
   - or `needs_owner`, listing only the steps that need the owner (a login, the basic-packages question, a reverted `.htaccess`).
