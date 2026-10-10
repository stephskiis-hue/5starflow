/**
 * Post renderer — fills a design-system layout (ai/design/layouts/<Name>.html) with copy + photos and
 * screenshots it to a PNG with Playwright/Chromium. The slot protocol is the design system's own:
 *   data-slot       text (newline = line break, [[words]] = accent colour)
 *   data-slot-bg    photo (background-image)
 *   data-slot-list  list of strings, or (GridPost tiles) list of {num,label,photo}
 *   data-if         element only shown when that slot has a value
 *   data-default    keep the template's text when the slot is omitted
 *   data-fit        text shrinks until nothing overflows
 * Fonts and logos are vendored (no network at render time).
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { LAYOUTS, SIZES } = require('./layouts');

const DIR = __dirname;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const read = (...p) => fs.readFileSync(path.join(DIR, ...p), 'utf8');
const dataUri = (file, mime) => `data:${mime};base64,${fs.readFileSync(path.join(DIR, file)).toString('base64')}`;

// design-system blob ids used inside the previews → vendored logo files
const BLOBS = {
  '8a3342d2750849e38f3090d481e356a8': 'logos/icon.png',
  '36cfbced3fb9ca253c339ffda3d59c4b': 'logos/logo-light.png',
  'cee1ac4963e2533f4564e8fb28bcb7bd': 'logos/logo-dark.png',
};

let _cache = null;
function assets() {
  if (_cache) return _cache;
  const tokens = JSON.parse(read('tokens.json'));
  const vars = [];
  for (const t of tokens.color.tokens) vars.push(`--${t.name}:${t.value}`);
  for (const t of tokens.spacing.tokens) vars.push(`--${t.name}:${t.value}`);
  for (const t of tokens.radius.tokens) vars.push(`--${t.name}:${t.value}`);
  for (const [k, v] of Object.entries(tokens.type.families)) vars.push(`--font-${k}:${v}`);
  const fontFaces = read('fonts/fonts.css').replace(/url\('__FONT__\/([^']+)'\)/g,
    (_, f) => `url('${dataUri('fonts/' + f, 'font/woff2')}')`);
  const logos = {};
  for (const [id, file] of Object.entries(BLOBS)) logos[id] = dataUri(file, 'image/png');
  _cache = { css: `${fontFaces}\n:root{${vars.join(';')}}`, logos };
  return _cache;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// escape first, THEN apply the two markup conventions, so slot text can never inject HTML
// ([^\]]+? cannot backtrack across a long run of '[' the way .+? could)
const textHtml = (s) => esc(s).replace(/\[\[([^\]]{1,200}?)\]\]/g, '<span>$1</span>').replace(/\r?\n/g, '<br>');
const MAX_TEXT = 600;      // generous for any layout; anything longer cannot fit a 1080px post anyway
const MAX_ITEMS = 12;

class RenderError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

function validate(layout, slots, size, photos = {}) {
  const spec = LAYOUTS[layout];
  if (!spec) throw new RenderError('UNKNOWN_LAYOUT', `Unknown layout "${layout}". Valid: ${Object.keys(LAYOUTS).join(', ')}`);
  if (spec.sizes.length === 1) size = spec.sizes[0];            // story-only layouts ignore the default size
  if (!spec.sizes.includes(size)) throw new RenderError('BAD_SIZE', `${layout} supports sizes: ${spec.sizes.join(', ')}`);
  const missing = spec.required.filter((k) => {
    const v = slots[k];
    return v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);
  });
  if (missing.length) throw new RenderError('MISSING_SLOTS', `${layout} needs: ${missing.join(', ')}`, { missing });
  // a "required photo" must resolve to an actual image, not just a non-empty string
  const noPhoto = (spec.photoRequired || []).filter((k) => !photos[k]);
  if (noPhoto.length) throw new RenderError('MISSING_PHOTO', `${layout} needs a real photo for: ${noPhoto.join(', ')} (use "vault:<assetId>")`, { missing: noPhoto });
  for (const [k, v] of Object.entries(slots)) {
    if (typeof v === 'string' && v.length > MAX_TEXT) throw new RenderError('TEXT_TOO_LONG', `"${k}" is ${v.length} characters (max ${MAX_TEXT}). Shorten it.`);
    if (Array.isArray(v)) {
      if (v.length > MAX_ITEMS) throw new RenderError('BAD_LIST', `"${k}" has too many items`);
      for (const it of v) {
        const t = typeof it === 'string' ? it : JSON.stringify(it);
        if (t.length > MAX_TEXT) throw new RenderError('TEXT_TOO_LONG', `an item in "${k}" is too long`);
      }
    }
  }
  for (const [k, [min, max]] of Object.entries(spec.lists || {})) {
    const n = Array.isArray(slots[k]) ? slots[k].length : 0;
    if (n < min || n > max) throw new RenderError('BAD_LIST', `"${k}" needs ${min === max ? min : `${min}-${max}`} item(s), got ${n}`);
  }
  return spec;
}

/** Fill the template. `photos` maps slot name → data URI (already resolved by the caller). */
function buildHtml(layout, slots, size, photos = {}) {
  const spec = validate(layout, slots, size, photos);
  if (spec.sizes.length === 1) size = spec.sizes[0];
  const { css, logos } = assets();
  let html = read('layouts', `${layout}.html`)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<link[^>]*fonts\.googleapis[^>]*>/g, '')
    .replace(/<script>\s*<\/script>/g, '')
    .replace(/\/_blob\/([0-9a-f]{32})/g, (m, id) => logos[id] || m);
  const $ = cheerio.load(`<div id="__root">${html}</div>`, null, false);

  const val = (name) => (slots[name] == null ? '' : slots[name]);
  const has = (name) => {
    const v = slots[name];
    return !!(photos[name] || (typeof v === 'string' && v.trim()) || (Array.isArray(v) && v.length));
  };

  // lists first (they contain nested slots)
  $('[data-slot-list]').each((_, el) => {
    const $el = $(el); const name = $el.attr('data-slot-list');
    const items = slots[name];
    if (!Array.isArray(items) || !items.length) return;
    const tpl = $el.children().first();
    const isLi = tpl.is('li');
    $el.empty();
    for (const item of items) {
      if (isLi) {
        $el.append(`<li>${textHtml(typeof item === 'string' ? item : item.text || '')}</li>`);
      } else {
        const $c = tpl.clone();
        const obj = typeof item === 'object' ? item : {};
        $c.find('[data-slot]').each((__, s) => { const k = $(s).attr('data-slot'); if (obj[k] != null) $(s).html(textHtml(obj[k])); });
        $c.find('[data-slot-bg]').each((__, s) => {
          const ref = obj[$(s).attr('data-slot-bg')];
          const uri = photos[`${name}.${items.indexOf(item)}`] || (ref && photos[ref]);
          if (uri) $(s).attr('style', `background-image:url("${uri}")`);
        });
        $el.append($c);
      }
    }
  });

  $('[data-if]').each((_, el) => { if (!has($(el).attr('data-if'))) $(el).remove(); });

  $('[data-slot]').each((_, el) => {
    const $el = $(el); const name = $el.attr('data-slot');
    if ($el.closest('[data-slot-list]').length) return;
    const v = val(name);
    if (typeof v === 'string' && v.trim()) $el.html(textHtml(v));
    else if ($el.attr('data-default') !== undefined) { /* keep template text (e.g. BEFORE / AFTER) */ }
    else $el.html('');
  });

  $('[data-slot-bg]').each((_, el) => {
    const $el = $(el); const name = $el.attr('data-slot-bg');
    if ($el.closest('[data-slot-list]').length) return;
    if (photos[name]) $el.attr('style', `background-image:url("${photos[name]}")`);
  });

  const $post = $('.post').first();
  if (size === 'story' && !$post.hasClass('size-story') && !spec.sizes.every((s) => s === 'story')) $post.addClass('size-story');
  if (size === 'square') $post.addClass('size-square');

  const { w, h } = layoutSize(layout, size);
  const body = $('#__root').html();
  return { w, h, html: `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body class="render" style="margin:0;background:transparent">${body}</body></html>` };
}

