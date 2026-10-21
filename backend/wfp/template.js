/**
 * Post page HTML: the POST_TEMPLATE setting with {{PLACEHOLDERS}}, Claude's body (sanitized) and the URLs the
 * publish script will use. Also builds a template from an existing page on the site (Settings → Import).
 */
const cheerio = require('cheerio');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Where a post lives: file name, folder, public URL and the path the blog index links to. */
function postUrls(cfg, slug) {
  const dir = cfg.BLOG_DIR ? `${cfg.BLOG_DIR}/` : '';
  const pathPart = `/${dir}${slug}${cfg.cleanUrls ? '' : '.html'}`;
  const imagesDir = String(cfg.IMAGES_DIR || 'images').replace(/^\/+|\/+$/g, '');
  return {
    file: `${slug}.html`,
    remoteDir: cfg.BLOG_DIR,
    path: pathPart,
    url: `${cfg.SITE_URL}${pathPart}`,
    image: `/${imagesDir}/${slug}.webp`,
    blogUrl: cfg.BLOG_INDEX_FILE ? `${cfg.SITE_URL}/${cfg.cleanUrls ? cfg.BLOG_INDEX_FILE.replace(/\.html$/, '') : cfg.BLOG_INDEX_FILE}` : `${cfg.SITE_URL}/`,
  };
}

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

function schemaJson(cfg, post, urls, date) {
  const graph = [{
    '@type': 'BlogPosting', headline: post.title, description: post.metaDescription, datePublished: date, dateModified: date,
    mainEntityOfPage: urls.url, image: `${cfg.SITE_URL}${urls.image}`,
    author: { '@type': 'Organization', name: cfg.BUSINESS_NAME }, publisher: { '@type': 'Organization', name: cfg.BUSINESS_NAME, url: cfg.SITE_URL },
  }];
  if (post.faq?.length) graph.push({ '@type': 'FAQPage', mainEntity: post.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  return `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}</script>`;
}

function faqHtml(faq) {
  if (!faq?.length) return '';
  return `\n<h2>Frequently asked questions</h2>\n${faq.map((f) => `<h3>${esc(f.q)}</h3>\n<p>${esc(f.a)}</p>`).join('\n')}`;
}

/** The full page for a written post. date: YYYY-MM-DD. */
function renderPost(cfg, post, date) {
  const urls = postUrls(cfg, post.slug);
  const human = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const values = {
    TITLE: esc(post.title), META_DESCRIPTION: esc(post.metaDescription), CANONICAL: esc(urls.url), IMAGE: esc(urls.image), IMAGE_URL: esc(`${cfg.SITE_URL}${urls.image}`),
    IMAGE_ALT: esc(post.imageAlt || post.title), DATE: date, DATE_HUMAN: esc(human), READ_TIME: String(post.readTime || 5), CATEGORY: esc(post.category),
    BUSINESS_NAME: esc(cfg.BUSINESS_NAME), PHONE: esc(cfg.PHONE), QUOTE_URL: esc(cfg.QUOTE_URL || `${cfg.SITE_URL}/`), CITY: esc(cfg.CITY), REGION: esc(cfg.REGION),
    SITE_URL: esc(cfg.SITE_URL), BLOG_URL: esc(urls.blogUrl), YEAR: date.slice(0, 4),
    BODY: sanitizeBody(post.bodyHtml) + faqHtml(post.faq), SCHEMA: schemaJson(cfg, post, urls, date),
  };
  let html = String(cfg.POST_TEMPLATE || '');
  if (!html.includes('{{BODY}}')) throw new Error('The post template has no {{BODY}} placeholder');
  html = html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in values ? values[k] : m));
  return { html, urls };
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

module.exports = { postUrls, sanitizeBody, renderPost, templateFromPage, esc };
