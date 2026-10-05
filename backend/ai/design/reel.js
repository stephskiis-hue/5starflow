/**
 * Reels from rendered graphics: each 1080x1920 frame becomes a few seconds of a slow push-in, joined into one
 * H.264 MP4 with a silent audio track (Facebook and Instagram Reels both need a real video file).
 * Needs ffmpeg (installed in backend/Dockerfile; FFMPEG_PATH overrides).
 */
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const FPS = 30;
const W = 1080;
const H = 1920;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(process.env.FFMPEG_PATH || 'ffmpeg', args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
      if (!err) return resolve();
      const msg = err.code === 'ENOENT' ? 'ffmpeg is not installed (deploy with backend/Dockerfile or set FFMPEG_PATH)' : String(stderr || err.message).trim().split('\n').slice(-3).join(' ');
      reject(Object.assign(new Error(`reel video failed: ${msg}`), { code: 'REEL_UNAVAILABLE' }));
    });
  });
}

/** @param {Buffer[]} frames PNGs at 1080x1920 @returns {Promise<Buffer>} MP4 */
async function makeReel(frames, { seconds } = {}) {
  if (!frames.length) throw Object.assign(new Error('no frames for the reel'), { code: 'REEL_UNAVAILABLE' });
  const per = seconds || (frames.length === 1 ? 7 : 4);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-'));
  try {
    const args = ['-y', '-loglevel', 'error'];
    for (let i = 0; i < frames.length; i++) {
      const f = path.join(dir, `f${i}.png`);
      await fs.writeFile(f, frames[i]);
      args.push('-i', f);
    }
    const total = per * frames.length;
    args.push('-f', 'lavfi', '-t', String(total), '-i', 'anullsrc=r=44100:cl=stereo');
    const d = per * FPS;
    // upscale first so the slow zoom moves smoothly instead of stepping a pixel at a time
    const chains = frames.map((_, i) => `[${i}:v]scale=${W * 2}:${H * 2},zoompan=z='min(zoom+0.0004,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${d}:s=${W}x${H}:fps=${FPS},setsar=1[v${i}]`);
    const filter = `${chains.join(';')};${frames.map((_, i) => `[v${i}]`).join('')}concat=n=${frames.length}:v=1:a=0[v]`;
    const out = path.join(dir, 'reel.mp4');
    args.push('-filter_complex', filter, '-map', '[v]', '-map', `${frames.length}:a`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart', out);
    await run(args);
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { makeReel };
