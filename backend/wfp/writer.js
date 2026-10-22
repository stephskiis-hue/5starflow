/**
 * The Claude writer, run on the 5StarFlow server (Anthropic API, ANTHROPIC_API_KEY from the page or the server).
 *   1. research: web search for local facts (City of Winnipeg fence rules, real cost ranges, what ranks now)
 *   2. write: a structured post (title, slug, meta, excerpt, body HTML, FAQ) from the notes, the keyword data,
 *      the site's real pages for internal links, the owner's notes and any open instructions on the page
 * The deterministic parts (picking the keyword, the template, FTP, sitemap) stay in code.
 */
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const prisma = require('../lib/prismaClient');
const kw = require('./keywords');
const { postUrls, serviceByName, absUrl } = require('./template');

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'slug', 'metaDescription', 'excerpt', 'category', 'readTime', 'imageQuery', 'imageAlt', 'bodyHtml', 'faq'],
  properties: {
    title: { type: 'string', description: 'Post title and H1, under 65 characters, contains the keyword' },
    slug: { type: 'string', description: 'lowercase-words-with-dashes, 3 to 7 words, contains the keyword' },
    metaDescription: { type: 'string', description: '140 to 158 characters' },
    excerpt: { type: 'string', description: 'One or two sentences for the blog index, under 200 characters' },
    category: { type: 'string' },
    readTime: { type: 'integer', description: 'Minutes to read' },
    imageQuery: { type: 'string', description: 'Stock photo search words for the hero image, e.g. "cedar privacy fence backyard"' },
    imageAlt: { type: 'string' },
    bodyHtml: { type: 'string', description: 'Article body HTML without the H1: <p>, <h2>, <h3>, <ul>, <ol>, <table>, <a>, <strong>' },
    faq: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['q', 'a'], properties: { q: { type: 'string' }, a: { type: 'string' } } } },
  },
};

/** Pages listed in the site's sitemap (one level of sitemap index), for internal links. */
async function sitePages(cfg, max = 150) {
  if (!cfg.SITEMAP_URL) return [];
  const get = async (u) => (await axios.get(u, { timeout: 15000, responseType: 'text', headers: { 'User-Agent': '5StarFlow-WFP/1.0' } })).data;
  const locs = (xml) => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  try {
    const xml = await get(cfg.SITEMAP_URL);
    if (/<sitemapindex/i.test(xml)) {
      const out = [];
      for (const child of locs(xml).slice(0, 5)) out.push(...locs(await get(child).catch(() => '')));
      return out.slice(0, max);
    }
    return locs(xml).slice(0, max);
  } catch {
    return [];
  }
}

function client(cfg) {
  if (!cfg.ANTHROPIC_API_KEY) throw new Error('No Anthropic API key (Settings → API keys)');
  return new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, timeout: 10 * 60 * 1000 });
}

/** One streamed request with the refusal fallback on; retried once without it if the account rejects the beta. */
async function ask(api, params) {
  try {
    return await api.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }).finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) return api.beta.messages.stream(params).finalMessage();
    throw err;
  }
}

const textOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

function businessBlock(cfg) {
  return [
    `Business: ${cfg.BUSINESS_NAME}, a fence company in ${cfg.CITY}, ${cfg.REGION}, Canada.`,
    `Website: ${cfg.SITE_URL}. Quote page: ${cfg.QUOTE_URL || cfg.SITE_URL}. Phone: ${cfg.PHONE || '(none given)'}.`,
    `Services (the site has a page for each): ${cfg.services.map((s) => (s.path ? `${s.name} (${cfg.SITE_URL}${s.path})` : s.name)).join(', ')}.`,
    `Neighbourhoods served: ${cfg.areas.join(', ')}.`,
  ].join('\n');
}