function layoutSize(layout, size) {
  const spec = LAYOUTS[layout];
  const key = spec.sizes.length === 1 ? spec.sizes[0] : size;
  return SIZES[key];
}

// ---------------------------------------------------------------------------------- browser
let browserPromise = null; let idleTimer = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const args = ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'];
      try {
        return await require('playwright').chromium.launch({ args, executablePath: process.env.CHROMIUM_PATH || undefined });
      } catch (e1) {
        try { // serverless-style chromium bundle: works on slim Linux images without system libs
          const sparticuz = (await import('@sparticuz/chromium')).default;   // ESM-only package: dynamic import works on every Node
          return await require('playwright').chromium.launch({ args: [...args, ...sparticuz.args], executablePath: await sparticuz.executablePath(), headless: true });
        } catch (e2) {
          browserPromise = null;
          throw new RenderError('RENDERER_UNAVAILABLE', `No Chromium available (${e1.message.split('\n')[0]}; fallback: ${e2.message.split('\n')[0]}). Deploy with backend/Dockerfile, run "npx playwright install chromium", or set CHROMIUM_PATH.`);
        }
      }
    })();
  }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(closeBrowser, 90_000); // free the ~200MB process when idle
  if (idleTimer.unref) idleTimer.unref();
  return browserPromise;
}
async function closeBrowser() {
  const p = browserPromise; browserPromise = null;
  if (p) { try { (await p).close(); } catch { /* already gone */ } }
}

