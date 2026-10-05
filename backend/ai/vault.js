/**
 * Content Vault — the owner's real photos plus every rendered graphic, stored once (sha256 dedupe) and
 * auto-tagged so agents reuse real business material instead of generating generic imagery.
 */
const crypto = require('crypto');
const prisma = require('../lib/prismaClient');

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 12 * 1024 * 1024;   // clips live in Postgres and travel as base64 JSON; keep them small
const MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime']);

// filename/notes keyword → vault tag (the "PATIOS / SOD / FALL / BEFORE ..." scheme from the brief)
const TAG_RULES = [
  [/patio|paver|interlock|walkway|retaining/i, 'PATIOS'], [/\bsod\b|turf|new lawn/i, 'SOD'], [/lawn|mow|cut|grass|stripe/i, 'LAWNS'],
  [/fall|autumn|leaf|leaves|cleanup/i, 'FALL'], [/spring/i, 'SPRING'], [/snow|plow|winter|ice/i, 'SNOW'],
  [/commercial|plaza|property manage|shindico/i, 'COMMERCIAL'], [/crew|team|staff|steph|ben\b/i, 'CREW'], [/truck|mower|equipment|trailer|skid/i, 'EQUIPMENT'],
  [/before/i, 'BEFORE'], [/after/i, 'AFTER'], [/landscap|bed|mulch|rock|plant/i, 'LANDSCAPING'], [/drain|grading|grade|swale/i, 'DRAINAGE'],
  [/fence|deck/i, 'FENCES_DECKS'], [/junk/i, 'JUNK'],
];

function autoTags(...texts) {
  const hay = texts.filter(Boolean).join(' ');
  return TAG_RULES.filter(([re]) => re.test(hay)).map(([, t]) => t);
}