async function research(api, cfg, piece, log) {
  const k = piece.keyword;
  const messages = [{ role: 'user', content: `${businessBlock(cfg)}

Research for a blog post that should rank in Google for "${k.keyword}" (searchers in ${cfg.CITY}).
Find and write down, with the source URL after each fact:
- what the pages ranking for this search cover, and what they miss
- local facts that matter: City of ${cfg.CITY} fence rules (height, permits, property lines, corner lots, pools), utility locates, climate (frost heave, snow load, wind), typical timing
- real cost ranges in ${cfg.CITY} or Canada for this topic, only from sources you found, with the year
- the questions people ask about it
Return plain research notes, no draft.` }];
  let msg;
  for (let turn = 0; turn < 4; turn += 1) {
    msg = await ask(api, {
      model: cfg.WRITER_MODEL || 'claude-opus-5-5', max_tokens: 16000, output_config: { effort: 'medium' }, messages,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6, user_location: { type: 'approximate', city: cfg.CITY, region: cfg.REGION, country: 'CA', timezone: 'America/Winnipeg' } }],
    });
    if (msg.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: msg.content });
  }
  if (msg.stop_reason === 'refusal') throw new Error(`Claude declined the research (${msg.stop_details?.category || 'no category'})`);
  const sources = [];
  for (const b of msg.content) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r.url) sources.push({ title: r.title, url: r.url });
  }
  log(`Research: ${sources.length} sources`);
  return { notes: textOf(msg), sources: sources.slice(0, 20) };
}

/**
 * Write a post for a plan.nextPiece() piece. Returns the structured post (slug final, unique on the site).
 * existing: for a refresh, the post being rewritten ({ slug, html, url }).
 */
