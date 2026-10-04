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
const textHtml = (s) => esc(s).replace(/\[\[(.+?)\]\]/g, '<span>$1</span>').replace(/\r?\n/g, '<br>');

class RenderError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

function validate(layout, slots, size) {
  const spec = LAYOUTS[layout];
  if (!spec) throw new RenderError('UNKNOWN_LAYOUT', `Unknown layout "${layout}". Valid: ${Object.keys(LAYOUTS).join(', ')}`);
  if (spec.sizes.length === 1) size = spec.sizes[0];            // story-only layouts ignore the default size
  if (!spec.sizes.includes(size)) throw new RenderError('BAD_SIZE', `${layout} supports sizes: ${spec.sizes.join(', ')}`);
  const missing = spec.required.filter((k) => {
    const v = slots[k];
    return v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);
  });
  if (missing.length) throw new RenderError('MISSING_SLOTS', `${layout} needs: ${missing.join(', ')}`, { missing });
  for (const [k, [min, max]] of Object.entries(spec.lists || {})) {
    const n = Array.isArray(slots[k]) ? slots[k].length : 0;
    if (n < min || n > max) throw new RenderError('BAD_LIST', `"${k}" needs ${min === max ? min : `${min}-${max}`} item(s), got ${n}`);
  }
  return spec;
}

/** Fill the template. `photos` maps slot name → data URI (already resolved by the caller). */
function buildHtml(layout, slots, size, photos = {}) {
  const spec = validate(layout, slots, size);
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
          const sparticuz = require('@sparticuz/chromium');
          return await require('playwright').chromium.launch({ args: [...args, ...sparticuz.args], executablePath: await sparticuz.executablePath(), headless: true });
        } catch (e2) {
          browserPromise = null;
          throw new RenderError('RENDERER_UNAVAILABLE', `No Chromium available (${e1.message.split('\n')[0]}). Install with "npx playwright install chromium" or set CHROMIUM_PATH.`);
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

// Runs inside the page: shrink [data-fit] text until nothing spills out of the post or onto the footer.
const FIT_SCRIPT = () => {
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
      const spillsFoot = footEl && !footEl.contains(el) && r.bottom > footTop + 1 && r.top < footTop;
      return r.right > pr.right - 8 || r.left < pr.left + 8 || r.bottom > pr.bottom - 8 || el.scrollWidth > el.clientWidth + 2 || spillsFoot;
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
  return { fitSteps: steps, overflow: overflowing() };
};

/**
 * @returns {Promise<{png: Buffer, width, height, fitSteps, overflow, layout, size}>}
 */
async function renderPost({ layout, slots = {}, size = 'feed', photos = {} }) {
  const { w, h, html } = buildHtml(layout, slots, size, photos);
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const fit = await page.evaluate(FIT_SCRIPT);
    const el = await page.$('.post');
    const png = await el.screenshot({ type: 'png' });
    return { png, width: w, height: h, layout, size, ...fit };
  } finally {
    await ctx.close();
  }
}

module.exports = { renderPost, buildHtml, validate, closeBrowser, RenderError, MAX_PHOTO_BYTES };
