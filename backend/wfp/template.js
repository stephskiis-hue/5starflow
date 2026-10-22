/**
 * Post page HTML: the POST_TEMPLATE setting with {{PLACEHOLDERS}}, Claude's body (sanitized) and the URLs the
 * publish script will use. Also builds a template from an existing page on the site (Settings → Import).
 */
const cheerio = require('cheerio');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Keep (markers removed) or drop (with its content) every <!--NAME-->...<!--/NAME--> block. flags: { NAME: true|false }. */
function toggleBlocks(html, flags) {
  let out = html;
  for (const [name, on] of Object.entries(flags)) out = out.replace(new RegExp(`<!--${name}-->([\\s\\S]*?)<!--/${name}-->`, 'g'), on ? '$1' : '');
  return out;
}

const absUrl = (cfg, p) => (/^https?:\/\//i.test(p) ? p : `${cfg.SITE_URL}${p.startsWith('/') ? '' : '/'}${p}`);

/** Where a post lives: file name, folder, public URL and the path the list links to. */
function postUrls(cfg, slug) {
  const dir = cfg.BLOG_DIR ? `${cfg.BLOG_DIR}/` : '';
  const folder = cfg.urlStyle !== 'html';
  const pathPart = folder ? `/${dir}${slug}/` : `/${dir}${slug}.html`;
  const imagesDir = String(cfg.IMAGES_DIR || 'images').replace(/^\/+|\/+$/g, '');
  const index = String(cfg.BLOG_INDEX_FILE || '').replace(/^\/+/, '');
  const indexPath = !index ? '/' : /(^|\/)index\.html$/.test(index) ? `/${index.replace(/index\.html$/, '')}` : `/${index}`;
  return {
    file: folder ? 'index.html' : `${slug}.html`,
    remoteDir: folder ? `${dir}${slug}` : cfg.BLOG_DIR,
    path: pathPart,
    url: `${cfg.SITE_URL}${pathPart}`,
    image: `/${imagesDir}/${slug}.webp`,
    blogUrl: `${cfg.SITE_URL}${indexPath}`,
  };
}

/** The service (settings) a category name belongs to, or null. */
const serviceByName = (cfg, name) => (cfg.services || []).find((s) => s.name.toLowerCase() === String(name || '').toLowerCase()) || null;

/** Shared {{PLACEHOLDER}} values for the article page, the list page and the cards. All escaped. */
function siteValues(cfg, category) {
  const svc = serviceByName(cfg, category);
  const nav = (cfg.navLinks || []).map((n) => `<a href="${esc(n.path)}">${esc(n.label)}</a>`).join('');
  return {
    BUSINESS_NAME: esc(cfg.BUSINESS_NAME), PHONE: esc(cfg.PHONE), QUOTE_URL: esc(cfg.QUOTE_URL || `${cfg.SITE_URL}/`), CITY: esc(cfg.CITY), REGION: esc(cfg.REGION),
    SITE_URL: esc(cfg.SITE_URL), LOGO_URL: esc(cfg.LOGO_URL), FAVICON_URL: esc(cfg.FAVICON_URL || '/favicon.ico'), NAV: nav,
    SERVICE_NAME: esc(svc ? svc.name : cfg.BUSINESS_NAME), SERVICE_URL: esc(svc?.path ? absUrl(cfg, svc.path) : `${cfg.SITE_URL}/`),
  };
}

const fill = (html, values) => html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in values ? values[k] : m));

/** Claude's body: drop anything that runs code or breaks the page; the template owns the single <h1>. */
function sanitizeBody(html) {
  const $ = cheerio.load(`<div id="wfp-root">${html || ''}</div>`, null, false);
  $('script, style, iframe, object, embed, form, input, button, link, meta, base, svg').remove();
  $('h1').each((_, el) => { el.tagName = 'h2'; });
  $('*').each((_, el) => {
    for (const name of Object.keys(el.attribs || {})) {
      const v = String(el.attribs[name] || '');
      if (/^on/i.test(name) || name === 'style' || (/^(href|src)$/i.test(name) && /^\s*(javascript|data|vbscript):/i.test(v))) $(el).removeAttr(name);
    }
  });
  return $('#wfp-root').html().trim();
}

