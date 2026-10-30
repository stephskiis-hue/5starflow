/**
 * Reads Interac deposit emails from the owner's Gmail over the REST API (axios, like emailService; no googleapis).
 * Needs the gmail.readonly scope: an old send-only connection fails with code NEEDS_SCOPE until Gmail is reconnected.
 */
const axios = require('axios');
const { getGmailCreds, ensureFreshToken } = require('../../services/emailService');
const { SENDER } = require('./parse');

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const fail = (message, code) => Object.assign(new Error(message), { code });

async function gmailToken(userId) {
  const creds = await getGmailCreds(userId);
  if (!creds) throw fail('Gmail is not connected (Connections page)', 'NOT_CONNECTED');
  return ensureFreshToken(userId, creds);
}

async function get(token, path, params) {
  try {
    const r = await axios.get(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, params, timeout: 30000 });
    return r.data;
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message;
    if (status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) throw fail('The Gmail API is turned off in the Google Cloud project: Google Cloud console → APIs and services → Gmail API → Enable.', 'API_DISABLED');
    if (status === 403 || status === 401) throw fail(`Gmail refused the read (${status}): ${msg}. Reconnect Gmail on the Connections page and allow reading.`, 'NEEDS_SCOPE');
    throw fail(`Gmail ${status || 'ERR'}: ${msg}`, 'GMAIL');
  }
}

/** Message ids of incoming Interac notifications from the last `sinceDays` days, newest first. */
async function listInteracIds(userId, { sinceDays = 3, max = 500 } = {}) {
  const token = await gmailToken(userId);
  const ids = [];
  let pageToken;
  do {
    const d = await get(token, '/messages', { q: `from:${SENDER} newer_than:${sinceDays}d`, maxResults: 100, pageToken, includeSpamTrash: false });
    for (const m of d.messages || []) ids.push(m.id);
    pageToken = d.nextPageToken;
  } while (pageToken && ids.length < max);
  return { token, ids: ids.slice(0, max) };
}

const b64 = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function findPart(part, mime) {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return part.body.data;
  for (const p of part.parts || []) { const hit = findPart(p, mime); if (hit) return hit; }
  return null;
}

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n');
}

/** { id, subject, from, headers, body, receivedAt } for one message. */
async function getMessage(token, id) {
  const d = await get(token, `/messages/${encodeURIComponent(id)}`, { format: 'full' });
  const headers = d.payload?.headers || [];
  const h = (n) => headers.find((x) => x.name.toLowerCase() === n)?.value || '';
  const plain = findPart(d.payload, 'text/plain');
  const html = plain ? null : findPart(d.payload, 'text/html');
  return {
    id: d.id, subject: h('subject'), from: h('from'), headers,
    body: plain ? b64(plain) : html ? htmlToText(b64(html)) : '',
    receivedAt: new Date(Number(d.internalDate) || Date.now()),
  };
}

module.exports = { listInteracIds, getMessage, gmailToken, READ_SCOPE, htmlToText };
