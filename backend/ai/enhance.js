/**
 * Photo enhancement for the vault. Always works from the untouched original so edits never stack.
 * Output is a ≤2048px JPEG with every bit of metadata (GPS, device) stripped.
 */
const sharp = require('sharp');

const MAX_EDGE = 2048;
// decode to raw pixels so every later step sees the real (post-rotation) dimensions, with no lossy re-encode
async function raw(pipeline) {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { img: sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }), w: info.width, h: info.height };
}

const clamp = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Number(n))) : d);

/** { width, height, sharpness, meanLuma, contrast } — cheap signals for skipping duds and choosing the tone pass. */
async function assess(buffer) {
  const img = sharp(buffer, { failOn: 'none' }).rotate();
  const { width, height } = await img.clone().metadata().then((m) => ((m.orientation || 1) >= 5 ? { width: m.height, height: m.width } : m));
  const stats = await img.clone().resize(512, 512, { fit: 'inside' }).greyscale().stats();
  return { width, height, sharpness: stats.sharpness, meanLuma: stats.channels[0].mean, contrast: stats.channels[0].stdev };
}

async function needsTone(img) {
  const g = (await img.clone().resize(256, 256, { fit: 'inside' }).greyscale().stats()).channels[0];
  return g.stdev < 45 || g.mean < 80 || g.mean > 185;
}

/**
 * edits: { straighten: degrees (-15..15), rotate: 0|90|180|270, crop: {x,y,w,h} as 0..1 fractions,
 *          brightness: 0.7..1.4, saturation: 0.7..1.5, tone: true|false to force auto levels on or off }
 */
async function enhance(buffer, edits = {}) {
  const applied = {};
  let { img, w, h } = await raw(sharp(buffer, { failOn: 'none' }).rotate());   // EXIF orientation first

  const quarter = [90, 180, 270].includes(Number(edits.rotate)) ? Number(edits.rotate) : 0;
  if (quarter) { ({ img, w, h } = await raw(img.rotate(quarter))); applied.rotate = quarter; }

  const tilt = clamp(edits.straighten, -15, 15, 0);
  if (tilt) {
    // rotate, then keep the largest centred rectangle of the same shape with no empty corners
    const rad = Math.abs(tilt) * Math.PI / 180;
    const scale = 1 / (Math.cos(rad) + Math.sin(rad) * Math.max(w / h, h / w));
    const cw = Math.floor(w * scale), ch = Math.floor(h * scale);
    const r = await raw(img.rotate(tilt, { background: '#000' }));
    ({ img, w, h } = await raw(r.img.extract({ left: Math.floor((r.w - cw) / 2), top: Math.floor((r.h - ch) / 2), width: cw, height: ch })));
    applied.straighten = tilt;
  }

  if (edits.crop && typeof edits.crop === 'object') {
    const x = clamp(edits.crop.x, 0, 0.95, 0), y = clamp(edits.crop.y, 0, 0.95, 0);
    const cw = clamp(edits.crop.w, 0.05, 1 - x, 1 - x), ch = clamp(edits.crop.h, 0.05, 1 - y, 1 - y);
    const left = Math.round(x * w), top = Math.round(y * h);
    ({ img, w, h } = await raw(img.extract({ left, top, width: Math.max(1, Math.min(w - left, Math.round(cw * w))), height: Math.max(1, Math.min(h - top, Math.round(ch * h))) })));
    applied.crop = { x, y, w: cw, h: ch };
  }

  // auto levels only for dull, dark or washed-out shots; a well exposed photo keeps its own look
  if (edits.tone === true || (edits.tone !== false && await needsTone(img))) { img = img.normalise({ lower: 1, upper: 99 }); applied.tone = true; }
  const brightness = clamp(edits.brightness, 0.7, 1.4, 1), saturation = clamp(edits.saturation, 0.7, 1.5, 1.06);
  img = img.modulate({ brightness, saturation });
  applied.brightness = brightness; applied.saturation = saturation;
  img = img.sharpen({ sigma: 0.8, m1: 0.5, m2: 2 });

  const { data, info } = await img
    .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, edits: applied };
}

module.exports = { assess, enhance, MAX_EDGE };
