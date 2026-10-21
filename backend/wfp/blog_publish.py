#!/usr/bin/env python3
"""
blog_publish.py
---------------
Winnipeg Fence Pros blog publisher, run by the 5StarFlow server (backend/wfp/publisher.js) after Claude writes a post.
Server-side version of the No-Bs _blog-autopilot.py: same steps, but the server has no copy of the site, so the
blog index and the sitemap are read from the FTP server, patched and uploaded again.

  1. Fetch a Pexels hero photo (or use the fallback image, or drop the hero block)
  2. FTP upload the hero image + the post HTML
  3. Add the post to the blog index page's inline `var POSTS = [...]` array (read from FTP, re-uploaded)
  4. Add the post URL to the sitemap file (read from FTP, re-uploaded)
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
    try:
        ftp.cwd(path)
    except ftplib.error_perm:
        ftp.mkd(path)
        print(f"  MKDIR {path}")


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--file", required=True)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--date", required=True)
    ap.add_argument("--category", required=True)
    ap.add_argument("--excerpt", required=True)
    ap.add_argument("--readtime", required=True, type=int)
    ap.add_argument("--image", required=True, help="Site path the HTML uses for the hero, e.g. /images/slug.webp")
    ap.add_argument("--url-path", required=True, help="Path the blog index links to, e.g. /slug.html")
    ap.add_argument("--public-url", required=True)
    ap.add_argument("--fetch-image", default=None, help="Pexels search words")
    ap.add_argument("--fallback-image", default="")
    ap.add_argument("--blog-dir", default="")
    ap.add_argument("--blog-index", default="")
    ap.add_argument("--sitemap-file", default="")
    ap.add_argument("--keep-image", action="store_true", help="Refresh: the hero is already on the server")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    env = load_env()
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

        if args.blog_index:
            index_path = remote(env, args.blog_index)
            index_html = ftp_read(ftp, index_path)
            if index_html is None:
                warn(f"blog index {index_path} not found -- not updated")
            else:
                new_html, info = patch_posts(index_html, entry)
                if new_html is None:
                    warn(f"blog index not updated: {info}")
                else:
                    ftp_write(ftp, index_path, new_html.encode("utf-8"))
                    RESULT["indexPosts"] = info

        if args.sitemap_file:
            sm_path = remote(env, args.sitemap_file)
            xml = ftp_read(ftp, sm_path)
            if xml is None:
                warn(f"sitemap {sm_path} not found -- not updated")
            else:
                new_xml, action = patch_sitemap(xml, args.public_url, args.date)
                if new_xml is None:
                    warn(f"sitemap not updated: {action}")
                else:
                    ftp_write(ftp, sm_path, new_xml.encode("utf-8"))
                    RESULT["sitemap"] = action
        ftp.quit()
    except ftplib.all_errors as e:
        finish(False, error=f"FTP error: {e}")

    print(f"\nDone! Post live at: {args.public_url}")
    finish(True, url=args.public_url, entry=entry)


if __name__ == "__main__":
    main()
