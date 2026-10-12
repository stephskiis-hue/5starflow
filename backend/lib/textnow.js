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

module.exports = { digits, last10, e164, normalizeMessage, harvest, toIso };