function schemaJson(cfg, post, urls, date, image) {
  const article = {
    '@type': 'BlogPosting', headline: post.title, description: post.metaDescription, datePublished: date, dateModified: date,
    mainEntityOfPage: urls.url, articleSection: post.category,
    author: { '@type': 'Organization', name: cfg.BUSINESS_NAME }, publisher: { '@type': 'Organization', name: cfg.BUSINESS_NAME, url: cfg.SITE_URL },
  };
  if (image) article.image = absUrl(cfg, image);
  const graph = [article, {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${cfg.SITE_URL}/` },
      { '@type': 'ListItem', position: 2, name: 'Articles', item: urls.blogUrl },
      { '@type': 'ListItem', position: 3, name: post.title, item: urls.url },
    ],
  }];
  if (post.faq?.length) graph.push({ '@type': 'FAQPage', mainEntity: post.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  return `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}</script>`;
}

function faqHtml(faq) {
  if (!faq?.length) return '';
  return `\n<h2>Frequently asked questions</h2>\n${faq.map((f) => `<h3>${esc(f.q)}</h3>\n<p>${esc(f.a)}</p>`).join('\n')}`;
}

/** The full page for a written post. date: YYYY-MM-DD. post.image overrides the default hero path ('' = no hero). */
function renderPost(cfg, post, date) {
  const urls = postUrls(cfg, post.slug);
  const image = post.image !== undefined && post.image !== null ? post.image : urls.image;
  const human = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const values = {
    ...siteValues(cfg, post.category),
    TITLE: esc(post.title), META_DESCRIPTION: esc(post.metaDescription), CANONICAL: esc(urls.url), IMAGE: esc(image), IMAGE_URL: esc(image ? absUrl(cfg, image) : ''),
    IMAGE_ALT: esc(post.imageAlt || post.title), DATE: date, DATE_HUMAN: esc(human), READ_TIME: String(post.readTime || 5), CATEGORY: esc(post.category),
    BLOG_URL: esc(urls.blogUrl), YEAR: date.slice(0, 4),
    BODY: sanitizeBody(post.bodyHtml) + faqHtml(post.faq), SCHEMA: schemaJson(cfg, post, urls, date, image),
  };
  let html = String(cfg.POST_TEMPLATE || '');
  if (!html.includes('{{BODY}}')) throw new Error('The post template has no {{BODY}} placeholder');
  html = toggleBlocks(html, { HERO: !!image, LOGO: !!cfg.LOGO_URL, NOLOGO: !cfg.LOGO_URL, PHONE: !!cfg.PHONE });
  return { html: fill(html, values), urls };
}

/** One card for the list page. p: { slug, url (path), title, excerpt, category, readTime, date (YYYY-MM-DD), image }. */
function renderCard(cfg, p) {
  const human = new Date(`${p.date}T12:00:00Z`).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const values = { ...siteValues(cfg, p.category), URL: esc(p.url), TITLE: esc(p.title), EXCERPT: esc(p.excerpt), CATEGORY: esc(p.category), READ_TIME: String(p.readTime || 5), DATE_HUMAN: esc(human), IMAGE: esc(p.image || '') };
  return fill(toggleBlocks(String(cfg.CARD_TEMPLATE || ''), { IMG: !!p.image }), values);
}

/** All cards, newest first. */
const renderCards = (cfg, posts) => [...posts].sort((a, b) => String(b.date).localeCompare(String(a.date))).map((p) => renderCard(cfg, p)).join('\n');

/** The whole list page from INDEX_TEMPLATE (used when the page does not exist yet). */
function renderIndex(cfg, cardsHtml) {
  const urls = postUrls(cfg, 'x');
  const html = toggleBlocks(String(cfg.INDEX_TEMPLATE || ''), { LOGO: !!cfg.LOGO_URL, NOLOGO: !cfg.LOGO_URL, PHONE: !!cfg.PHONE });
  return fill(html, { ...siteValues(cfg, ''), BLOG_URL: esc(urls.blogUrl), YEAR: String(new Date().getFullYear()), CARDS: cardsHtml });
}

/**
 * Turn an existing page from the site into a template: title, description, canonical and the main content become
 * placeholders. Returns { template, replaced: [what was found] }.
 */
function templateFromPage(pageHtml) {
  const $ = cheerio.load(pageHtml);
  const replaced = [];
  $('title').text('{{TITLE}} | {{BUSINESS_NAME}}'); replaced.push('title');
  const desc = $('meta[name="description"]');
  if (desc.length) desc.attr('content', '{{META_DESCRIPTION}}'); else $('head').append('<meta name="description" content="{{META_DESCRIPTION}}">');
  const canon = $('link[rel="canonical"]');
  if (canon.length) canon.attr('href', '{{CANONICAL}}'); else $('head').append('<link rel="canonical" href="{{CANONICAL}}">');
  $('meta[property="og:title"]').attr('content', '{{TITLE}}');
  $('meta[property="og:description"]').attr('content', '{{META_DESCRIPTION}}');
  $('meta[property="og:url"]').attr('content', '{{CANONICAL}}');
  $('meta[property="og:image"]').attr('content', '{{IMAGE_URL}}');
  $('script[type="application/ld+json"]').remove();
  $('head').append('{{SCHEMA}}');
  const main = $('article').first().length ? $('article').first() : $('main').first();
  if (!main.length) return { template: null, replaced, error: 'No <article> or <main> on that page: use the default template and change its styles instead' };
  main.html('\n<p class="meta"><a href="{{BLOG_URL}}">Blog</a> · {{CATEGORY}} · {{DATE_HUMAN}} · {{READ_TIME}} min read</p>\n<h1>{{TITLE}}</h1>\n<!--HERO--><img src="{{IMAGE}}" alt="{{IMAGE_ALT}}" style="width:100%;height:auto"><!--/HERO-->\n{{BODY}}\n<p><a href="{{QUOTE_URL}}">Get My Free Quote</a> · <a href="tel:{{PHONE}}">{{PHONE}}</a></p>\n');
  replaced.push(main.is('article') ? 'article' : 'main');
  // any other h1 outside the content would make two
  $('h1').each((i, el) => { if (!$(el).closest(main).length) el.tagName = 'p'; });
  return { template: $.html(), replaced };
}

module.exports = { postUrls, sanitizeBody, renderPost, renderCard, renderCards, renderIndex, templateFromPage, toggleBlocks, serviceByName, absUrl, esc };