// Runs inside the page: shrink [data-fit] text until nothing spills out of the post or onto the footer
// (and, on a story canvas, out of the zones Facebook covers with its own buttons).
const FIT_SCRIPT = (safe) => {
  const post = document.querySelector('.post');
  const fits = [...document.querySelectorAll('[data-fit]')];
  const footEl = document.querySelector('.foot') || document.querySelector('.g') || document.querySelector('.bar');
  const overflowing = () => {
    const pr = post.getBoundingClientRect();
    const footTop = footEl ? footEl.getBoundingClientRect().top : pr.bottom;
    // footer pushed off the canvas = the copy above it grew too tall
    if (footEl && footEl.getBoundingClientRect().bottom > pr.bottom + 1) return true;
    return fits.some((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0) return false;
      // same 24px of air above the footer that slotOverflow demands, so the loop keeps shrinking until the final check passes
      const spillsFoot = footEl && !footEl.contains(el) && r.bottom > footTop - 24 && r.top < footTop;
      return r.right > pr.right - 8 || r.left < pr.left + 8 || r.bottom > pr.bottom - 8 || el.scrollWidth > el.clientWidth + 2 || spillsFoot;
    }) || inSafeZone();
  };
  // any slot text (shrinkable or not, e.g. a kicker pushed up by a long question) under the story's own buttons
  const inSafeZone = () => {
    if (!safe) return false;
    const pr = post.getBoundingClientRect();
    return [...post.querySelectorAll('[data-slot], [data-slot-list] > *')].some((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || !el.textContent.trim()) return false;
      return r.top < pr.top + safe.top || r.bottom > pr.bottom - safe.bottom;
    });
  };
  // Slots without [data-fit] can't shrink, but long copy in them can still push a column off the canvas or under the footer.
  const slotOverflow = () => {
    const pr = post.getBoundingClientRect();
    const fr = footEl ? footEl.getBoundingClientRect() : null;
    return [...post.querySelectorAll('[data-slot], [data-slot-list] > *')].some((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || !el.textContent.trim()) return false;
      if (r.right > pr.right + 1 || r.left < pr.left - 1 || r.bottom > pr.bottom + 1 || r.top < pr.top - 1) return true;
      return !!fr && !footEl.contains(el) && r.bottom > fr.top - 24 && r.top < fr.top && r.right > fr.left && r.left < fr.right;   // keep air above the footer
    });
  };
  let steps = 0;
  while (overflowing() && steps < 24) {
    for (const el of fits) {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      el.style.fontSize = `${(fs * 0.94).toFixed(2)}px`;
    }
    steps++;
  }
  return { fitSteps: steps, overflow: overflowing() || slotOverflow() };
};

// Story safe zones: Facebook draws its own header (top) and reply bar (bottom) over these.
const STORY_SAFE = { top: 220, bottom: 300 };

