/**
 * Content Vault — the owner's real photos plus every rendered graphic, stored once (sha256 dedupe) and
 * auto-tagged so agents reuse real business material instead of generating generic imagery.
 */
const crypto = require('crypto');
const prisma = require('../lib/prismaClient');

const MAX_BYTES = 15 * 1024 * 1024;
const MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

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

const sniff = (b) => (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
  : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null);

async function saveAsset(userId, { kind = 'photo', name, buffer, tags = [], source = 'upload', notes = null, contentItemId = null }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw Object.assign(new Error('empty file'), { code: 'INVALID_ASSET' });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error(`file too large (max ${MAX_BYTES / 1048576} MB)`), { code: 'INVALID_ASSET' });
  const mime = sniff(buffer);                       // trust the bytes, not the client's claim
  if (!mime || !MIMES.has(mime)) throw Object.assign(new Error('only PNG, JPEG or WebP images are accepted'), { code: 'INVALID_ASSET' });

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = await prisma.contentAsset.findUnique({ where: { userId_sha256: { userId, sha256 } }, select: assetSelect });
  if (existing) return { asset: existing, duplicate: true };

  const clean = String(name || 'upload').replace(/[^\w.\- ]+/g, '').slice(0, 120) || 'upload';
  const allTags = [...new Set([...(tags || []).map((t) => String(t).toUpperCase().slice(0, 30)), ...autoTags(clean, notes)])].slice(0, 20);
  const asset = await prisma.contentAsset.create({
    data: { userId, kind, name: clean, mime, bytes: buffer, size: buffer.length, sha256, ...dimensions(buffer, mime), tags: JSON.stringify(allTags), source, notes, contentItemId },
    select: assetSelect,
  });
  return { asset, duplicate: false };
}

const assetSelect = { id: true, userId: true, kind: true, name: true, mime: true, size: true, width: true, height: true, tags: true, source: true, notes: true, contentItemId: true, createdAt: true };

async function listAssets(userId, { kind, tag, q, limit = 60 } = {}) {
  const where = { userId };
  if (kind) where.kind = kind;
  if (tag) where.tags = { contains: `"${String(tag).toUpperCase()}"` };
  if (q) where.name = { contains: q, mode: 'insensitive' };
  const rows = await prisma.contentAsset.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 200), select: assetSelect });
  return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') }));
}

async function getAssetBytes(userId, id) {
  return prisma.contentAsset.findFirst({ where: { id, userId }, select: { id: true, mime: true, bytes: true, name: true } });
}

/** { photo: "vault:<id>" } → { photo: "data:image/...;base64,..." } for the renderer. */
async function resolvePhotos(userId, refs = {}) {
  const out = {};
  for (const [slot, ref] of Object.entries(refs)) {
    if (typeof ref !== 'string') continue;
    const m = ref.match(/^vault:([\w-]+)$/);
    if (!m) throw Object.assign(new Error(`photo "${slot}" must be "vault:<assetId>" (remote URLs are not fetched)`), { code: 'INVALID_PHOTO' });
    const a = await getAssetBytes(userId, m[1]);
    if (!a) throw Object.assign(new Error(`vault asset ${m[1]} not found`), { code: 'INVALID_PHOTO' });
    out[slot] = `data:${a.mime};base64,${Buffer.from(a.bytes).toString('base64')}`;
  }
  return out;
}

async function updateAsset(userId, id, { tags, notes, name }) {
  const data = {};
  if (Array.isArray(tags)) data.tags = JSON.stringify([...new Set(tags.map((t) => String(t).toUpperCase().slice(0, 30)))].slice(0, 20));
  if (typeof notes === 'string') data.notes = notes.slice(0, 500);
  if (typeof name === 'string' && name.trim()) data.name = name.trim().slice(0, 120);
  const r = await prisma.contentAsset.updateMany({ where: { id, userId }, data });
  return r.count > 0;
}

module.exports = { saveAsset, listAssets, getAssetBytes, resolvePhotos, updateAsset, autoTags, MAX_BYTES };
