#!/usr/bin/env python3
"""
blog_publish.py
---------------
Winnipeg Fence Pros blog publisher, run by the 5StarFlow server (backend/wfp/publisher.js) after Claude writes a post.
Server-side version of the No-Bs _blog-autopilot.py: same steps, but the server has no copy of the site, so the
blog index and the sitemap are read from the FTP server, patched and uploaded again.

  1. Fetch a Pexels hero photo (or use the fallback image, or drop the hero block)
  2. FTP upload the hero image + the post HTML
  3. Rebuild the article list page between its <!-- 5sf:articles:start/end --> markers (crawlable HTML cards the
     server rendered; or the old inline `var POSTS = [...]` array; or create the page from a template)
  4. Add the post URL to the sitemap file (read from FTP, re-uploaded)
  --batch manifest.json uploads many files at once (the one-time WordPress move): one FTP session, one list
  rebuild, one sitemap edit that can also drop the old /blog/ URLs.
  5. Print one line `WFP_RESULT {json}` for the server

Credentials come from the environment (the server passes the page's settings):
  FTP_HOST FTP_PORT FTP_USER FTP_PASS FTP_PATH FTP_SECURE PEXELS_API_KEY

Usage:
  python3 blog_publish.py --workdir /tmp/wfp-x --file slug.html --slug slug --title "..." --date 2026-10-21 \
    --category Fencing --excerpt "..." --readtime 6 --image /images/slug.webp --url-path /slug.html \
    --public-url https://site/slug.html [--fetch-image "cedar fence"] [--fallback-image /images/x.jpg] \
    [--blog-dir blog] [--blog-index blog.html] [--sitemap-file sitemap.xml] [--dry-run]
"""

import argparse
import ftplib
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 5StarFlow-WFP-Blog/1.0"
RESULT = {"ok": False, "uploaded": [], "warnings": []}


def warn(msg):
    print(f"  WARN {msg}")
    RESULT["warnings"].append(msg)


def finish(ok, **extra):
    RESULT.update(extra)
    RESULT["ok"] = ok
    print("WFP_RESULT " + json.dumps(RESULT))
    sys.exit(0 if ok else 1)


def load_env() -> dict:
    keys = ["FTP_HOST", "FTP_PORT", "FTP_USER", "FTP_PASS", "FTP_PATH", "FTP_SECURE", "PEXELS_API_KEY"]
    return {k: os.environ.get(k, "") for k in keys}


# ── Pexels image fetch ─────────────────────────────────────────────────────────

