/**
 * posts.json and blog.html: the blog index the site's own JavaScript and crawlers read. A port of seo_site.py's
 * blog_index (same markers, same output), but working from the live files: posts.json is the list, and each publish
 * adds or updates one entry. The daily reconcile adds any live post missing from the list.
 * blog.html carries a crawlable <ul> between the seo:post-list start/end comments, and its POSTS array between the
 * seo:posts start/end block comments.
 */
const cheerio = require('cheerio');

const START = '<!-- seo:post-list:start -->';
const END = '<!-- seo:post-list:end -->';
const A = '/* seo:posts:start */';
const B = '/* seo:posts:end */';

const pyEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

/** One posts.json entry from a live page's html (used for posts that are missing from the list). */
function postFacts(slug, html, existing = {}) {
  const $ = cheerio.load(html);
  const meta = (sel) => $(sel).attr('content') || '';
  let date = existing.date || meta('meta[property="article:published_time"]');
  if (!date) { const m = html.match(/"datePublished"\s*:\s*"([0-9-]{10})/); date = m ? m[1] : ''; }
  const words = $('.blog-post-content').text().split(/\s+/).filter(Boolean).length || $('body').text().split(/\s+/).filter(Boolean).length;
  return {
    title: existing.title || ($('title').text() || slug).replace(/\s*\|\s*No[- ]?B\.?S\.? Yardwork\s*$/i, '').trim(),
    date: String(date).slice(0, 10),
    image: existing.image || (meta('meta[property="og:image"]') || '').replace(/^https?:\/\/[^/]+\//, ''),
    excerpt: existing.excerpt || meta('meta[name="description"]'),
    url: slug,
    category: existing.category || 'Lawn Care',
    readTime: existing.readTime || Math.max(3, Math.round(words / 200)),
  };
}

/** Add or replace entries (by url) and drop the urls in `drop`; newest first, ties by url. */
function mergePosts(current, upserts = [], drop = []) {
  const by = new Map((Array.isArray(current) ? current : []).map((p) => [String(p.url).replace(/^\/+/, '').replace(/\.html?$/, ''), p]));
  for (const u of upserts) by.set(u.url, { ...(by.get(u.url) || {}), ...u });
  for (const d of drop) by.delete(d);
  return [...by.values()].sort((a, b) => (String(b.date).localeCompare(String(a.date))) || String(b.url).localeCompare(String(a.url)));
}

const postsJson = (posts) => `${JSON.stringify(posts, null, 2)}\n`;

/** blog.html with both marker regions rewritten for `posts`. { html, notes[] }: notes name anything that could not be done. */
function patchBlogHtml(src, posts) {
  let out = src; const notes = [];
  if (out.includes(START) && out.includes(END)) {
    const items = posts.map((p) => `      <li><a href="${pyEscape(p.url)}">${pyEscape(p.title)}</a> <time datetime="${p.date}">${p.date}</time></li>\n`).join('');
    out = `${out.slice(0, out.indexOf(START))}${START}\n    <ul class="seo-post-list">\n${items}    </ul>\n    ${END}${out.slice(out.indexOf(END) + END.length)}`;
  } else notes.push(`blog.html has no ${START} / ${END} markers`);
  if (out.includes(A) && out.includes(B)) out = `${out.slice(0, out.indexOf(A) + A.length)}${JSON.stringify(posts, null, 2)}${out.slice(out.indexOf(B))}`;
  else notes.push(`blog.html has no ${A} / ${B} markers around the POSTS array`);
  return { html: out, notes };
}

module.exports = { postFacts, mergePosts, postsJson, patchBlogHtml, START, END, A, B };
