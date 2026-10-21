/**
 * Routine site-publish-index: posts.json, blog.html and the sitemaps kept in step with the live site every morning.
 * Until the owner sets growthConfig.siteIndexAuto (after reading a dry run), it only reports what it would change.
 */
const g = require('../seo/google');
const sa = require('../seo/siteAccess');
const { reconcileIndex } = require('./publish');

async function siteIndexTick(ctx) {
  const seo = await g.loadSeo(ctx.userId);
  if (!(await sa.ftpConfig(ctx.userId))) return { skipped: true, summary: 'The FTP login is not set up (Website Audit page): nothing to do.' };
  const r = await reconcileIndex(ctx.userId, { dry: seo.cfg.siteIndexAuto !== true });
  const verb = r.dryRun ? 'Would change' : 'Changed';
  return {
    items_found: r.changed.length,
    requires_attention: r.notes.length,
    summary: `${verb}: ${r.changed.join(', ') || 'nothing'}. ${r.posts} posts; sitemap +${r.sitemap.added.length} -${r.sitemap.removed.length}.${r.dryRun && seo.cfg.siteIndexAuto !== true ? ' (dry run until siteIndexAuto is turned on)' : ''}`,
    actions_taken: [...r.changed.map((f) => `${verb} ${f}`), ...r.added.map((s) => `Added ${s} to posts.json`), ...r.notes],
  };
}

module.exports = { siteIndexTick };
