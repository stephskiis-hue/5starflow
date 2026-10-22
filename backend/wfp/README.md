# Winnipeg Fence Pros (`backend/wfp/`, `routes/wfp.js`, `winnipeg-fence-pros.html`)

A second business's SEO + blog autopilot, run by the 5StarFlow server with its own page at **`/Winnipeg-Fence-Pros`**
(no portal login). It is a simplified, single-business copy of the No-Bs SEO Growth Engine.

**Completely separate from No-Bs:** its own tables (`WfpSetting`, `WfpKeyword`, `WfpQuery`, `WfpDaily`, `WfpPost`,
`WfpRun`, `WfpNote`, none with a `userId`), its own scheduler and ledger (`wfp/runner.js`, not `ai/runner.js`, so no
No-Bs Routine rows, Tasks, Memory or owner texts), its own settings, its own Serper budget and its own Claude routine.
Nothing in `wfp/` imports `ai/`. The only shared things are the process, Postgres and (when the page leaves them blank)
the server's API keys and Google service account.

```
settings.js   page settings (DB, secrets encrypted) → WFP_<KEY> env → server key → default; publicView() never returns secrets
keywords.js   pure: matchKey, service/intent, CTR curve, priority score, lifecycle, recommendation "why"
google.js     Search Console (page's service account JSON or the server's) + Serper with a weekly budget
research.js   gscSyncTick (daily 7:17) + researchTick (Monday 7:37): import real queries, Serper discovery,
              rank tracking (organic + map pack), weekly history, focus recommendations
focus.js      focus campaigns: main post → supporting posts (PAA / related / GSC queries) → refresh after 21 days
plan.js       pure: nextPiece() (what the writer does next) + roadmap() (the next N pieces on the posting days)
writer.js     Claude on the server: web-search research, then a structured post (JSON schema)
templates.js  default article page, list page and card in the winnipegfencepros.com look (orange + charcoal, Poppins)
template.js   placeholders, body sanitizing, JSON-LD + breadcrumbs, cards, list page, "import a template from a page"
migrate.js    optional one-time move of the old WordPress posts into /articles/ (+ redirect file for WordPress)
publisher.js  writeTick (hourly :25, autopilot) + publishPost → blog_publish.py → sitemap resubmit
blog_publish.py  server version of _blog-autopilot.py: Pexels hero, FTP upload, article list (HTML between markers), sitemap; --batch for the move
health.js     daily 8:05: setup, FTP, sitemap lists every post, posts load, Search Console access, Serper, failures
prompts/weekly-check.md   the Claude routine (claude.ai, weekly) that reviews, adds keywords and writes the report
```

## Blog structure (custom, no WordPress needed)
- Articles are plain HTML at `/articles/<slug>/` (folder URLs, no rewrite rules), the list is `/articles/`.
- Services (Settings → Business) are the blog categories: `Name | page | words people search`. Every keyword gets a service,
  every article is filed under it, links to its page, and the planner alternates between services.
- The list page contains `<!-- 5sf:articles:start -->` / `<!-- 5sf:articles:end -->`: the server rewrites what is between them
  with crawlable cards on every publish (and creates the page from the list template if it does not exist).
- Old WordPress `/blog/` (optional): Posts tab → Preview, then Move. Copies posts + images, adds the new URLs to the sitemap,
  drops the old `/blog/` URLs from it, and (checkbox) writes `blog/wp-content/mu-plugins/wfp-articles-redirects.php` so the old
  links 301 to the new pages while WordPress still runs. Delete that file to undo. Rank Math's CSV import is Pro-only, hence the file.

## Setup (on the page, Settings tab)
1. Business: site URL, logo, menu links, phone, quote page, services, neighbourhoods.
2. FTP: host, user, password, website folder. **Test.**
3. Blog pages: articles folder, list page, the three templates (defaults match the site; "make the article template from a page on the site" imports one).
4. Sitemap: public sitemap URL + the file inside the website folder. Each article is added to that file and the sitemap
   is resubmitted to Search Console. A sitemap index can not be patched: point it at the child sitemap.
5. Search Console: the property, and add the shown service account email as a **Full** user. **Test.**
6. API keys: Anthropic (writer), Serper (discovery + ranks), Pexels (photos). Blank = the server's keys.
7. Autopilot: days, hour, posts per week, `auto` or `review` (drafts wait for Publish). Turn it on last.

Values are stored in Postgres, not written into `.env`: the container's files are replaced on every deploy. Any blank
field falls back to `WFP_<KEY>` in `.env` / Railway (e.g. `WFP_FTP_HOST`).

## Server env
- `WFP_ACCESS_KEY` (optional): require this key on the page and the API (`x-wfp-key`, `Authorization: Bearer`, `?key=`).
  Unset = anyone with the link can use the page.
- `DRY_RUN=true` runs the publisher with `--dry-run` (nothing uploaded) and skips the sitemap submit (`SEO_SUBMIT=on` overrides).
- `WFP_DISABLED=true` stops the scheduler. `PYTHON_BIN` overrides `python3`.

## Claude routine
`prompts/weekly-check.md`, scheduled weekly (Monday 10:00 Winnipeg) on claude.ai against the production URL with
`x-wfp-source: claude`. It reads `GET /api/wfp/brief`, adds researched keywords, retires weak ones, leaves standing
instructions for the writer and posts a report note. It never changes settings or publishes.
