/**
 * Fills the page template (templates/post.html, copied from a live post: head, nav and footer stay as the site has
 * them) with a structured post. The server owns everything around the writer's body: head tags, JSON-LD, hero,
 * byline and the closing quote box, so the writer cannot get those wrong.
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'templates', 'post.html'), 'utf8');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const BRAND_SUFFIX = / \| No-BS Yardwork$/i;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jsonLd = (obj) => `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2).replace(/</g, '\\u003c')}\n    </script>`;

/** "2026-10-19" -> "October 19, 2026" (no time zone maths: the date is already the business's date). */
function dateLabel(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : '';
}

const CTA_BOX = `            <div class="blog-cta-box">
              <h3>Get a Clear Price for Your Winnipeg Yard</h3>
              <p>No pressure, no runaround. Call 204-900-0438 or request a quote based on your actual property.</p>
              <a href="contact.html">Get a Free Quote</a>
            </div>
`;

/**
 * p: { kind: 'post'|'page', origin, slug, title, description, keywords[], h1, crumb, image ('images/x.webp'),
 *      imageAlt, date, modified, bodyHtml }
 */
function renderPage(p) {
  const url = `${p.origin}/${p.slug}`;
  const isPost = p.kind !== 'page';
  const imageUrl = p.image ? `${p.origin}/${p.image}` : '';
  const crumb = p.crumb || p.h1;
  const crumbs = [['Home', `${p.origin}/`, 'index.html']].concat(isPost ? [['Blog', `${p.origin}/blog.html`, 'blog.html']] : []);
  const article = isPost
    ? { '@context': 'https://schema.org', '@type': 'Article', headline: p.title, description: p.description,
      author: { '@type': 'Organization', name: 'No-BS Yardwork' },
      publisher: { '@type': 'Organization', name: 'No-BS Yardwork', logo: { '@type': 'ImageObject', url: `${p.origin}/images/logo.webp` } },
      datePublished: p.date, ...(p.modified && p.modified !== p.date ? { dateModified: p.modified } : {}), ...(imageUrl ? { image: imageUrl } : {}), url }
    : { '@context': 'https://schema.org', '@type': 'WebPage', name: p.title, description: p.description, url,
      publisher: { '@type': 'Organization', name: 'No-BS Yardwork' }, ...(p.modified ? { dateModified: p.modified } : {}) };
  const breadcrumb = { '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [...crumbs.map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })), { '@type': 'ListItem', position: crumbs.length + 1, name: crumb, item: url }] };
  const crumbHtml = crumbs.map(([name, , href]) => `<li class="breadcrumb-item"><a href="${href}">${name}</a></li>`).join('\n                  ')
    + `\n                  <li class="breadcrumb-item active" aria-current="page">${esc(crumb)}</li>\n                `;

  const hero = imageUrl ? `            <img src="${esc(p.image)}" alt="${esc(p.imageAlt || p.title)}" class="blog-hero-img" width="1200" height="675" loading="eager" />\n\n` : '';
  const byline = isPost ? `            <p class="blog-meta">Written by The No-BS Team &nbsp;|&nbsp; ${dateLabel(p.date)} &nbsp;|&nbsp; Winnipeg, MB</p>\n` : '';
  const main = `${hero}${byline}${p.bodyHtml.trim().split('\n').map((l) => (l.trim() ? `            ${l.trim()}` : '')).join('\n')}\n\n${CTA_BOX}`;

  const fill = { TITLE: esc(p.title), DESCRIPTION: esc(p.description), KEYWORDS: esc((p.keywords || []).join(', ')), URL: esc(url),
    OG_TYPE: isPost ? 'article' : 'website', IMAGE_URL: esc(imageUrl), H1: esc(p.h1), CRUMBS: crumbHtml };
  let html = TEMPLATE;
  for (const [k, v] of Object.entries(fill)) html = html.split(`{{${k}}}`).join(v);
  return html.replace('{{JSONLD}}', () => `${jsonLd(article)}\n\n    ${jsonLd(breadcrumb)}`).replace('{{MAIN}}', () => main);
}

/**
 * The editable parts of a live page in the standard layout, or null when the page is laid out differently
 * (then the writer cannot refresh it through the API and a human has to).
 */
function extractPage(html) {
  const $ = cheerio.load(html);
  const col = $('.blog-post-content .col-lg-8').first();
  if (!col.length) return null;
  const meta = (n) => $(`meta[name="${n}"]`).attr('content') || '';
  const ld = $('script[type="application/ld+json"]').map((_, el) => { try { return JSON.parse($(el).text()); } catch { return null; } }).get().filter(Boolean);
  const art = ld.find((o) => o['@type'] === 'Article') || {};
  const hero = col.find('img.blog-hero-img').first();
  const body = cheerio.load(`<div id="r">${col.html()}</div>`);
  body('img.blog-hero-img, p.blog-meta').remove();
  body('.blog-cta-box').last().remove();
  const crumbs = $('.breadcrumb .breadcrumb-item');
  return {
    title: ($('title').text() || '').replace(BRAND_SUFFIX, '').trim(), description: meta('description'),
    keywords: meta('keywords').split(',').map((s) => s.trim()).filter(Boolean), h1: $('h1').first().text().trim(),
    crumb: crumbs.last().text().trim(), kind: crumbs.length > 2 ? 'post' : 'page',
    image: (hero.attr('src') || '').replace(/^https?:\/\/[^/]+\//, ''), imageAlt: hero.attr('alt') || '',
    date: art.datePublished || '', modified: art.dateModified || '', bodyHtml: body('#r').html().replace(/\n\s*\n+/g, '\n').trim(),
  };
}

module.exports = { renderPage, extractPage, dateLabel, esc, CTA_BOX };
