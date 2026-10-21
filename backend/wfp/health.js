/**
 * Daily health check for Winnipeg Fence Pros: is everything the autopilot needs set up and working?
 * Setup, FTP login + folders, sitemap reachable and listing every published post, published posts answering 200,
 * Search Console access, Serper budget, Claude key, failed jobs in the last 7 days. The latest run is the
 * Health card on the page and the `health` block of the Claude brief.
 */
const axios = require('axios');
const ftp = require('basic-ftp');
const prisma = require('../lib/prismaClient');
const { getConfig, missing } = require('./settings');
const g = require('./google');
const { getState } = require('./runner');
const { sitePages } = require('./writer');

async function testFtp(cfg) {
  const client = new ftp.Client(20000);
  try {
    await client.access({ host: cfg.FTP_HOST, port: cfg.ftpPort, user: cfg.FTP_USER, password: cfg.FTP_PASS, secure: cfg.ftpSecure });
    const base = cfg.FTP_PATH || '/';
    const names = (await client.list(base)).map((f) => f.name);
    const found = [];
    const lack = [];
    for (const f of [cfg.BLOG_INDEX_FILE, cfg.sitemapAuto ? cfg.SITEMAP_FILE : null].filter(Boolean)) (names.includes(f.split('/')[0]) ? found : lack).push(f);
    return { ok: !lack.length, detail: `Logged in; ${names.length} items in ${base}${found.length ? `; found ${found.join(', ')}` : ''}${lack.length ? `; missing ${lack.join(', ')}` : ''}` };
  } catch (err) {
    return { ok: false, detail: `FTP: ${err.message}` };
  } finally {
    client.close();
  }
}

async function testGsc(cfg) {
  if (!cfg.GSC_PROPERTY) return { ok: false, detail: 'Search Console property not set' };
  const a = await g.auth(cfg);
  if (a.error) return { ok: false, detail: a.error };
  try {
    const sites = await g.listSites(a);
    const site = sites.find((s) => s.siteUrl === cfg.GSC_PROPERTY);
    if (!site) return { ok: false, detail: `${a.email} can not see ${cfg.GSC_PROPERTY}. In Search Console → Settings → Users and permissions, add it as a Full user.`, email: a.email };
    const full = ['siteOwner', 'siteFullUser'].includes(site.permissionLevel);
    return { ok: true, detail: `${a.email}: ${site.permissionLevel}${full ? '' : ' (needs Full to submit sitemaps)'}`, email: a.email };
  } catch (err) {
    return { ok: false, detail: err.message, email: a.email };
  }
}

async function healthTick(ctx) {
  const cfg = await getConfig();
  const checks = [];
  const add = (name, ok, detail) => { checks.push({ name, ok, detail }); ctx.log(`${ok ? 'OK ' : 'BAD'} ${name}: ${detail}`); };

  const gaps = missing(cfg);
  add('Setup', !gaps.length, gaps.length ? `Missing: ${gaps.join(', ')}` : 'Everything is filled in');
  add('Autopilot', cfg.autopilot, cfg.autopilot ? `On: ${cfg.postDays.join(', ')} at ${cfg.postHour}:00, ${cfg.publishMode} mode` : 'Off (Settings → Autopilot)');

  if (cfg.FTP_HOST && cfg.FTP_USER && cfg.FTP_PASS) { const r = await testFtp(cfg); add('FTP', r.ok, r.detail); }

  const published = await prisma.wfpPost.findMany({ where: { status: 'published' }, orderBy: { publishedAt: 'desc' }, take: 30, select: { url: true, title: true } });
  if (cfg.SITEMAP_URL) {
    const urls = await sitePages(cfg, 5000);
    if (!urls.length) add('Sitemap', false, `${cfg.SITEMAP_URL} could not be read or lists no pages`);
    else {
      const set = new Set(urls.map((u) => u.replace(/\/$/, '')));
      const absent = published.filter((p) => p.url && !set.has(p.url.replace(/\/$/, '')));
      add('Sitemap', !absent.length, `${urls.length} URLs${absent.length ? `; not listed: ${absent.slice(0, 5).map((p) => p.url).join(', ')}` : '; every published post is listed'}`);
    }
  }

  if (published.length) {
    const broken = [];
    for (const p of published.slice(0, 20)) {
      const res = await axios.get(p.url, { timeout: 15000, maxRedirects: 3, validateStatus: () => true, headers: { 'User-Agent': '5StarFlow-WFP/1.0' } }).catch((e) => ({ status: e.code || 'error' }));
      if (res.status !== 200) broken.push(`${p.url} (${res.status})`);
    }
    add('Published posts', !broken.length, broken.length ? `Not loading: ${broken.join(', ')}` : `${Math.min(20, published.length)} checked, all load`);
  }

  if (cfg.GSC_PROPERTY) { const r = await testGsc(cfg); add('Search Console', r.ok, r.detail); }
  if (cfg.SERPER_API_KEY) {
    const b = g.serperBudget(await getState('serper'), cfg.serperWeeklyBudget);
    add('Serper', b.left() > 0, `${b.left()} of ${cfg.serperWeeklyBudget} searches left this week`);
  }
  add('Claude', !!cfg.ANTHROPIC_API_KEY, cfg.ANTHROPIC_API_KEY ? `Key set; writer model ${cfg.WRITER_MODEL}` : 'No Anthropic API key');

  const failed = await prisma.wfpRun.findMany({ where: { status: 'failed', startedAt: { gte: new Date(Date.now() - 7 * 86400000) } }, orderBy: { startedAt: 'desc' }, take: 5 });
  add('Jobs', !failed.length, failed.length ? failed.map((f) => `${f.job}: ${f.error}`).join(' | ').slice(0, 600) : 'No failures in 7 days');

  const bad = checks.filter((c) => !c.ok).length;
  return { summary: bad ? `${bad} of ${checks.length} checks need attention` : `All ${checks.length} checks OK`, detail: { checks } };
}

module.exports = { healthTick, testFtp, testGsc };
