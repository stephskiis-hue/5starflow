# Moving the website jobs from the MSI PC to the server

Do these in order. Nothing here needs the PC to stay on afterwards.

## Before the first server publish
1. **Server FTP login.** On the 5StarFlow Website Audit page, save the website's FTP login (the same host, user, password and `public_html` folder the PC uses; they are in `_blog-ftp.env` on the PC). The password is stored encrypted when `FTP_ENCRYPTION_KEY` (32 characters) is set on Railway: check that it is.
2. **Hero photos (optional).** Add `PEXELS_API_KEY` on Railway if you want stock photos as a fallback (the writer prefers your vault photos).
3. **Read the dry run.** Signed in as the owner, call `POST /api/ai/seo/site/rebuild-index?dry=1`. It lists what the server would change in `posts.json`, `blog.html` and the sitemaps, and which URLs it would add or remove. Expect `changed: []` when the live files are already right. Anything else should make sense before you go on.
4. **Retire the PC jobs.** Until you do, the server refuses to publish (the PC's nightly rebuild and 3 AM upload would overwrite its work):
   - On the PC, remove the Claude desktop blog task and the Task Scheduler entry for the 3 AM `_deploy.py` upload, plus the two "5StarFlow Ollama" tasks.
   - In AI Command, turn off **Website sitemap + blog index rebuild (MSI)** (`ext-seo-site-nightly`) and **Local model worker (Ollama on MSI)** (`local-ollama-worker`).
   - In the website's GitHub repo, disable `.github/workflows/deploy.yml`: its `mirror --delete` would erase everything published since June.
5. **Turn on the daily index job.** `PATCH /api/ai/seo/config {"siteIndexAuto": true}` (until then `site-publish-index` only reports what it would change).

## The new writer
6. Create the claude.ai routine from `backend/ai/prompts/blog-autopilot.md` (daily, about 10:00 am Winnipeg, repo attached), record its `trig_` id in `backend/ai/registry.js`, and turn off the old PC task.
7. Turn on **Inbox Watch** if you want SMS reply drafts back (paste the new `backend/ai/prompts/inbox-watch.md`): with autonomy `draft` it writes the reply into each customer's task and sends nothing.

## Afterwards
- Undo a bad publish: `POST /api/ai/seo/site/restore {"path": "blog.html"}` puts the newest saved version of a file back (the server keeps the last 5 of every text file it changes).
- Rollback to the PC: re-enable the PC tasks and the two routines, and set `SITE_PUBLISH_FORCE` off (default).
