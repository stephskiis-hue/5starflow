#!/usr/bin/env python3
"""
No-Bs Yardwork site helper for the SEO Growth Engine (runs on the MSI PC, standard library only).

Site files (local public_html, uploaded by _deploy.py):
  build-sitemaps <public_html>   rebuild sitemap.xml, blog-sitemap.xml and sitemap_index.xml from the real files
  blog-index <public_html>       rebuild posts.json from every live post + a static link list in blog.html
  nightly [<public_html>]        both of the above (request-gate.ps1 runs it once a day); site folder from seo-site.json

5StarFlow API (FIVESTARFLOW_URL / FIVESTARFLOW_TOKEN from ~/.5starflow/env or the environment):
  check                          is the API reachable and is Search Console connected?
  assignment [--modes new,refresh,page] [--fresh]   today's SEO brief (JSON)
  skip <assignmentId> <reason>   give the assignment back (e.g. not enough local detail)
  published <report.json>        report what went live (queued in ~/.5starflow/seo-pending.jsonl if the API is down)
  progress                       numbers for the weekly recap
  report <recap.json>            post the weekly recap {"narrative": "...", "nextFocus": "..."}
  sitemaps-check                 after a deploy: 5StarFlow re-reads the live sitemaps and submits changes to Google
  run <status> <summary> [--result result.json]   end-of-run report (slug ext-blog-autopilot)

Every command prints JSON on stdout and exits non-zero on failure. Logs go to ~/.5starflow/seo-site.log.
"""
import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

FSF_DIR = Path.home() / '.5starflow'
PENDING = FSF_DIR / 'seo-pending.jsonl'
STATE_FILE = FSF_DIR / 'sitemap-state.json'          # outside the site folder, so the deploy never uploads it
BACKUP_DIR = FSF_DIR / 'seo-backup'
CONFIG = json.loads((Path(__file__).with_name('seo-site.json')).read_text(encoding='utf-8')) if Path(__file__).with_name('seo-site.json').exists() else {}
ORIGIN = os.environ.get('SITE_ORIGIN', 'https://www.no-bs-yardwork.com').rstrip('/')
SKIP_DIRS = {'images', 'img', 'css', 'js', 'fonts', 'assets', 'admin', 'cgi-bin', 'tag', 'drafts', 'node_modules', '.git', '.well-known'}
SKIP_FILES = re.compile(r'^(_|\.)|^(404|500|403)\.html?$|^google[0-9a-f]+\.html$|^thank-?you', re.I)


def log(msg):
    try:
        FSF_DIR.mkdir(exist_ok=True)
        f = FSF_DIR / 'seo-site.log'
        lines = f.read_text(encoding='utf-8').splitlines()[-499:] if f.exists() else []
        lines.append(f"{dt.datetime.now():%Y-%m-%d %H:%M:%S} {msg}")
        f.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    except OSError:
        pass


def out(obj, code=0):
    print(json.dumps(obj, indent=2, default=str))
    sys.exit(code)


# --------------------------------------------------------------------------- API
def load_env():
    env_file = FSF_DIR / 'env'
    if env_file.exists():
        for line in env_file.read_text(encoding='utf-8').splitlines():
            m = re.match(r'^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.+?)\s*$', line)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip('"\'')
    url, token = os.environ.get('FIVESTARFLOW_URL'), os.environ.get('FIVESTARFLOW_TOKEN')
    if not url or not token:
        out({'ok': False, 'error': f'FIVESTARFLOW_URL / FIVESTARFLOW_TOKEN missing ({env_file})'}, 2)
    return url.rstrip('/'), token


