/**
 * Everything checked before a page is uploaded. The writer gets the full list back at once (HTTP 422) and fixes it.
 * Deterministic only: the same rules as the nobs-seo skill, section 4, plus the brand lint (banned words, dashes, wrong
 * business name or phone number). Prices are NOT linted here: a cost guide may show typical Winnipeg market ranges
 * (the skill forbids quoting No-Bs prices, which only the writer can judge).
 */
const cheerio = require('cheerio');
const { BANNED, MID_DASH, BAD_NAMES, PHONE, BRAND } = require('../design/qa');
const { canonicalPath, isAsset } = require('../seo/urls');
const kw = require('../seo/keywords');

const ALLOWED_TAGS = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'a', 'br', 'div', 'span', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const ALLOWED_DIV = new Set(['blog-inline-cta', 'blog-callout']);
const WORDS = { post: [700, 950], page: [800, 1300] };

const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean);
const textOf = ($, root) => $(root).text().replace(/\s+/g, ' ').trim();

/** Does the text contain every meaningful word of the keyword (singular/plural and synonyms folded)? */
function hasKeyword(text, keyword) {
  const need = kw.tokens(keyword).filter((t) => t !== kw.LOC);
  if (!need.length) return true;
  const have = new Set(kw.tokens(text));
  return need.every((t) => have.has(t));
}

/** Rewrite internal links to the clean absolute URL (the site 301s every .html address). Returns the new html. */
function normalizeLinks(bodyHtml, origin) {
  const $ = cheerio.load(`<div id="r">${bodyHtml}</div>`, null, false);
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    const p = canonicalPath(href, `${origin}/`);
    if (p && !isAsset(p) && !/^#/.test(href)) $(a).attr('href', p === '/' ? `${origin}/` : `${origin}${p}`);
  });
  return $('#r').html();
}

/**
 * i: { kind, mode, slug, title, description, h1, keyword, bodyHtml, requiredLinks[], wordRange }
 * ctx: { pages: {path: SeoPage}, origin }
 * Returns { ok, errors[], warnings[], words, links[] }
 */