async function writePost(cfg, piece, { log = () => {}, existing = null } = {}) {
  const api = client(cfg);
  const k = piece.keyword;
  const [notes, pages, posts, queries, instructions] = await Promise.all([
    research(api, cfg, piece, log),
    sitePages(cfg),
    prisma.wfpPost.findMany({ where: { status: 'published' }, orderBy: { publishedAt: 'desc' }, take: 60, select: { title: true, url: true, keyword: true, slug: true } }),
    prisma.wfpQuery.findMany({ orderBy: { impressions: 'desc' }, take: 400 }),
    prisma.wfpNote.findMany({ where: { kind: 'instruction', done: false }, orderBy: { createdAt: 'asc' }, take: 10 }),
  ]);
  const related = queries.filter((q) => { const m = ` ${kw.matchKey(q.query)} `; return k.matchKey.split(' ').every((w) => m.includes(` ${w} `)); }).slice(0, 12);
  const focusPost = piece.mode === 'support' && piece.focus?.targetUrl ? piece.focus.targetUrl : null;
  const linkPages = [...new Set([...pages, ...posts.map((p) => p.url).filter(Boolean)])].filter((u) => !existing || u !== existing.url).slice(0, 120);

  const system = `You write blog posts for a local fence company's website, to rank in Google and turn readers into quote requests.
${businessBlock(cfg)}

Owner's notes for the writer:
${cfg.WRITER_NOTES || '(none)'}
${instructions.length ? `\nStanding instructions from the owner:\n${instructions.map((n) => `- ${n.title ? `${n.title}: ` : ''}${n.body}`).join('\n')}` : ''}

Rules:
- 900 to 1,400 words of body. Short paragraphs, H2 sections people would scan for, H3 where it helps, a table or list where it makes the answer clearer.
- Use the exact keyword in the title, the first paragraph and one H2; use close variants naturally after that. No keyword stuffing.
- Facts, prices, bylaws and numbers only from the research notes, and say where a number comes from or that it varies. Never invent prices, reviews, warranties, awards, years in business or claims about the company.
- Link to the quote page once in the body with a natural call to action. Add 2 to 4 links to the site's own pages listed below where they truly help (exact URLs only, never made up). One or two links to the strongest outside sources (city bylaws, manufacturers) are fine.
- Canadian spelling. No em dashes. Never use these words: leverage, seamlessly, game-changer, cutting-edge, revolutionize, delve.
- bodyHtml: no <h1>, no images, no scripts, no inline styles. The FAQ goes in the faq field (3 to 5 questions people really ask), not in bodyHtml.`;

  const brief = [
    `Write a ${piece.mode === 'refresh' ? 'refreshed version of an existing post' : 'new post'} targeting: "${k.keyword}" (search intent: ${k.intent}, content type: ${kw.contentTypeFor(k.keyword)}).`,
    k.service ? `Service: ${k.service}. Link once to the ${k.service} page (${(() => { const sv = serviceByName(cfg, k.service); return sv?.path ? absUrl(cfg, sv.path) : cfg.SITE_URL; })()}) where it fits naturally, with anchor text that says what the page offers.` : '',
    related.length ? `Search Console queries on this topic (impressions in 28 days, average position):\n${related.map((q) => `- ${q.query} (${q.impressions}, ${q.position})`).join('\n')}` : 'Search Console has no data for this topic yet.',
    k.signals?.paa?.length ? `People Also Ask: ${k.signals.paa.join(' | ')}` : '',
    k.serpTop?.length ? `Pages that rank above us now: ${k.serpTop.map((r) => `${r.title} (${r.link})`).join('; ')}` : '',
    focusPost ? `This is a supporting post for the focus keyword "${piece.focus.keyword}". Link to ${focusPost} once in the first half of the post with anchor text that describes it (a variant of "${piece.focus.keyword}").` : '',
    piece.mode === 'refresh' && existing ? `Keep the slug "${existing.slug}". Improve the post below: answer the search better than the pages ranking above it, update facts, add what is missing, keep what works.\n\nCurrent post HTML:\n${existing.html.slice(0, 40000)}` : '',
    `Site pages you may link to:\n${linkPages.join('\n') || '(none listed)'}`,
    `Research notes:\n${notes.notes}`,
    `The category is set by the server (${k.service || cfg.POST_CATEGORY || 'Fence'}); put anything in the category field.`,
  ].filter(Boolean).join('\n\n');

  const msg = await ask(api, {
    model: cfg.WRITER_MODEL || 'claude-opus-5-5', max_tokens: 32000, output_config: { effort: 'high', format: { type: 'json_schema', schema: POST_SCHEMA } },
    system, messages: [{ role: 'user', content: brief }],
  });
  if (msg.stop_reason === 'refusal') throw new Error(`Claude declined the post (${msg.stop_details?.category || 'no category'})`);
  if (msg.stop_reason === 'max_tokens') throw new Error('The post was cut off (max_tokens)');
  let post;
  try { post = JSON.parse(textOf(msg)); } catch { throw new Error('Claude returned a post that is not valid JSON'); }

  post.category = k.service || cfg.POST_CATEGORY || 'Fence';
  let slug = existing ? existing.slug : kw.slugify(post.slug || post.title);
  if (!existing) {
    const taken = new Set((await prisma.wfpPost.findMany({ where: { status: { in: ['published', 'draft', 'publishing'] } }, select: { slug: true } })).map((p) => p.slug));
    const live = new Set(pages.map((u) => { try { return new URL(u).pathname.replace(/\.html$/, '').split('/').filter(Boolean).pop() || ''; } catch { return ''; } }));
    for (let i = 2; taken.has(slug) || live.has(slug); i += 1) slug = `${kw.slugify(post.slug || post.title)}-${i}`;
  }
  const words = String(post.bodyHtml || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  if (words < 400) throw new Error(`The post is too short (${words} words)`);
  if (!new RegExp(k.matchKey.split(' ')[0], 'i').test(post.title)) log(`Note: the title does not contain "${k.matchKey.split(' ')[0]}"`);
  log(`Wrote "${post.title}" (${words} words, ${postUrls(cfg, slug).url})`);
  return { ...post, slug, readTime: Math.max(2, Math.min(20, post.readTime || Math.round(words / 220))), sources: notes.sources, words, usage: msg.usage };
}

module.exports = { writePost, sitePages, POST_SCHEMA };
