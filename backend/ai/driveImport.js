/**
 * Vault ← Google Drive. Nightly, before the Night Studio curates:
 *   1. newest images first (anything added since the last sync), then
 *   2. one more page of older images (backfillPageToken) until the whole Drive has been seen.
 * Each kept photo is stored twice: the original (kind "original", hidden; ≤3072px, no metadata)
 * and an enhanced copy (kind "photo") that points at it, so the curator can re-edit or revert.
 * Code only filters on facts (size, screenshots, black frames); judging the photo is the curator's job.
 */
const axios = require('axios');
const prisma = require('../lib/prismaClient');
const vault = require('./vault');
const { assess, enhance, prepareOriginal } = require('./enhance');

const API = 'https://www.googleapis.com/drive/v3';
// Photos live in Postgres, which shares a small plan with the app: a 30-photo burst of full camera files
// knocked the database over on 2026-10-05. Keep runs small and paced.
const PER_RUN = Number(process.env.DRIVE_IMPORT_PER_RUN) || 12;
const PAUSE_MS = 1500;
const MIN_EDGE = 600;                 // short edge; the business's own 1080×720 shots must pass
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const FIELDS = 'nextPageToken, files(id, name, mimeType, size, createdTime, parents, imageMediaMetadata(width, height, time))';

async function accessToken(cred) {
  if (cred.accessToken && cred.tokenExpiry && cred.tokenExpiry.getTime() - Date.now() > 5 * 60000) return cred.accessToken;
  if (!cred.refreshToken) throw new Error('Google Drive needs to be reconnected (no refresh token)');
  try {
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: cred.refreshToken, grant_type: 'refresh_token',
    }, { timeout: 20000 });
    const tokenExpiry = new Date(Date.now() + (data.expires_in || 3600) * 1000);
    await prisma.driveCredential.update({ where: { id: cred.id }, data: { accessToken: data.access_token, tokenExpiry } });
    return data.access_token;
  } catch (err) {
    const reason = [400, 401].includes(err.response?.status) ? `Google Drive access expired or was revoked (${err.response.data?.error || err.response.status}): reconnect it on the Connections page` : `Drive token refresh failed: ${err.message}`;
    await prisma.driveCredential.update({ where: { id: cred.id }, data: { lastError: reason } });
    throw new Error(reason);
  }
}

const isScreenshot = (f) => /screen ?shot|screen_?cap|scrn/i.test(f.name)
  || (f.mimeType === 'image/png' && f.imageMediaMetadata?.width && Math.max(f.imageMediaMetadata.width, f.imageMediaMetadata.height) / Math.min(f.imageMediaMetadata.width, f.imageMediaMetadata.height) > 1.9);

function prefilter(f) {
  if (Number(f.size) > vault.MAX_BYTES) return 'too large';
  const m = f.imageMediaMetadata;
  if (m?.width && Math.min(m.width, m.height) < MIN_EDGE) return 'too small';
  if (isScreenshot(f)) return 'screenshot';
  return null;
}

