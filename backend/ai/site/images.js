/**
 * The hero image of a post: a vault photo the writer picked (real jobs beat stock), else a Pexels search when a
 * PEXELS_API_KEY is set. Output is always a 1200x675 webp. No guessing: with neither source the caller gets null and
 * asks the writer for one.
 */
const axios = require('axios');
const sharp = require('sharp');
const vault = require('../vault');

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function fromPexels(query) {
  const key = process.env.PEXELS_API_KEY;
  if (!key || !query) return null;
  const r = await axios.get('https://api.pexels.com/v1/search', { params: { query, per_page: 15, orientation: 'landscape' }, headers: { Authorization: key }, timeout: 20000 });
  const photo = (r.data.photos || []).find((p) => p.width > p.height);
  const url = photo && (photo.src.large2x || photo.src.large);
  if (!url) return null;
  const img = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return { bytes: Buffer.from(img.data), source: `pexels:${photo.id}` };
}

/** { buffer, source } or null. assetId: a non-private vault asset; query: a Pexels search. */
async function makeHero(userId, { assetId, query } = {}) {
  let raw = null;
  if (assetId) {
    const a = await vault.getAssetBytes(userId, String(assetId));
    if (!a) throw httpError(422, `vault asset ${assetId} not found`);
    if (a.private) throw httpError(422, `vault asset ${assetId} is marked private (faces, plates or house numbers): pick another photo`);
    raw = { bytes: Buffer.from(a.bytes), source: `vault:${assetId}` };
  } else raw = await fromPexels(query).catch((e) => { throw httpError(502, `Pexels failed: ${e.response?.status || e.message}`); });
  if (!raw) return null;
  const buffer = await sharp(raw.bytes).rotate().resize(1200, 675, { fit: 'cover', position: 'attention' }).webp({ quality: 82 }).toBuffer();
  return { buffer, source: raw.source };
}

module.exports = { makeHero };