// Runs inside the page on a 1920-tall canvas: how much of the safe area the content fills, the smallest text, and
// whether any text sits under the app's own buttons. A sparse frame with small type reads as "zoomed out" on a phone.
const STORY_AUDIT = (safe) => {
  const post = document.querySelector('.post');
  const pr = post.getBoundingClientRect();
  let top = Infinity; let bottom = -Infinity; let minFontPx = Infinity; let minFontSlot = null; let safeZoneHit = false;
  for (const el of post.querySelectorAll('[data-slot], [data-slot-list] > *, [data-slot-bg]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const isText = el.hasAttribute('data-slot') || el.closest('[data-slot-list]');
    const hasText = isText && el.textContent.trim();
    const hasPhoto = el.hasAttribute('data-slot-bg') && getComputedStyle(el).backgroundImage !== 'none';
    if (!hasText && !hasPhoto) continue;
    top = Math.min(top, r.top - pr.top); bottom = Math.max(bottom, r.bottom - pr.top);
    if (hasText) {
      // reading copy (4+ words) must be phone-legible; short letter-spaced kickers and labels are accents
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (el.getAttribute('data-slot') !== 'kicker' && el.textContent.trim().split(/\s+/).length >= 4 && fs < minFontPx) {
        minFontPx = fs; minFontSlot = el.getAttribute('data-slot') || el.parentElement.getAttribute('data-slot-list');
      }
      if (r.top - pr.top < safe.top || r.bottom - pr.top > pr.height - safe.bottom) safeZoneHit = true;
    }
  }
  const safeHeight = pr.height - safe.top - safe.bottom;
  const fill = bottom > top ? Math.min(1, (bottom - top) / safeHeight) : 0;
  return { fill: +fill.toFixed(2), minFontPx: Number.isFinite(minFontPx) ? +minFontPx.toFixed(1) : null, minFontSlot, safeZoneHit };
};

/** Width and height from a PNG's IHDR chunk (bytes 16-23). */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Thresholds a story frame must meet before it can be queued.
const STORY_MIN_FILL = 0.45;
const STORY_MIN_FONT_PX = 34;

/** Plain-language reasons a story render is not good enough to post (empty = fine). */
function storyProblems({ width, height, story, layout }) {
  const out = [];
  if (width !== 1080 || height !== 1920) out.push(`Story image is ${width}x${height}, must be 1080x1920 or Facebook shows it zoomed out.`);
  if (!story) return out;
  if (story.fill < STORY_MIN_FILL && !LAYOUTS[layout]?.sparseOk) out.push(`Story frame is mostly empty (content fills ${Math.round(story.fill * 100)}% of the screen). Use a story-first layout or bigger, fuller copy.`);
  if (story.minFontPx != null && story.minFontPx < STORY_MIN_FONT_PX) out.push(`"${story.minFontSlot}" text is too small to read on a phone (${story.minFontPx}px, needs ${STORY_MIN_FONT_PX}px+). Shorten the copy so it can stay big.`);
  if (story.safeZoneHit) out.push('Text sits under Facebook\'s story buttons (top 220px or bottom 300px).');
  return out;
}

/**
 * @returns {Promise<{png: Buffer, width, height, fitSteps, overflow, layout, size, story?}>}
 */
async function renderPost({ layout, slots = {}, size = 'feed', photos = {} }) {
  const { w, h, html } = buildHtml(layout, slots, size, photos);
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const fit = await page.evaluate(FIT_SCRIPT, h === 1920 ? STORY_SAFE : null);
    const story = h === 1920 ? await page.evaluate(STORY_AUDIT, STORY_SAFE) : undefined;
    const el = await page.$('.post');
    const png = await el.screenshot({ type: 'png' });
    const { width, height } = pngSize(png);   // what was actually captured, not what was asked for
    return { png, width, height, layout, size, ...fit, ...(story ? { story } : {}) };
  } finally {
    await ctx.close();
  }
}

module.exports = { renderPost, buildHtml, validate, closeBrowser, storyProblems, pngSize, RenderError, MAX_PHOTO_BYTES, STORY_MIN_FILL, STORY_MIN_FONT_PX };