async function importDriveImages(userId, { limit = PER_RUN } = {}) {
  const cred = await prisma.driveCredential.findUnique({ where: { userId } });
  if (!cred) return { skipped: true, summary: 'Google Drive not connected' };
  // originals whose enhanced copy never got saved (an interrupted run) are dead weight: drop them
  const orphans = await prisma.$executeRaw`DELETE FROM "ContentAsset" o WHERE o."userId" = ${userId} AND o.kind = 'original' AND o.source = 'drive'
    AND NOT EXISTS (SELECT 1 FROM "ContentAsset" p WHERE p."originalId" = o.id)`;
  if (orphans) console.log(`[driveImport] removed ${orphans} original(s) left by an interrupted run`);
  const token = await accessToken(cred);
  const http = axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}` }, timeout: 60000 });
  const folderNames = new Map();
  const folderName = async (id) => {
    if (!id) return '';
    if (!folderNames.has(id)) folderNames.set(id, await http.get(`/files/${id}`, { params: { fields: 'name', supportsAllDrives: true } }).then((r) => r.data.name).catch(() => ''));
    return folderNames.get(id);
  };

  const stats = { imported: 0, seen: 0, known: 0, skipped: {}, failed: [] };
  const skip = (why) => { stats.skipped[why] = (stats.skipped[why] || 0) + 1; };
  const baseQ = `trashed = false and (${IMAGE_MIMES.map((m) => `mimeType = '${m}'`).join(' or ')})`;

  async function processPage(files) {
    const known = new Set((await prisma.contentAsset.findMany({ where: { userId, driveFileId: { in: files.map((f) => f.id) } }, select: { driveFileId: true } })).map((r) => r.driveFileId));
    for (const f of files) {
      if (stats.imported >= limit) return false;                     // page not finished
      stats.seen++;
      if (known.has(f.id)) { stats.known++; continue; }
      const why = prefilter(f);
      if (why) { skip(why); continue; }
      try {
        if (await importOne(f)) { stats.imported++; await new Promise((r) => setTimeout(r, PAUSE_MS)); }
      } catch (err) {
        stats.failed.push(`${f.name}: ${err.message}`);
        if (/database|prisma|ECONNREFUSED|connection/i.test(err.message)) throw err;   // the DB is struggling: stop, don't pile on
      }
    }
    return true;
  }

  async function importOne(f) {
    const { data } = await http.get(`/files/${f.id}`, { params: { alt: 'media', supportsAllDrives: true }, responseType: 'arraybuffer', maxContentLength: vault.MAX_BYTES + 1 });
    const folder = await folderName(f.parents?.[0]);
    const taken = f.imageMediaMetadata?.time || f.createdTime?.slice(0, 10) || '';
    const notes = `Google Drive: ${folder ? folder + '/' : ''}${f.name}${taken ? ` · taken ${taken}` : ''}`.slice(0, 500);

    // everything heavy happens in memory first, so a dud never costs a big database write
    let raw = Buffer.from(data);
    if (vault.sniff(raw) === 'image/heic') raw = await vault.heicToJpeg(raw);
    const bytes = await prepareOriginal(raw);
    raw = null;
    const a = await assess(bytes);
    const dud = Math.min(a.width, a.height) < MIN_EDGE ? 'too small' : a.meanLuma < 12 ? 'black frame' : a.meanLuma > 248 ? 'blown out' : null;
    if (dud) {
      // tiny marker row so the next run doesn't download it again
      await prisma.contentAsset.create({ data: { userId, kind: 'skipped', name: f.name.slice(0, 120), mime: 'image/jpeg', bytes: Buffer.alloc(0), size: 0, sha256: `skip:${f.id}`, source: 'drive', driveFileId: f.id } }).catch(() => {});
      skip(dud);
      return false;
    }

    const orig = await vault.saveAsset(userId, { kind: 'original', name: f.name.replace(/\.\w+$/, '') + '.jpg', buffer: bytes, source: 'drive', notes });
    if (orig.duplicate) {
      const enhanced = orig.asset.kind === 'original' && await prisma.contentAsset.findFirst({ where: { userId, originalId: orig.asset.id }, select: { id: true } });
      if (orig.asset.kind !== 'original' || enhanced) {
        // the same photo twice in Drive: tag the Drive id so it isn't downloaded again
        await prisma.contentAsset.updateMany({ where: { id: enhanced ? enhanced.id : orig.asset.id, driveFileId: null }, data: { driveFileId: f.id } }).catch(() => {});
        skip('already in vault');
        return false;
      }
      // an earlier run stored the original but died before the enhanced copy: finish it now
    }

    const out = await enhance(bytes);
    await vault.saveAsset(userId, {
      kind: 'photo', name: f.name.replace(/\.\w+$/, '') + '.jpg', buffer: out.buffer, source: 'drive', notes,
      tags: vault.autoTags(folder), driveFileId: f.id, originalId: orig.asset.id,
      edits: { ...out.edits, sharpness: Math.round(a.sharpness * 100) / 100 },
    });
    console.log(`[driveImport] imported ${f.name} (${Math.round(bytes.length / 1024)} KB original, ${Math.round(out.buffer.length / 1024)} KB enhanced)`);
    return true;
  }

  // 1) anything new since the last sync (a day of overlap; known ids are skipped cheaply)
  const since = cred.lastSyncAt ? new Date(cred.lastSyncAt.getTime() - 86400000).toISOString() : null;
  if (since) {
    let pageToken;
    do {
      const { data } = await http.get('/files', { params: { q: `${baseQ} and createdTime > '${since}'`, orderBy: 'createdTime desc', pageSize: 100, fields: FIELDS, pageToken, includeItemsFromAllDrives: true, supportsAllDrives: true } });
      if (!(await processPage(data.files || []))) break;
      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  // 2) walk the older backlog one page at a time, newest to oldest
  let backfillPageToken = cred.backfillPageToken, backfillDone = cred.backfillDone;
  while (!backfillDone && stats.imported < limit) {
    let data;
    try {
      ({ data } = await http.get('/files', { params: { q: baseQ, orderBy: 'createdTime desc', pageSize: 100, fields: FIELDS, pageToken: backfillPageToken || undefined, includeItemsFromAllDrives: true, supportsAllDrives: true } }));
    } catch (err) {
      if (backfillPageToken && err.response?.status === 400) { backfillPageToken = null; continue; }   // stale cursor: restart, known ids are skipped
      throw err;
    }
    if (!(await processPage(data.files || []))) break;                 // cap hit mid-page: resume this page next run
    backfillPageToken = data.nextPageToken || null;
    if (!backfillPageToken) backfillDone = true;
  }

  await prisma.driveCredential.update({
    where: { id: cred.id },
    data: { lastSyncAt: new Date(), backfillPageToken, backfillDone, importedCount: { increment: stats.imported }, lastError: stats.failed.length ? stats.failed.slice(0, 3).join('; ').slice(0, 500) : null },
  });
  return stats;
}

async function driveImportTick(ctx) {
  let s;
  try {
    s = await importDriveImages(ctx.userId);
  } catch (err) {
    if (err.response?.status !== 401) throw err;
    // access token revoked or expired early: force a refresh next run and tell the owner what to do
    const msg = 'Google Drive rejected the saved access. It retries tonight; if this repeats, reconnect Drive on the Connections page.';
    await prisma.driveCredential.updateMany({ where: { userId: ctx.userId }, data: { tokenExpiry: null, lastError: msg } });
    throw new Error(msg);
  }
  if (s.skipped) return s;
  const skipped = Object.entries(s.skipped).map(([k, v]) => `${v} ${k}`).join(', ');
  if (s.failed.length) console.warn('[driveImport] failures:', s.failed.slice(0, 5));
  return {
    items_found: s.imported,
    requires_attention: s.failed.length,
    actions_taken: s.imported ? [`Imported and enhanced ${s.imported} Drive photo(s) for curation`] : [],
    summary: `${s.imported} imported, ${s.known} already had${skipped ? `, skipped ${skipped}` : ''}${s.failed.length ? `, ${s.failed.length} failed` : ''}`,
  };
}

module.exports = { importDriveImages, driveImportTick, prefilter };