def fetch_pexels_image(keywords: str, local_path: Path, env: dict) -> bool:
    api_key = env.get("PEXELS_API_KEY", "")
    if not api_key:
        warn("PEXELS_API_KEY not set -- no hero photo fetched")
        return False
    try:
        from PIL import Image as PILImage
    except ImportError:
        warn("Pillow not installed -- no hero photo fetched")
        return False

    url = f"https://api.pexels.com/v1/search?query={urllib.parse.quote(keywords)}&per_page=15&orientation=landscape"
    req = urllib.request.Request(url, headers={"Authorization": api_key, "User-Agent": BROWSER_UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        warn(f"Pexels API {e.code} {e.reason}")
        return False
    except Exception as e:
        warn(f"Pexels API error: {e}")
        return False

    photos = data.get("photos", [])
    if not photos:
        warn(f"No Pexels results for '{keywords}'")
        return False
    photo = next((p for p in photos if p.get("width", 0) > p.get("height", 1)), photos[0])
    img_url = photo["src"].get("large2x") or photo["src"]["large"]
    print(f"  PHOTO Pexels -- {photo.get('photographer')}: {img_url}")
    try:
        with urllib.request.urlopen(urllib.request.Request(img_url, headers={"User-Agent": BROWSER_UA}), timeout=30) as r:
            raw = r.read()
        img = PILImage.open(io.BytesIO(raw)).convert("RGB")
        if img.width > 1200:
            ratio = 1200 / img.width
            img = img.resize((1200, int(img.height * ratio)), PILImage.LANCZOS)
        local_path.parent.mkdir(parents=True, exist_ok=True)
        img.save(str(local_path), "WEBP", quality=85)
        print(f"  SAVED {local_path.name} ({img.width}x{img.height})")
        RESULT["photographer"] = photo.get("photographer")
        RESULT["photoUrl"] = photo.get("url")
        return True
    except Exception as e:
        warn(f"Image download/convert failed: {e}")
        return False


# ── Blog index (var POSTS = [...]) ─────────────────────────────────────────────

POSTS_RE = re.compile(r"var POSTS\s*=\s*\[(.*?)\];", re.DOTALL)
FIELD_RE = re.compile(r"""(\w+)\s*:\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|(-?\d+(?:\.\d+)?))""")


def _unescape(s: str) -> str:
    return re.sub(r"\\(.)", r"\1", s)


def parse_posts(html: str):
    """The entries of the inline POSTS array, or None when there is no array or it can not be read safely."""
    m = POSTS_RE.search(html)
    if not m:
        return None
    body = m.group(1)
    objects = re.findall(r"\{(.*?)\}", body, re.DOTALL)
    if body.strip() and not objects:
        return None
    posts = []
    for obj in objects:
        entry = {}
        for k, sq, dq, num in FIELD_RE.findall(obj):
            if num:
                entry[k] = int(float(num)) if k == "readTime" else num
            else:
                entry[k] = _unescape(sq if sq or not dq else dq)
        if entry.get("url"):
            posts.append(entry)
    if len(posts) != len(objects):
        return None  # something we do not understand: never rewrite (and lose) the list
    return posts


def render_posts(posts) -> str:
    def js(s):
        return str(s).replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ")

    lines = ["["]
    for i, p in enumerate(posts):
        comma = "" if i == len(posts) - 1 else ","
        lines.append(
            "        {\n"
            f"          title:    '{js(p.get('title', ''))}',\n"
            f"          date:     '{js(p.get('date', ''))}',\n"
            f"          image:    '{js(p.get('image', ''))}',\n"
            f"          excerpt:  '{js(p.get('excerpt', ''))}',\n"
            f"          url:      '{js(p.get('url', ''))}',\n"
            f"          category: '{js(p.get('category', ''))}',\n"
            f"          readTime: {int(p.get('readTime') or 5)}\n"
            f"        }}{comma}"
        )
    lines.append("      ]")
    return "\n".join(lines)


def patch_posts(html: str, entry: dict):
    """(new_html, count) with entry added (or replaced by url), newest first; (None, reason) when not patchable."""
    posts = parse_posts(html)
    if posts is None:
        return None, "no readable 'var POSTS = [...]' array"
    posts = [p for p in posts if p.get("url") != entry["url"]]
    posts.insert(0, entry)
    posts.sort(key=lambda p: p.get("date", ""), reverse=True)
    new_html = POSTS_RE.sub(lambda _m: f"var POSTS = {render_posts(posts)};", html, count=1)
    return new_html, len(posts)


# ── Article list page (cards between markers) ─────────────────────────────────

MARK_RE = re.compile(r"(<!--\s*5sf:articles:start\s*-->)(.*?)(<!--\s*5sf:articles:end\s*-->)", re.S)


def apply_cards(html: str, cards: str):
    """html with the cards between the markers replaced; None when the page has no markers."""
    if not MARK_RE.search(html):
        return None
    return MARK_RE.sub(lambda m: f"{m.group(1)}\n{cards}\n{m.group(3)}", html, count=1)


def update_index(existing, cards, template, entry):
    """(new_html, how) for the list page, or (None, why). existing: current page text or None when it is missing."""
    if existing is None:
        if template is None:
            return None, "list page not found and no template to create it from"
        built = apply_cards(template, cards)
        return (built, "created") if built else (None, "the list template has no <!-- 5sf:articles:start/end --> markers")
    if cards is not None:
        done = apply_cards(existing, cards)
        if done is not None:
            return done, "markers"
    if entry:
        new_html, info = patch_posts(existing, entry)
        if new_html is not None:
            return new_html, "posts-array"
    return None, "the list page has neither article markers nor a 'var POSTS' array"


# ── Sitemap ────────────────────────────────────────────────────────────────────

def patch_sitemap(xml: str, url: str, date: str):
    """(new_xml, action) adding url (or updating its lastmod); (None, reason) for a sitemap index or bad file."""
    if re.search(r"<sitemapindex", xml, re.I):
        return None, "the sitemap file is a sitemap index: set the child sitemap file that lists pages"
    if not re.search(r"</urlset>", xml, re.I):
        return None, "no </urlset> in the sitemap file"
    esc = url.replace("&", "&amp;")
    block = re.search(r"<url>\s*<loc>\s*" + re.escape(esc) + r"\s*</loc>.*?</url>", xml, re.S)
    if block:
        old = block.group(0)
        if "<lastmod>" in old:
            new = re.sub(r"<lastmod>[^<]*</lastmod>", f"<lastmod>{date}</lastmod>", old)
        else:
            new = old.replace("</loc>", f"</loc>\n    <lastmod>{date}</lastmod>", 1)
        return xml.replace(old, new, 1), "updated"
    entry = f"  <url>\n    <loc>{esc}</loc>\n    <lastmod>{date}</lastmod>\n  </url>\n"
    idx = xml.lower().rfind("</urlset>")
    return xml[:idx] + entry + xml[idx:], "added"


def remove_sitemap_urls(xml: str, prefixes):
    """(new_xml, removed_count) dropping every <url> whose <loc> starts with one of the prefixes."""
    removed = 0

    def drop(m):
        nonlocal removed
        loc = re.search(r"<loc>\s*([^<\s]+)\s*</loc>", m.group(0))
        if loc and any(loc.group(1).replace("&amp;", "&").startswith(p) for p in prefixes):
            removed += 1
            return ""
        return m.group(0)

    return re.sub(r"[ \t]*<url>.*?</url>[ \t]*\n?", drop, xml, flags=re.S), removed


# ── FTP helpers ────────────────────────────────────────────────────────────────

def remote(env: dict, *parts) -> str:
    base = (env.get("FTP_PATH") or "/").rstrip("/")
    rest = "/".join(p.strip("/") for p in parts if p and p.strip("/"))
    return f"{base}/{rest}" if rest else (base or "/")


def ftp_connect(env: dict):
    secure = env.get("FTP_SECURE", "").lower() in ("1", "true", "on", "yes")
    ftp = ftplib.FTP_TLS() if secure else ftplib.FTP()
    ftp.connect(env["FTP_HOST"], int(env.get("FTP_PORT") or 21), timeout=30)
    ftp.login(env["FTP_USER"], env["FTP_PASS"])
    if secure:
        ftp.prot_p()
    ftp.set_pasv(True)
    print(f"FTP connected to {env['FTP_HOST']}")
    return ftp


def ftp_read(ftp, path: str):
    buf = io.BytesIO()
    try:
        ftp.retrbinary(f"RETR {path}", buf.write)
    except ftplib.error_perm:
        return None
    return buf.getvalue().decode("utf-8", errors="replace")


def ftp_write(ftp, path: str, data: bytes):
    ftp.storbinary(f"STOR {path}", io.BytesIO(data))
    print(f"  UP {path}")
    RESULT["uploaded"].append(path)


def ensure_dir(ftp, path: str):
    """Make path and every missing parent folder."""
    parts = [p for p in path.split("/") if p]
    cur = "/" if path.startswith("/") else ""
    for part in parts:
        cur = f"{cur.rstrip('/')}/{part}" if cur else part
        try:
            ftp.cwd(cur)
        except ftplib.error_perm:
            ftp.mkd(cur)
            print(f"  MKDIR {cur}")


# ── Main ───────────────────────────────────────────────────────────────────────

def read_local(work: Path, name: str):
    if not name:
        return None
    f = work / name
    return f.read_text(encoding="utf-8") if f.exists() else None


IMG_TOKEN = "__WFP_IMAGE__"


def fix_card_image(cards, image: str):
    """The server can not know a new post's final hero image (Pexels may fail): it sends a token, we fill it in."""
    if cards is None:
        return None
    if image:
        return cards.replace(IMG_TOKEN, image)
    return re.sub(r"<img[^>]*" + IMG_TOKEN + r"[^>]*>", "", cards).replace(IMG_TOKEN, "")


def upload_index(ftp, env, index_file, cards, template, entry):
    """Rebuild the article list page on the server. Returns how it was done, or None (with a warning)."""
    if not index_file or (cards is None and not entry):
        return None
    path = remote(env, index_file)
    existing = ftp_read(ftp, path)
    new_html, how = update_index(existing, cards, template, entry)
    if new_html is None:
        warn(f"list page {path} not updated: {how}")
        return None
    ensure_dir(ftp, os.path.dirname(path))
    ftp_write(ftp, path, new_html.encode("utf-8"))
    return how


def upload_sitemap(ftp, env, sitemap_file, adds, remove_prefixes):
    """Add/refresh URLs and drop old ones in the sitemap file. adds: [(url, date)]. Returns a short report or None."""
    if not sitemap_file:
        return None
    path = remote(env, sitemap_file)
    xml = ftp_read(ftp, path)
    if xml is None:
        warn(f"sitemap {path} not found -- not updated")
        return None
    report = {"added": 0, "updated": 0, "removed": 0}
    if remove_prefixes:
        xml, report["removed"] = remove_sitemap_urls(xml, remove_prefixes)
    for url, date in adds:
        new_xml, action = patch_sitemap(xml, url, date)
        if new_xml is None:
            warn(f"sitemap not updated: {action}")
            return None
        xml = new_xml
        report[action] += 1
    ftp_write(ftp, path, xml.encode("utf-8"))
    return report


def run_batch(args, env):
    """One FTP session for many files: the one-time move of the WordPress posts."""
    work = Path(args.workdir)
    m = json.loads((work / args.batch).read_text(encoding="utf-8"))
    if args.dry_run:
        print(f"DRY RUN: would upload {len(m['uploads'])} files")
        finish(True, dryRun=True, uploads=len(m["uploads"]))
    try:
        ftp = ftp_connect(env)
    except ftplib.all_errors as e:
        finish(False, error=f"FTP connection failed: {e}")
    try:
        for u in m["uploads"]:
            target = remote(env, u["remote"])
            ensure_dir(ftp, os.path.dirname(target))
            ftp_write(ftp, target, (work / u["local"]).read_bytes())
        how = upload_index(ftp, env, m.get("indexFile"), read_local(work, m.get("cardsFile")), read_local(work, m.get("indexTemplateFile")), None)
        sm = upload_sitemap(ftp, env, m.get("sitemapFile"), [(a["url"], a["date"]) for a in m.get("sitemapAdd", [])], m.get("sitemapRemovePrefixes", []))
        ftp.quit()
    except ftplib.all_errors as e:
        finish(False, error=f"FTP error: {e}")
    finish(True, index=how, sitemap=sm, uploads=len(m["uploads"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--batch", default=None, help="manifest.json in the workdir: upload many files at once")
    ap.add_argument("--file")
    ap.add_argument("--slug")
    ap.add_argument("--title")
    ap.add_argument("--date")
    ap.add_argument("--category")
    ap.add_argument("--excerpt")
    ap.add_argument("--readtime", type=int)
    ap.add_argument("--image", help="Site path the HTML uses for the hero, e.g. /images/slug.webp")
    ap.add_argument("--url-path", help="Path the article list links to, e.g. /articles/slug/")
    ap.add_argument("--public-url")
    ap.add_argument("--fetch-image", default=None, help="Pexels search words")
    ap.add_argument("--fallback-image", default="")
    ap.add_argument("--blog-dir", default="", help="Remote folder (inside the website folder) the HTML file goes to")
    ap.add_argument("--blog-index", default="", help="Article list page inside the website folder")
    ap.add_argument("--cards-file", default="", help="Rendered cards HTML (workdir) for the list page markers")
    ap.add_argument("--index-template-file", default="", help="Full list page (workdir), used when the page does not exist")
    ap.add_argument("--sitemap-file", default="")
    ap.add_argument("--keep-image", action="store_true", help="Refresh: the hero is already on the server")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    env = load_env()
    if args.batch:
        run_batch(args, env)
        return
    missing = [k for k in ("file", "slug", "title", "date", "category", "excerpt", "readtime", "image", "url_path", "public_url") if getattr(args, k) in (None, "")]
    if missing:
        finish(False, error="missing arguments: " + ", ".join(missing))

    work = Path(args.workdir)
    html_path = work / args.file
    if not html_path.exists():
        finish(False, error=f"HTML file '{args.file}' not found")
    html = html_path.read_text(encoding="utf-8")

    # ── hero image ────────────────────────────────────────────────────────────
    image = args.image
    local_img = work / args.image.lstrip("/")
    have_image = args.keep_image
    if not have_image and args.fetch_image:
        have_image = fetch_pexels_image(args.fetch_image, local_img, env)
    if not have_image:
        if args.fallback_image:
            fb = "/" + args.fallback_image.lstrip("/") if not args.fallback_image.startswith("http") else args.fallback_image
            html = html.replace(args.image, fb)
            image = fb
            print(f"  IMAGE using fallback {fb}")
        else:
            html = re.sub(r"<!--HERO-->.*?<!--/HERO-->", "", html, flags=re.S)
            image = ""
            warn("no hero image: the hero block was removed")
    RESULT["image"] = image
    html_path.write_text(html, encoding="utf-8")

    entry = {
        "title": args.title, "date": args.date, "image": image, "excerpt": args.excerpt[:200],
        "url": args.url_path, "category": args.category, "readTime": args.readtime,
    }

    if args.dry_run:
        print("DRY RUN: nothing uploaded (DRY_RUN=true on the server)")
        finish(True, dryRun=True, url=args.public_url, entry=entry)

    for k in ("FTP_HOST", "FTP_USER", "FTP_PASS"):
        if not env.get(k):
            finish(False, error=f"{k} is not set")

    try:
        ftp = ftp_connect(env)
    except ftplib.all_errors as e:
        finish(False, error=f"FTP connection failed: {e}")

    try:
        if have_image and not args.keep_image and local_img.exists():
            img_dir = remote(env, os.path.dirname(args.image))
            ensure_dir(ftp, img_dir)
            ftp_write(ftp, f"{img_dir}/{local_img.name}", local_img.read_bytes())

        post_dir = remote(env, args.blog_dir)
        if args.blog_dir:
            ensure_dir(ftp, post_dir)
        ftp_write(ftp, f"{post_dir}/{args.file}", html.encode("utf-8"))

        cards = fix_card_image(read_local(work, args.cards_file), image)
        template = fix_card_image(read_local(work, args.index_template_file), image)
        how = upload_index(ftp, env, args.blog_index, cards, template, entry)
        if how:
            RESULT["index"] = how
        sm = upload_sitemap(ftp, env, args.sitemap_file, [(args.public_url, args.date)], [])
        if sm:
            RESULT["sitemap"] = "updated" if sm["updated"] else "added"
        ftp.quit()
    except ftplib.all_errors as e:
        finish(False, error=f"FTP error: {e}")

    print(f"\nDone! Post live at: {args.public_url}")
    finish(True, url=args.public_url, entry=entry)


if __name__ == "__main__":
    main()