function checkPage(i, ctx) {
  const errors = []; const warnings = [];
  const kind = i.kind === 'page' ? 'page' : 'post';
  const $ = cheerio.load(`<div id="r">${i.bodyHtml || ''}</div>`, null, false);
  const text = textOf($, '#r');
  const nWords = words(text).length;

  // --- shape of the body
  $('#r *').each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) { errors.push(`<${tag}> is not allowed in the body.`); return; }
    for (const a of Object.keys(el.attribs || {})) if (/^on/i.test(a) || a === 'style') errors.push(`Remove the ${a} attribute from <${tag}>.`);
    if (tag === 'div' && !(el.attribs.class || '').split(/\s+/).every((c) => ALLOWED_DIV.has(c)) ) errors.push(`<div class="${el.attribs.class || ''}"> is not allowed: use blog-inline-cta or blog-callout.`);
  });
  if ($('#r h1').length) errors.push('The body must not contain an H1: the page template adds it.');
  if (!$('#r h2').length) errors.push('The body needs H2 sections.');
  if (i.bodyHtml && /<!--/.test(i.bodyHtml)) warnings.push('HTML comments are left in the page source: remove them.');

  // --- length
  const [lo, hi] = i.wordRange?.length === 2 ? i.wordRange : WORDS[kind];
  if (nWords < Math.round(lo * 0.9)) errors.push(`The body is ${nWords} words; aim for ${lo} to ${hi}.`);
  else if (nWords > Math.round(hi * 1.15)) errors.push(`The body is ${nWords} words; aim for ${lo} to ${hi}.`);

  // --- head fields
  if (!i.title || i.title.length > 60) errors.push(`The title is ${(i.title || '').length} characters; keep it at 60 or fewer.`);
  else if (i.title.length < 20) warnings.push('The title is very short.');
  if (!i.description || i.description.length > 155) errors.push(`The meta description is ${(i.description || '').length} characters; keep it at 155 or fewer.`);
  else if (i.description.length < 70) warnings.push('The meta description is short: say why to click.');
  if (!i.h1) errors.push('An h1 is required.');
  const slugOk = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(i.slug || '');
  if (!slugOk) errors.push('The slug must be lowercase letters, numbers and hyphens.');
  else {
    if (kind === 'post' && !/^blog-/.test(i.slug)) errors.push('A blog post slug must start with "blog-".');
    if (kind === 'page' && /^blog-/.test(i.slug)) errors.push('A landing page slug must not start with "blog-".');
    const exists = ctx.pages[`/${i.slug}`];
    if (i.mode !== 'refresh' && exists && (exists.httpStatus || 200) === 200) errors.push(`/${i.slug} already exists: use mode "refresh" or pick another slug.`);
  }

  // --- the keyword
  if (i.keyword) {
    if (!hasKeyword(i.title || '', i.keyword)) errors.push(`The title must contain the keyword "${i.keyword}".`);
    if (!hasKeyword(i.h1 || '', i.keyword)) errors.push(`The h1 must contain the keyword "${i.keyword}".`);
    if (!hasKeyword(words(text).slice(0, 100).join(' '), i.keyword)) errors.push(`The keyword "${i.keyword}" must appear in the first 100 words.`);
    if (!hasKeyword(i.description || '', i.keyword)) warnings.push('The meta description does not contain the keyword.');
  }

  // --- links
  const links = [];
  $('#r a').each((_, a) => {
    const href = ($(a).attr('href') || '').trim();
    if (!href || href === '#') { errors.push('A link has no destination.'); return; }
    if (/^(tel|mailto):/i.test(href)) return;
    const p = canonicalPath(href, `${ctx.origin}/`);
    if (p) {
      links.push(p);
      const page = ctx.pages[p];
      if (p !== '/' && !isAsset(p) && !(page && (page.httpStatus || 200) === 200 && !page.redirectTo)) errors.push(`The link to ${p} does not go to a live page.`);
    } else if (!/^https:\/\//i.test(href)) errors.push(`The link "${href}" must be https:// or a page on this site.`);
  });
  for (const req of i.requiredLinks || []) {
    const rp = canonicalPath(req, `${ctx.origin}/`);
    if (rp && !links.includes(rp)) errors.push(`The required link to ${req} is missing.`);
  }

  // --- brand lint (text of the body, title, description and h1)
  const all = `${i.title || ''}\n${i.description || ''}\n${i.h1 || ''}\n${text}`;
  const lower = all.toLowerCase();
  for (const b of BANNED) if (lower.includes(b)) errors.push(`Banned word: "${b}".`);
  if (MID_DASH.test(all.replace(/https?:\/\/\S+/g, ''))) errors.push('Mid-sentence dash found. Use a period or a comma.');
  const noBrand = all.split(BRAND).join(' ').split('No-BS Yardwork').join(' ');
  if (BAD_NAMES.some((re) => re.test(noBrand))) errors.push(`The business name must be spelled "${BRAND}" or "No-BS Yardwork".`);
  for (const m of all.matchAll(/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g)) if (m[0].replace(/\D/g, '') !== PHONE.replace(/\D/g, '')) { errors.push(`Wrong phone number "${m[0]}". It must be ${PHONE}.`); break; }
  if (/\b(guarantee|guaranteed|best in winnipeg|#1|number one|cheapest)\b/i.test(all)) errors.push('Unsubstantiated claim (guarantee, best in Winnipeg, cheapest).');
  if (kind === 'post' && (all.match(/winnipeg/gi) || []).length < 6) warnings.push('Mention Winnipeg at least 6 times for local relevance.');

  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings, words: nWords, links };
}

/** A single paragraph for an existing page (link edits): allowed tags, live links, the required link, brand lint. */
function checkFragment(html, { requiredLinks = [], pages, origin }) {
  const errors = [];
  const $ = cheerio.load(`<div id="r">${html || ''}</div>`, null, false);
  const kids = $('#r').children();
  if (kids.length !== 1 || kids[0].tagName?.toLowerCase() !== 'p') errors.push('Send exactly one <p> paragraph.');
  $('#r *').each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    if (!['p', 'a', 'strong', 'em', 'b', 'i', 'br', 'span'].includes(tag)) errors.push(`<${tag}> is not allowed in the sentence.`);
    for (const a of Object.keys(el.attribs || {})) if (/^on/i.test(a) || a === 'style') errors.push(`Remove the ${a} attribute.`);
  });
  const links = [];
  $('#r a').each((_, a) => {
    const p = canonicalPath(($(a).attr('href') || '').trim(), `${origin}/`);
    if (!p) return;
    links.push(p);
    const page = pages[p];
    if (p !== '/' && !(page && (page.httpStatus || 200) === 200 && !page.redirectTo)) errors.push(`The link to ${p} does not go to a live page.`);
  });
  for (const req of requiredLinks) { const rp = canonicalPath(req, `${origin}/`); if (rp && !links.includes(rp)) errors.push(`The required link to ${req} is missing.`); }
  const text = $('#r').text();
  const lower = text.toLowerCase();
  for (const b of BANNED) if (lower.includes(b)) errors.push(`Banned word: "${b}".`);
  if (MID_DASH.test(text)) errors.push('Mid-sentence dash found. Use a period or a comma.');
  if (words(text).length > 60) errors.push('Keep the added sentence short (60 words at most).');
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

module.exports = { checkPage, checkFragment, normalizeLinks, hasKeyword };
