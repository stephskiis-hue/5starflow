/**
 * The live website over FTP: the only place the server writes site files (there is no copy of the site on Railway).
 * Every change to a text file keeps the previous version in SiteFileVersion, a write to a public URL is probed
 * afterwards, and a failed probe puts the old file back (a brand-new file is removed again).
 */
const prisma = require('../../lib/prismaClient');
const sa = require('../seo/siteAccess');
const g = require('../seo/google');

const KEEP = 5;
const TEXT = /(\.(html?|xml|json|txt)|(^|\/)\.htaccess)$/i;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const canWrite = () => process.env.SITE_PUBLISH === 'on' || process.env.DRY_RUN !== 'true';

async function remember(userId, rel, before, reason) {
  await prisma.siteFileVersion.create({ data: { userId, path: rel, content: before.toString('utf8'), reason: reason ? String(reason).slice(0, 200) : null } });
  const old = await prisma.siteFileVersion.findMany({ where: { userId, path: rel }, orderBy: { createdAt: 'desc' }, skip: KEEP, select: { id: true } });
  if (old.length) await prisma.siteFileVersion.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
}

function handle(f, userId, origin) {
  return {
    origin,
    /** The file, or null only when the server says it does not exist (any other FTP error is thrown, never read as "missing"). */
    async read(rel) {
      try { return await f.read(f.file(rel)); } catch (e) {
        if (e.code === 550 || /\b550\b|no such file|not found/i.test(e.message || '')) return null;
        throw e;
      }
    },
    async readText(rel) { const b = await this.read(rel); return b ? b.toString('utf8') : null; },
    /** { changed, created }. probeUrl: a public URL that must still answer 200 afterwards. */
    async write(rel, content, { reason, probeUrl } = {}) {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      const p = f.file(rel);
      const before = await this.read(rel);
      if (before && Buffer.compare(before, buf) === 0) return { changed: false, created: false };
      if (before && TEXT.test(rel)) await remember(userId, rel, before, reason);
      await f.write(p, buf);
      if (probeUrl) {
        const r = await sa.probe(probeUrl);
        if (r.status !== 200) {
          if (before) await f.write(p, before); else await f.remove(p).catch(() => {});
          throw httpError(502, `${probeUrl} answered ${r.status || r.error || 'nothing'} after the upload: ${rel} was ${before ? 'put back' : 'removed'}`);
        }
      }
      return { changed: true, created: !before };
    },
  };
}

/** Run fn(site) with the FTP connection open and the site root verified against the live homepage. */
async function withSite(userId, fn, { write = false } = {}) {
  const seo = await g.loadSeo(userId);
  const found = await sa.ftpConfig(userId);
  if (!found) throw httpError(503, 'The FTP login is not set up: enter it on the Website Audit page');
  if (write && !canWrite()) throw httpError(403, 'Publishing is off while DRY_RUN=true (set SITE_PUBLISH=on to allow it)');
  const root = await sa.siteRoot(found, seo.origin);
  if (!root) throw httpError(503, `The FTP folder ${found.root} does not hold the live site (its index.html does not match the homepage)`);
  return sa.withFtp({ ...found, root }, (f) => fn(handle(f, userId, seo.origin), seo));
}

/** Put the newest saved version of a text file back (the undo for a bad publish). */
async function restoreLatest(userId, rel) {
  const v = await prisma.siteFileVersion.findFirst({ where: { userId, path: rel }, orderBy: { createdAt: 'desc' } });
  if (!v) throw httpError(404, `No saved version of ${rel}`);
  const out = await withSite(userId, (site) => site.write(rel, v.content, { reason: 'restore' }), { write: true });
  await prisma.siteFileVersion.delete({ where: { id: v.id } });
  return { restored: rel, from: v.createdAt, ...out };
}

module.exports = { withSite, restoreLatest, canWrite, httpError, TEXT };