def api(method, path, body=None, timeout=60, prefix='/api/ai/seo'):
    base, token = load_env()
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(f'{base}{prefix}{path}', data=data, method=method, headers={
        'Authorization': f'Bearer {token}', 'X-Agent': 'content', 'Content-Type': 'application/json', 'User-Agent': 'nobs-seo-site/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode('utf-8') or '{}')
        except ValueError:
            payload = {}
        return e.code, payload
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {'error': str(e)}


def read_json_file(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        out({'ok': False, 'error': f'cannot read {p}: {e}'}, 2)


def flush_pending():
    """Re-send publish reports that failed earlier (oldest first). Returns how many went through."""
    if not PENDING.exists():
        return 0
    lines = [l for l in PENDING.read_text(encoding='utf-8').splitlines() if l.strip()]
    keep, sent = [], 0
    for line in lines:
        status, _ = api('POST', '/published', json.loads(line))
        if status in (200, 201) or status == 400:      # 400 = bad report: drop it rather than retry forever
            sent += 1
        else:
            keep.append(line)
    PENDING.write_text(''.join(l + '\n' for l in keep), encoding='utf-8')
    return sent


def cmd_check(_args):
    status, body = api('GET', '/gsc-status')
    out({'ok': status == 200, 'status': status, **(body if isinstance(body, dict) else {})}, 0 if status == 200 else 1)


def cmd_assignment(args):
    modes = 'new,refresh,page'
    if '--modes' in args:
        modes = args[args.index('--modes') + 1]
    q = f'?modes={modes}' + ('&fresh=1' if '--fresh' in args else '')
    flushed = flush_pending()
    status, body = api('GET', f'/assignment{q}')
    if status != 200:
        log(f'assignment failed {status} {body.get("error")}')
        out({'ok': False, 'status': status, 'error': body.get('error'), 'fallback': 'use the _blog-state.json rotation and still report with published'}, 1)
    if body.get('assignment'):
        FSF_DIR.mkdir(exist_ok=True)
        (FSF_DIR / 'seo-assignment.json').write_text(json.dumps(body['assignment'], indent=2), encoding='utf-8')
    log(f'assignment {(body.get("assignment") or {}).get("mode")} {(body.get("assignment") or {}).get("keyword")}')
    out({'ok': True, 'flushedReports': flushed, **body})


def cmd_skip(args):
    if len(args) < 2:
        out({'ok': False, 'error': 'usage: skip <assignmentId> <reason>'}, 2)
    status, body = api('POST', f'/assignment/{args[0]}/skip', {'reason': ' '.join(args[1:])})
    out({'ok': status == 200, 'status': status, **body}, 0 if status == 200 else 1)


def cmd_published(args):
    if not args:
        out({'ok': False, 'error': 'usage: published <report.json>'}, 2)
    report = read_json_file(args[0])
    status, body = api('POST', '/published', report)
    if status in (200, 201):
        log(f'published {report.get("url")}')
        out({'ok': True, **body, 'flushedReports': flush_pending()})
    if status == 400:
        out({'ok': False, 'status': status, 'error': body.get('error')}, 1)
    FSF_DIR.mkdir(exist_ok=True)
    with PENDING.open('a', encoding='utf-8') as f:
        f.write(json.dumps(report) + '\n')
    log(f'published queued ({status} {body.get("error")}) {report.get("url")}')
    out({'ok': False, 'queued': True, 'status': status, 'error': body.get('error'), 'note': 'saved to seo-pending.jsonl; it is sent on the next run'}, 1)


def cmd_progress(_args):
    status, body = api('GET', '/progress?view=report')
    out({'ok': status == 200, **body}, 0 if status == 200 else 1)


def cmd_report(args):
    if not args:
        out({'ok': False, 'error': 'usage: report <recap.json>'}, 2)
    status, body = api('POST', '/reports', read_json_file(args[0]))
    out({'ok': status in (200, 201), 'status': status, **body}, 0 if status in (200, 201) else 1)


def cmd_sitemaps_check(_args):
    status, body = api('POST', '/sitemaps/check', {}, timeout=180)
    result = body.get('result', {}) if isinstance(body, dict) else {}
    log(f'sitemaps-check {status} {result.get("summary") or body.get("error")}')
    out({'ok': status == 200, 'status': status, 'summary': result.get('summary'), 'error': body.get('error')}, 0 if status == 200 else 1)


# --------------------------------------------------------------------------- site files
def clean_path(rel):
    """'about.html' -> '/about', 'index.html' -> '/', 'blog/x.html' -> '/blog/x'."""
    p = '/' + rel.replace('\\', '/').lstrip('/')
    p = re.sub(r'/index\.html?$', '/', p, flags=re.I)
    p = re.sub(r'\.html?$', '', p, flags=re.I)
    return p if p == '/' else p.rstrip('/')


def page_text(src):
    src = re.sub(r'<(script|style|noscript)[^>]*>.*?</\1>', ' ', src, flags=re.S | re.I)
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', src))).strip()


def meta(src, name):
    m = re.search(rf'<meta[^>]+(?:name|property)=["\']{re.escape(name)}["\'][^>]*content=["\']([^"\']*)["\']', src, re.I) \
        or re.search(rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:name|property)=["\']{re.escape(name)}["\']', src, re.I)
    return html.unescape(m.group(1)).strip() if m else None


def redirect_sources(root):
    """Paths that .htaccess 301s elsewhere: they must never be in a sitemap."""
    f = root / '.htaccess'
    if not f.exists():
        return set()
    srcs = set()
    for line in f.read_text(encoding='utf-8', errors='replace').splitlines():
        line = line.strip()
        m = re.match(r'^Redirect(?:Permanent)?\s+(?:30[12]\s+)?(\S+)\s+\S+', line, re.I)
        if m:
            srcs.add(clean_path(m.group(1)))
        m = re.match(r'^RewriteRule\s+\^?/?([A-Za-z0-9_\-./]+?)(?:\\\.html\?|\.html\?|\$)*\$?\s+\S+\s+\[[^\]]*R=30[12]', line, re.I)
        if m and not any(ch in m.group(1) for ch in '()*+['):
            srcs.add(clean_path(m.group(1)))
    return srcs


def scan_pages(root):
    """Every indexable page: [(path, file, src)], plus what was left out and why."""
    redirected = redirect_sources(root)
    excluded_list = {clean_path(p) for p in CONFIG.get('exclude', [])}
    ex = root / '_sitemap-exclude.txt'
    if ex.exists():
        excluded_list |= {clean_path(l.strip()) for l in ex.read_text(encoding='utf-8').splitlines() if l.strip() and not l.startswith('#')}
    pages, skipped = [], []
    for f in sorted(root.rglob('*.htm*')):
        rel = f.relative_to(root)
        if any(part.lower() in SKIP_DIRS or part.startswith(('.', '_')) for part in rel.parts[:-1]) or SKIP_FILES.search(f.name):
            continue
        path = clean_path(str(rel))
        src = f.read_text(encoding='utf-8', errors='replace')
        robots = (meta(src, 'robots') or '').lower()
        canon = re.search(r'<link[^>]+rel=["\']canonical["\'][^>]*href=["\']([^"\']+)["\']', src, re.I)
        canon_path = clean_path(re.sub(r'^https?://[^/]+', '', canon.group(1))) if canon else None
        reason = None
        if path in excluded_list:
            reason = 'excluded (seo-site.json or _sitemap-exclude.txt)'
        elif path in redirected:
            reason = '301 in .htaccess'
        elif 'noindex' in robots:
            reason = 'noindex'
        elif re.search(r'<meta[^>]+http-equiv=["\']refresh', src, re.I):
            reason = 'meta refresh'
        elif canon_path and canon_path.lower() != path.lower():
            reason = f'canonical points to {canon_path}'
        if reason:
            skipped.append({'path': path, 'reason': reason})
            continue
        pages.append((path, f, src))
    # Two files that differ only by case are one page served twice: keep the lowercase one.
    keep = {}
    for page in pages:
        k = page[0].lower()
        if k not in keep or page[0] == k:
            if k in keep:
                skipped.append({'path': keep[k][0], 'reason': f'same page as {page[0]} (different case)'})
            keep[k] = page
        else:
            skipped.append({'path': page[0], 'reason': f'same page as {keep[k][0]} (different case)'})
    return [p for p in pages if keep[p[0].lower()] is p], skipped


def xml_urlset(entries):
    body = ''.join(f'  <url>\n    <loc>{html.escape(loc)}</loc>\n    <lastmod>{lastmod}</lastmod>\n  </url>\n' for loc, lastmod in entries)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{body}</urlset>\n'


def write_if_changed(path, text, dry):
    old = path.read_text(encoding='utf-8') if path.exists() else None
    if old == text:
        return False
    if not dry:
        if old is not None:
            day = BACKUP_DIR / dt.date.today().isoformat()
            day.mkdir(parents=True, exist_ok=True)
            if not (day / path.name).exists():
                (day / path.name).write_text(old, encoding='utf-8')
        path.write_text(text, encoding='utf-8')
    return True


def site_root(args, usage):
    path = next((a for a in args if not a.startswith('--')), None) or os.environ.get('SEO_SITE_DIR') or CONFIG.get('siteDir')
    if not path:
        out({'ok': False, 'error': f'usage: {usage}'}, 2)
    root = Path(path)
    if not root.is_dir():
        out({'ok': False, 'error': f'{root} is not a folder'}, 2)
    return root, '--dry-run' in args


def cmd_build_sitemaps(args):
    root, dry = site_root(args, 'build-sitemaps <public_html> [--dry-run]')
    out(build_sitemaps(root, dry))


def build_sitemaps(root, dry):
    pages, skipped = scan_pages(root)
    # lastmod changes only when the page text changes (deploy timestamps are not edits)
    all_state = json.loads(STATE_FILE.read_text(encoding='utf-8')) if STATE_FILE.exists() else {}
    legacy = root / '_sitemap-state.json'
    state = all_state.get(str(root.resolve())) or (json.loads(legacy.read_text(encoding='utf-8')) if legacy.exists() else {})
    today = dt.date.today().isoformat()
    blog, other = [], []
    for path, f, src in pages:
        h = hashlib.sha1(page_text(src).encode('utf-8')).hexdigest()
        prev = state.get(path)
        if not prev:
            lastmod = dt.date.fromtimestamp(f.stat().st_mtime).isoformat()
        elif prev['hash'] != h:
            lastmod = today
        else:
            lastmod = prev['lastmod']
        state[path] = {'hash': h, 'lastmod': lastmod}
        loc = ORIGIN + ('/' if path == '/' else path)
        (blog if re.match(r'^/blog-', path, re.I) else other).append((loc, lastmod))
    for gone in [p for p in state if p not in {x[0] for x in pages}]:
        del state[gone]
    other.sort(key=lambda e: (e[0] != ORIGIN + '/', e[0]))
    blog.sort(key=lambda e: e[1], reverse=True)
    changed = []
    if write_if_changed(root / 'sitemap.xml', xml_urlset(other), dry):
        changed.append('sitemap.xml')
    if write_if_changed(root / 'blog-sitemap.xml', xml_urlset(blog), dry):
        changed.append('blog-sitemap.xml')
    idx_entries = [(f'{ORIGIN}/sitemap.xml', max((e[1] for e in other), default=today)), (f'{ORIGIN}/blog-sitemap.xml', max((e[1] for e in blog), default=today))]
    idx = '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + \
        ''.join(f'  <sitemap>\n    <loc>{loc}</loc>\n    <lastmod>{lm}</lastmod>\n  </sitemap>\n' for loc, lm in idx_entries) + '</sitemapindex>\n'
    if write_if_changed(root / 'sitemap_index.xml', idx, dry):
        changed.append('sitemap_index.xml')
    robots = root / 'robots.txt'
    warnings = []
    if robots.exists() and 'sitemap_index.xml' not in robots.read_text(encoding='utf-8', errors='replace'):
        warnings.append('robots.txt does not list sitemap_index.xml: add "Sitemap: https://www.no-bs-yardwork.com/sitemap_index.xml"')
    if not dry:
        FSF_DIR.mkdir(exist_ok=True)
        all_state[str(root.resolve())] = state
        STATE_FILE.write_text(json.dumps(all_state, indent=1, sort_keys=True), encoding='utf-8')
    log(f'build-sitemaps pages={len(other)} posts={len(blog)} skipped={len(skipped)} changed={changed}')
    return {'ok': True, 'dryRun': dry, 'pages': len(other), 'posts': len(blog), 'changed': changed, 'skipped': skipped, 'warnings': warnings}


def post_facts(path, f, src, existing):
    title = re.search(r'<title>(.*?)</title>', src, re.S | re.I)
    title = html.unescape(title.group(1)).strip() if title else path
    title = re.sub(r'\s*\|\s*No[- ]?B\.?S\.? Yardwork\s*$', '', title, flags=re.I)
    date = existing.get('date') or meta(src, 'article:published_time')
    if not date:
        m = re.search(r'"datePublished"\s*:\s*"([0-9-]{10})', src)
        date = m.group(1) if m else dt.date.fromtimestamp(f.stat().st_mtime).isoformat()
    image = existing.get('image') or meta(src, 'og:image') or ''
    image = re.sub(r'^https?://[^/]+/', '', image)
    words = len(page_text(src).split())
    return {
        'title': existing.get('title') or title,
        'date': str(date)[:10],
        'image': image,
        'excerpt': existing.get('excerpt') or meta(src, 'description') or '',
        'url': path.lstrip('/'),
        'category': existing.get('category') or 'Lawn Care',
        'readTime': existing.get('readTime') or max(3, round(words / 200)),
    }


def cmd_blog_index(args):
    root, dry = site_root(args, 'blog-index <public_html> [--dry-run]')
    out(blog_index(root, dry))


def blog_index(root, dry):
    posts_file = root / 'posts.json'
    current = json.loads(posts_file.read_text(encoding='utf-8')) if posts_file.exists() else []
    by_url = {clean_path(p.get('url', '')).lstrip('/'): p for p in current}
    pages, _ = scan_pages(root)
    posts, added = [], []
    for path, f, src in pages:
        if not re.match(r'^/blog-', path, re.I):
            continue
        key = path.lstrip('/')
        if key not in by_url:
            added.append(key)
        posts.append(post_facts(path, f, src, by_url.get(key, {})))
    posts.sort(key=lambda p: (p['date'], p['url']), reverse=True)
    changed = []
    if write_if_changed(posts_file, json.dumps(posts, indent=2, ensure_ascii=False) + '\n', dry):
        changed.append('posts.json')
    blog = root / 'blog.html'
    notes = []
    if blog.exists():
        original = src = blog.read_text(encoding='utf-8')
        # 1. a crawlable <ul> of every post (search engines do not wait for the JS cards)
        start, end = '<!-- seo:post-list:start -->', '<!-- seo:post-list:end -->'
        if start in src and end in src:
            items = ''.join(f'      <li><a href="{html.escape(p["url"])}">{html.escape(p["title"])}</a> <time datetime="{p["date"]}">{p["date"]}</time></li>\n' for p in posts)
            src = src[:src.index(start)] + f'{start}\n    <ul class="seo-post-list">\n{items}    </ul>\n    {end}' + src[src.index(end) + len(end):]
        else:
            notes.append(f'add {start} and {end} once inside blog.html where the crawlable post list should go')
        # 2. the page's own JS array (var POSTS = [...]) gets the same list, so the cards and the links agree
        a, b = '/* seo:posts:start */', '/* seo:posts:end */'
        if a in src and b in src:
            src = src[:src.index(a) + len(a)] + json.dumps(posts, indent=2, ensure_ascii=False) + src[src.index(b):]
        elif 'var POSTS' in src:
            notes.append(f'wrap the POSTS array literal as var POSTS = {a}[...]{b}; so it stays in sync with posts.json')
        if src != original and write_if_changed(blog, src, dry):
            changed.append('blog.html')
    note = '; '.join(notes) or None
    log(f'blog-index posts={len(posts)} added={len(added)} changed={changed}')
    return {'ok': True, 'dryRun': dry, 'posts': len(posts), 'addedToPostsJson': added, 'changed': changed, 'note': note}


def report_run(body):
    """Best effort: the ledger entry is nice to have, the rebuilt files are what matters."""
    env_file = FSF_DIR / 'env'
    configured = (os.environ.get('FIVESTARFLOW_URL') and os.environ.get('FIVESTARFLOW_TOKEN')) or \
        (env_file.exists() and 'FIVESTARFLOW_TOKEN' in env_file.read_text(encoding='utf-8', errors='replace'))
    if not configured:
        log('nightly: no FIVESTARFLOW_URL / TOKEN, run not reported')
        return 0, {}
    return api('POST', '/runs', body, prefix='/api/ai')


def cmd_nightly(args):
    """Run by request-gate.ps1 once a day: blog index, then sitemaps, so the 3 AM deploy uploads them. Zero Claude tokens."""
    root, dry = site_root(args, 'nightly [<public_html>] [--dry-run]  (or siteDir in seo-site.json / SEO_SITE_DIR)')
    try:
        idx = blog_index(root, dry)
        maps = build_sitemaps(root, dry)
    except Exception as e:                       # never let a bad file stop the gate; report it instead
        log(f'nightly failed: {e}')
        report = {'slug': 'ext-seo-site-nightly', 'status': 'failed', 'summary': f'Sitemap rebuild failed: {e}'[:500], 'error': str(e)[:500]}
        if not dry:
            report_run(report)
        out({'ok': False, 'error': str(e)}, 1)
    changed = idx['changed'] + maps['changed']
    summary = (f"{maps['pages']} pages + {maps['posts']} posts in the sitemaps; "
               + (f"rewrote {', '.join(changed)}" if changed else 'nothing changed')
               + (f"; added {len(idx['addedToPostsJson'])} post(s) to posts.json" if idx['addedToPostsJson'] else '')
               + ('; the 3 AM deploy uploads them' if changed else ''))
    log(f'nightly {summary}')
    if not dry:
        report_run({'slug': 'ext-seo-site-nightly', 'status': 'completed' if changed else 'skipped', 'summary': summary[:500],
                              'result': {'items_found': maps['pages'] + maps['posts'], 'actions_taken': [f'rewrote {c}' for c in changed],
                                         'skipped': len(maps['skipped']), 'notes': '; '.join(filter(None, [idx.get('note')] + maps['warnings']))[:190]}})
    out({'ok': True, 'summary': summary, 'blogIndex': idx, 'sitemaps': maps})


def cmd_run(args):
    """run <completed|skipped|failed> <summary...> [--result result.json]: the run report for the ledger + heartbeat."""
    if len(args) < 2 or args[0] not in ('completed', 'skipped', 'failed'):
        out({'ok': False, 'error': 'usage: run <completed|skipped|failed> <summary> [--result result.json]'}, 2)
    result = {}
    if '--result' in args:
        i = args.index('--result')
        result = read_json_file(args[i + 1])
        args = args[:i] + args[i + 2:]
    body = {'slug': os.environ.get('SEO_RUN_SLUG', 'ext-blog-autopilot'), 'status': args[0], 'summary': ' '.join(args[1:])[:500], 'result': result}
    status, resp = api('POST', '/runs', body, prefix='/api/ai')
    log(f'run {args[0]} {status}')
    out({'ok': status in (200, 201), 'status': status, **resp}, 0 if status in (200, 201) else 1)


COMMANDS = {
    'check': cmd_check, 'assignment': cmd_assignment, 'skip': cmd_skip, 'published': cmd_published, 'progress': cmd_progress,
    'report': cmd_report, 'sitemaps-check': cmd_sitemaps_check, 'run': cmd_run, 'build-sitemaps': cmd_build_sitemaps, 'blog-index': cmd_blog_index,
    'nightly': cmd_nightly,
}

if __name__ == '__main__':
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(2)
    COMMANDS[sys.argv[1]](sys.argv[2:])
