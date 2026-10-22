/**
 * Checks a post the writer routine sends before anything is uploaded (pure, no database). Every problem is listed so
 * the routine can fix them all in one go; an empty list means the post may be published.
 */
const cheerio = require('cheerio');
const kw = require('./keywords');

const BANNED = ['leverage', 'seamlessly', 'game-changer', 'game changer', 'cutting-edge', 'cutting edge', 'revolutionize', 'revolutionise', 'delve', 'unlock', 'elevate your'];
const FORBIDDEN_TAGS = ['h1', 'script', 'style', 'iframe', 'form', 'object', 'embed', 'link', 'meta', 'base', 'input', 'button', 'svg'];

const RULES = [
  'title: 60 characters or fewer, the keyword (natural wording) in it, keyword first if it reads well',
  'metaDescription: 120 to 158 characters, ends with a reason to click',
  'excerpt: one or two sentences for the article card, 220 characters or fewer',
  'bodyHtml: no <h1> (the page has it), no scripts, styles, iframes or forms; at least 3 <h2> sections',
  'the keyword in the first 100 words; the length within wordCount',
  'every requiredLinks url linked once with natural anchor text',
  'links to the site only to pages in linkTargets (or the required ones); outside links must be http(s)',
  'no em or en dashes; never these words: ' + BANNED.join(', '),
  'faq: 3 to 6 {q, a} pairs, plain text answers',
  'imageQuery: stock photo search words for the hero (new and supporting posts)',
  'sources: at least 2 URLs you opened while researching, one of them a primary source',
];

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
/** Path for comparing links: no trailing slash, /index.html = /. */
const normPath = (p) => (String(p || '/').replace(/\/index\.html?$/i, '/').replace(/\/+$/, '') || '/');

/** Share of the keyword's words (matchKey tokens) that appear in a text. */
function keywordCoverage(text, keyword) {
  const want = kw.matchKey(keyword).split(' ').filter(Boolean);
  if (!want.length) return 1;
  const have = ` ${kw.matchKey(text)} `;
  return want.filter((w) => have.includes(` ${w} `)).length / want.length;
}

/**
 * post: what the routine sent. brief: the assignment brief. site: { origin, allowedPaths: Set } (paths that exist).
 * Returns the list of problems.
 */
function checkPost(post, brief, site) {
  const errors = [];
  const title = String(post.title || '').trim();
  const desc = String(post.metaDescription || '').trim();
  const body = String(post.bodyHtml || '');
  if (!title) errors.push('title is missing');
  else {
    if (title.length > 60) errors.push(`title is ${title.length} characters (max 60)`);
    if (keywordCoverage(title, brief.keyword) < 0.6) errors.push(`title does not contain the keyword "${brief.keyword}"`);
  }
  if (desc.length < 120 || desc.length > 158) errors.push(`metaDescription is ${desc.length} characters (120 to 158)`);
  if (String(post.excerpt || '').length > 220) errors.push('excerpt is longer than 220 characters');

  const $ = cheerio.load(`<div id="r">${body}</div>`, null, false);
  const text = $('#r').text().replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;
  const wc = brief.wordCount || { min: 700, max: 1600 };
  if (words < wc.min) errors.push(`body has ${words} words (at least ${wc.min})`);
  if (words > wc.max + 400) errors.push(`body has ${words} words (aim for ${wc.min} to ${wc.max})`);
  const bad = FORBIDDEN_TAGS.filter((t) => $(`#r ${t}`).length);
  if (bad.length) errors.push(`bodyHtml contains <${bad.join('>, <')}>: remove it`);
  $('#r *').each((_, el) => {
    for (const a of Object.keys(el.attribs || {})) {
      if (a === 'style' || /^on/i.test(a)) { errors.push(`remove the ${a}="" attribute on <${el.tagName}>`); return false; }
    }
    return undefined;
  });
  if ($('#r h2').length < 3) errors.push(`only ${$('#r h2').length} <h2> sections (at least 3)`);
  if (keywordCoverage(text.split(' ').slice(0, 100).join(' '), brief.keyword) < 0.6) errors.push(`the keyword "${brief.keyword}" is not in the first 100 words`);

  // links
  const siteHost = hostOf(site.origin);
  const links = $('#r a[href]').map((_, el) => $(el).attr('href')).get();
  const internal = [];
  for (const href of links) {
    let u;
    try { u = new URL(href, `${site.origin}/`); } catch { errors.push(`link "${href}" is not a valid URL`); continue; }
    if (!/^https?:$/.test(u.protocol)) { if (u.protocol !== 'tel:' && u.protocol !== 'mailto:') errors.push(`link "${href}" must be http(s)`); continue; }
    if (hostOf(u.href) === siteHost) internal.push(normPath(u.pathname));
  }
  for (const p of new Set(internal)) if (!site.allowedPaths.has(p)) errors.push(`link to ${p} goes to a page that is not on the site (use linkTargets)`);
  for (const req of brief.requiredLinks || []) {
    let want;
    try { want = new URL(req.url, `${site.origin}/`); } catch { continue; }
    const ok = links.some((href) => { try { const u = new URL(href, `${site.origin}/`); return hostOf(u.href) === hostOf(want.href) && normPath(u.pathname) === normPath(want.pathname); } catch { return false; } });
    if (!ok) errors.push(`required link missing: ${req.url} (${req.why})`);
  }

  const all = `${title}\n${desc}\n${post.excerpt || ''}\n${text}\n${(post.faq || []).map((f) => `${f.q} ${f.a}`).join('\n')}`;
  if (/[—–]/.test(all)) errors.push('remove the em/en dashes (— –): use a comma, a colon or a new sentence');
  const lower = all.toLowerCase();
  const banned = BANNED.filter((w) => new RegExp(`\\b${w.replace(/[-\s]/g, '[-\\s]')}`, 'i').test(lower));
  if (banned.length) errors.push(`banned words: ${banned.join(', ')}`);

  const faq = Array.isArray(post.faq) ? post.faq : [];
  if (faq.length < 3 || faq.length > 6) errors.push(`faq has ${faq.length} questions (3 to 6)`);
  if (faq.some((f) => !f || !String(f.q || '').trim() || !String(f.a || '').trim())) errors.push('every faq entry needs q and a');
  if (faq.some((f) => /<[a-z]/i.test(`${f?.q}${f?.a}`))) errors.push('faq answers are plain text (no HTML)');
  if (['new', 'support'].includes(brief.mode) && !String(post.imageQuery || '').trim()) errors.push('imageQuery is missing (stock photo search words for the hero)');
  const sources = (Array.isArray(post.sources) ? post.sources : []).filter((s) => /^https?:\/\//.test(typeof s === 'string' ? s : s?.url || ''));
  if (sources.length < 2) errors.push(`sources: ${sources.length} research URLs given (at least 2)`);
  return [...new Set(errors)];
}

module.exports = { checkPost, keywordCoverage, normPath, RULES, BANNED };