// width/height from the file header (no image library needed)
function dimensions(buf, mime) {
  try {
    if (mime === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (mime === 'image/webp' && buf.toString('ascii', 8, 12) === 'WEBP') {
      if (buf.toString('ascii', 12, 16) === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
  } catch { /* unknown dimensions are fine */ }
  return {};
}

// iPhone photos. The ftyp brand tells them apart from MP4/MOV clips, which share the same box.
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

const sniff = (b) => (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
  : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
  : b.toString('ascii', 4, 8) === 'ftyp' ? (HEIC_BRANDS.has(b.toString('ascii', 8, 12)) ? 'image/heic' : b.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4') : null);

// Facebook and Instagram don't take HEIC, so every HEIC/HEIF is stored as a JPEG (rotation applied).
async function heicToJpeg(buffer) {
  try {
    return Buffer.from(await require('heic-convert')({ buffer, format: 'JPEG', quality: 0.9 }));
  } catch {
    throw Object.assign(new Error('could not read that HEIC photo. Export it as JPEG and try again'), { code: 'INVALID_ASSET' });
  }
}

async function saveAsset(userId, { kind = 'photo', name, buffer, tags = [], source = 'upload', notes = null, contentItemId = null, driveFileId = null, originalId = null, edits = null }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw Object.assign(new Error('empty file'), { code: 'INVALID_ASSET' });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error(`file too large (max ${MAX_BYTES / 1048576} MB)`), { code: 'INVALID_ASSET' });
  let mime = sniff(buffer);                         // trust the bytes, not the client's claim
  if (mime === 'image/heic') {
    buffer = await heicToJpeg(buffer);
    mime = 'image/jpeg';
    name = String(name || 'upload').replace(/\.(heic|heif)$/i, '') + '.jpg';
  }
  if (!mime || !MIMES.has(mime)) throw Object.assign(new Error('only PNG, JPEG or WebP images, or MP4/MOV clips, are accepted'), { code: 'INVALID_ASSET' });
  if (mime.startsWith('video/')) {
    if (buffer.length > MAX_VIDEO_BYTES) throw Object.assign(new Error(`video too large (max ${MAX_VIDEO_BYTES / 1048576} MB)`), { code: 'INVALID_ASSET' });
    kind = 'video';
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = await prisma.contentAsset.findUnique({ where: { userId_sha256: { userId, sha256 } }, select: assetSelect });
  if (existing) return { asset: existing, duplicate: true };

  const clean = String(name || 'upload').replace(/[^\w.\- ]+/g, '').slice(0, 120) || 'upload';
  const allTags = [...new Set([...(tags || []).map((t) => String(t).toUpperCase().slice(0, 30)), ...autoTags(clean, notes)])].slice(0, 20);
  const asset = await prisma.contentAsset.create({
    data: { userId, kind, name: clean, mime, bytes: buffer, size: buffer.length, sha256, ...dimensions(buffer, mime), tags: JSON.stringify(allTags), source, notes, contentItemId, driveFileId, originalId, edits: edits ? JSON.stringify(edits) : null },
    select: assetSelect,
  });
  return { asset, duplicate: false };
}

const assetSelect = { quality: true, private: true, pairKey: true, driveFileId: true, originalId: true, edits: true, id: true, userId: true, kind: true, name: true, mime: true, size: true, width: true, height: true, tags: true, source: true, notes: true, contentItemId: true, createdAt: true };

async function listAssets(userId, { kind, tag, q, limit = 60, minQuality, usable, uncurated, pair, source } = {}) {
  const where = { userId, kind: { notIn: ['original', 'skipped'] } };   // originals behind enhanced copies + Drive rejects stay hidden
  if (minQuality) where.quality = { gte: Number(minQuality) };
  if (usable) { where.private = false; where.quality = { gte: 3 }; }     // what the renderer is allowed to use
  if (uncurated) where.quality = null;                                  // photos the curator hasn't scored yet
  if (pair) where.pairKey = String(pair);
  if (kind) where.kind = kind;
  if (source) where.source = String(source);
  if (tag) where.tags = { contains: `"${String(tag).toUpperCase()}"` };
  if (q) where.name = { contains: q, mode: 'insensitive' };
  const rows = await prisma.contentAsset.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 200), select: assetSelect });
  return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') }));
}

async function getAssetBytes(userId, id) {
  return prisma.contentAsset.findFirst({ where: { id, userId, kind: { not: 'skipped' } }, select: { id: true, mime: true, bytes: true, name: true, private: true } });
}

/** { photo: "vault:<id>" } → { photo: "data:image/...;base64,..." } for the renderer. */
async function resolvePhotos(userId, refs = {}) {
  const out = {};
  for (const [slot, ref] of Object.entries(refs)) {
    if (typeof ref !== 'string') continue;
    const m = ref.match(/^vault:([\w-]+)$/);
    if (!m) throw Object.assign(new Error(`photo "${slot}" must be "vault:<assetId>" (remote URLs are not fetched)`), { code: 'INVALID_PHOTO' });
    const a = await getAssetBytes(userId, m[1]);
    if (a && a.private) throw Object.assign(new Error(`vault asset ${m[1]} is marked private (faces, plates or house numbers): pick another photo`), { code: 'INVALID_PHOTO' });
    if (!a) throw Object.assign(new Error(`vault asset ${m[1]} not found`), { code: 'INVALID_PHOTO' });
    out[slot] = `data:${a.mime};base64,${Buffer.from(a.bytes).toString('base64')}`;
  }
  return out;
}

/** Re-enhance an imported photo from its original (edits never stack); revert restores the original untouched. */
async function editAsset(userId, id, edits = {}) {
  const asset = await prisma.contentAsset.findFirst({ where: { id, userId }, select: { id: true, originalId: true } });
  if (!asset) return null;
  if (!asset.originalId) throw Object.assign(new Error('this photo has no stored original to edit from'), { code: 'INVALID_ASSET' });
  const original = await prisma.contentAsset.findFirst({ where: { id: asset.originalId, userId }, select: { bytes: true, mime: true } });
  if (!original) throw Object.assign(new Error('the original for this photo is missing'), { code: 'INVALID_ASSET' });
  let bytes = Buffer.from(original.bytes), mime = original.mime, applied = { reverted: true }, dims;
  if (!edits.revert) {
    const out = await require('./enhance').enhance(bytes, edits);
    ({ buffer: bytes, edits: applied } = out); mime = 'image/jpeg'; dims = { width: out.width, height: out.height };
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  // a revert carries the original's exact bytes, whose row already owns that sha256: suffix it to keep the unique index
  const clash = await prisma.contentAsset.findFirst({ where: { userId, sha256, id: { not: id } }, select: { id: true } });
  return prisma.contentAsset.update({
    where: { id },
    data: { bytes, mime, size: bytes.length, sha256: clash ? `${sha256}:${id}` : sha256, ...(dims || dimensions(bytes, mime)), edits: JSON.stringify(applied) },
    select: assetSelect,
  });
}

async function updateAsset(userId, id, { tags, notes, name, quality, private: priv, pairKey }) {
  const data = {};
  if (Number.isInteger(quality) && quality >= 1 && quality <= 5) data.quality = quality;
  if (typeof priv === 'boolean') data.private = priv;
  if (typeof pairKey === 'string') data.pairKey = pairKey.slice(0, 80) || null;
  if (Array.isArray(tags)) data.tags = JSON.stringify([...new Set(tags.map((t) => String(t).toUpperCase().slice(0, 30)))].slice(0, 20));
  if (typeof notes === 'string') data.notes = notes.slice(0, 500);
  if (typeof name === 'string' && name.trim()) data.name = name.trim().slice(0, 120);
  const r = await prisma.contentAsset.updateMany({ where: { id, userId }, data });
  return r.count > 0;
}

module.exports = { sniff, heicToJpeg, saveAsset, listAssets, getAssetBytes, resolvePhotos, updateAsset, editAsset, dimensions, autoTags, MAX_BYTES };
