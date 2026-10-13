// TextNow message parsing shared by the MSI watcher (scripts/textnow-watch.js), the one-off export and the server.
// TextNow's web API field names have changed over the years: accept every variant we know of.
const digits = (v) => String(v || '').replace(/\D/g, '');
const last10 = (v) => digits(v).slice(-10);

function e164(v) {
  const d = digits(v);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d.length > 11 ? `+${d}` : null;   // short codes / system senders → null (skipped)
}

// → { id, contact, name, direction: 'in'|'out'|<raw>, body, at, media } or null when it is not a message
function normalizeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const contact = m.contact_value ?? m.contactValue ?? m.e164_contact_value ?? m.contact?.value;
  const id = m.id ?? m.message_id ?? m.messageId;
  if (!contact || id == null) return null;
  const dir = m.message_direction ?? m.direction ?? m.messageDirection;
  const media = !!(m.attachment_url || m.media_url || m.mediaUrl || (Array.isArray(m.attachments) && m.attachments.length));
  return {
    id: String(id),
    contact: String(contact),
    name: m.contact_name ?? m.contactName ?? m.contact?.name ?? '',
    direction: dir === 1 || dir === 'incoming' || dir === 'in' ? 'in' : dir === 2 || dir === 'outgoing' || dir === 'out' ? 'out' : String(dir ?? ''),
    body: m.message ?? m.body ?? m.text ?? '',
    at: m.date ?? m.timestamp ?? m.created_at ?? m.createdAt ?? null,
    media,
  };
}

// Walk any JSON TextNow loads and keep every message-shaped object.
function harvest(node, into, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) { for (const x of node) harvest(x, into, depth + 1); return; }
  const m = normalizeMessage(node);
  if (m) into.set(m.id, m);
  for (const v of Object.values(node)) if (v && typeof v === 'object') harvest(v, into, depth + 1);
}

// TextNow dates arrive as ISO strings or epoch seconds/milliseconds → ISO string, or null
function toIso(v) {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---- probe helpers: describe what TextNow's web app does WITHOUT keeping any personal data -------------------------
// URL → { host, path, query } with ids, numbers and the account name masked and query VALUES dropped.
function maskPath(u) {
  let url;
  try { url = new URL(u, 'https://placeholder.invalid'); } catch { return { host: '', path: String(u).slice(0, 120), query: [] }; }
  const segs = url.pathname.split('/').map((seg, i, all) => {
    if (!seg) return seg;
    let s = seg; try { s = decodeURIComponent(seg); } catch { /* keep raw */ }
    if (all[i - 1] === 'users') return ':user';
    if (s.includes('@') || /^\+?\d[\d().\s-]*$/.test(s)) return ':n';
    if (/^[0-9a-f]{8,}(-[0-9a-f]{4,})*$/i.test(s) || /^[A-Za-z0-9_-]{20,}$/.test(s)) return ':id';
    return s;
  });
  return { host: url.hostname === 'placeholder.invalid' ? '' : url.hostname, path: segs.join('/'), query: [...url.searchParams.keys()].sort() };
}

// JSON value → its shape only: key names, array lengths, primitive TYPES. Never a value.
function shapeOf(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth < 6 && v.length ? { _array: v.length, item: shapeOf(v[0], depth + 1) } : { _array: v.length };
  if (typeof v === 'object') {
    if (depth >= 6) return 'object';
    const keys = Object.keys(v);
    const out = {};
    for (const k of keys.slice(0, 40)) out[/^[+\d][\d\s().+-]*$/.test(k) || k.length > 40 ? ':key' : k] = shapeOf(v[k], depth + 1);
    if (keys.length > 40) out._keys = keys.length;
    return out;
  }
  return typeof v;
}

const CHALLENGE_RE = /captcha|verify (that )?you are (a )?human|unusual (activity|traffic)|just a moment|checking your browser|access denied|cloudflare/i;

// ---- finding a real Chrome to launch as a plain OS process (no Playwright launch flags) ---------------------------
// Order: CHROME_BIN override, Chrome (Windows, then mac/linux), then Edge. Pure so it can be tested.
function chromeCandidates(env = process.env, platform = process.platform) {
  const list = [env.CHROME_BIN];
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    list.push(`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`);
  } else if (platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return list.filter(Boolean);
}
const pickExisting = (candidates, exists) => candidates.find((c) => { try { return exists(c); } catch { return false; } }) || null;

// A tab list entry (from Chrome's /json/list) that is the signed-in TextNow inbox, not a login / signup / challenge page.
const isSignedInTab = (url) => /textnow\.com\/messaging/i.test(String(url || '')) && !/\/(login|signup|sign-in)/i.test(String(url || ''));

module.exports = { digits, last10, e164, normalizeMessage, harvest, toIso, maskPath, shapeOf, CHALLENGE_RE, chromeCandidates, pickExisting, isSignedInTab };
