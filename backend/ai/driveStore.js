/**
 * Photos that live on Google Drive. The vault keeps only a metadata row (driveFileId, tags, quality,
 * the enhancement edits); the pixels are fetched from Drive when something asks for them (the renderer,
 * the dashboard, an agent downloading a photo to post). Keeps Postgres small: the 500 MB database volume
 * filled up on 2026-10-05 when the importer stored two copies of every photo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const prisma = require('../lib/prismaClient');
const { enhance, prepareOriginal } = require('./enhance');

const API = 'https://www.googleapis.com/drive/v3';
const CACHE_DIR = path.join(os.tmpdir(), '5starflow-drive-cache');
const CACHE_MAX_BYTES = (Number(process.env.DRIVE_CACHE_MB) || 100) * 1024 * 1024;
const MAX_DOWNLOAD = 25 * 1024 * 1024;
const THUMB_EDGE = 400;
const CONCURRENCY = 3;

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
    cred.accessToken = data.access_token; cred.tokenExpiry = tokenExpiry;
    return data.access_token;
  } catch (err) {
    const reason = [400, 401].includes(err.response?.status) ? `Google Drive access expired or was revoked (${err.response.data?.error || err.response.status}): reconnect it on the Connections page` : `Drive token refresh failed: ${err.message}`;
    await prisma.driveCredential.update({ where: { id: cred.id }, data: { lastError: reason } });
    throw new Error(reason);
  }
}

async function driveHttp(userId) {
  const cred = await prisma.driveCredential.findUnique({ where: { userId } });
  if (!cred) throw Object.assign(new Error('Google Drive is not connected'), { code: 'NO_DRIVE' });
  const token = await accessToken(cred);
  return axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}` }, timeout: 60000 });
}

// a few Drive downloads at a time: a gallery page asks for dozens at once
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= CONCURRENCY) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

const cacheKey = (driveFileId, edits, w) => crypto.createHash('sha1').update(`${driveFileId}|${JSON.stringify(edits || {})}|${w || 0}`).digest('hex');
const cacheFile = (key) => path.join(CACHE_DIR, `${key}.jpg`);

function readCache(key) {
  try {
    const file = cacheFile(key);
    const buf = fs.readFileSync(file);
    fs.utimesSync(file, new Date(), new Date());   // LRU: a read counts as use
    return buf;
  } catch { return null; }
}

function writeCache(key, buf) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(key), buf);
    const files = fs.readdirSync(CACHE_DIR).map((n) => { const s = fs.statSync(path.join(CACHE_DIR, n)); return { n, size: s.size, t: s.mtimeMs }; });
    let total = files.reduce((a, f) => a + f.size, 0);
    for (const f of files.sort((a, b) => a.t - b.t)) {
      if (total <= CACHE_MAX_BYTES) break;
      try { fs.unlinkSync(path.join(CACHE_DIR, f.n)); total -= f.size; } catch { /* already gone */ }
    }
  } catch { /* a full or read-only temp dir only costs a re-download */ }
}

/** Download the Drive file (untouched camera file, ≤25 MB). HEIC is converted exactly as the importer does. */
async function downloadOriginal(userId, driveFileId) {
  const http = await driveHttp(userId);
  const { data } = await http.get(`/files/${driveFileId}`, { params: { alt: 'media', supportsAllDrives: true }, responseType: 'arraybuffer', maxContentLength: MAX_DOWNLOAD });
  let raw = Buffer.from(data);
  const vault = require('./vault');
  if (vault.sniff(raw) === 'image/heic') raw = await vault.heicToJpeg(raw);
  return prepareOriginal(raw);
}

/**
 * The photo as the vault used to store it: the Drive original with the recorded enhancement re-applied.
 * { width: 400 } returns a small JPEG for gallery grids.
 */
async function fetchDrivePhoto(userId, driveFileId, edits, { width } = {}) {
  const key = cacheKey(driveFileId, edits, width);
  const hit = readCache(key);
  if (hit) return hit;
  const out = await limited(async () => {
    const again = readCache(key);                   // a concurrent request may have filled it while we waited
    if (again) return again;
    const shrink = (b) => require('sharp')(b).resize(width, width, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
    const full = width && readCache(cacheKey(driveFileId, edits, 0));          // a thumbnail can come from the cached full photo
    let buf;
    if (full) buf = await shrink(full);
    else {
      buf = (await enhance(await downloadOriginal(userId, driveFileId), edits || {})).buffer;
      if (width) { writeCache(cacheKey(driveFileId, edits, 0), buf); buf = await shrink(buf); }
    }
    writeCache(key, buf);
    return buf;
  });
  return out;
}

/** Does the file still exist and is it not in the trash? Used before any stored bytes are dropped. */
async function driveFileExists(http, driveFileId) {
  try {
    const { data } = await http.get(`/files/${driveFileId}`, { params: { fields: 'id,trashed', supportsAllDrives: true } });
    return !data.trashed;
  } catch { return false; }
}

/**
 * One-time move of already-imported Drive photos out of Postgres. For every Drive-sourced enhanced photo that
 * still carries bytes: confirm the file is still on Drive, then empty its bytes and drop the stored original.
 * Photos whose Drive file is gone or unreachable keep their bytes. Uploads, rendered graphics and logos are
 * never touched. dryRun (the default) only reports. A real run ends with VACUUM FULL so the disk space is
 * actually returned (DELETE/UPDATE alone leave the table file the same size).
 */
async function offloadDriveBytes(userId, { dryRun = true } = {}) {
  const photos = await prisma.$queryRaw`SELECT id, "driveFileId", octet_length(bytes)::int AS n FROM "ContentAsset"
    WHERE "userId" = ${userId} AND source = 'drive' AND kind = 'photo' AND "driveFileId" IS NOT NULL AND octet_length(bytes) > 0`;
  const origs = await prisma.$queryRaw`SELECT COALESCE(SUM(octet_length(bytes)), 0)::bigint AS n, COUNT(*)::int AS c FROM "ContentAsset"
    WHERE "userId" = ${userId} AND source = 'drive' AND kind = 'original'`;
  const report = { dryRun, photosWithBytes: photos.length, photoMb: Math.round(photos.reduce((a, r) => a + r.n, 0) / 1048576), originals: origs[0].c, originalMb: Math.round(Number(origs[0].n) / 1048576), offloaded: 0, keptMissingOnDrive: [] };
  if (dryRun || !photos.length && !origs[0].c) return report;

  const http = await driveHttp(userId);
  const queue = [...photos];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      if (!(await driveFileExists(http, r.driveFileId))) { report.keptMissingOnDrive.push(r.id); continue; }
      await prisma.$executeRaw`UPDATE "ContentAsset" SET bytes = ''::bytea, "originalId" = NULL WHERE id = ${r.id} AND "userId" = ${userId}`;
      report.offloaded++;
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  const del = await prisma.$executeRaw`DELETE FROM "ContentAsset" o WHERE o."userId" = ${userId} AND o.source = 'drive' AND o.kind = 'original'
    AND NOT EXISTS (SELECT 1 FROM "ContentAsset" p WHERE p."originalId" = o.id)`;
  report.originalsDeleted = del;
  await prisma.$executeRawUnsafe('VACUUM FULL "ContentAsset"');
  report.vacuumed = true;
  return report;
}

module.exports = { accessToken, driveHttp, fetchDrivePhoto, downloadOriginal, driveFileExists, offloadDriveBytes, THUMB_EDGE };
