#!/usr/bin/env node
// Turns the TextNow scrape (~/textnow-export/rows-stage1.json, optional names-stage2.json) into a spreadsheet
// and, with --import, loads it into 5StarFlow as the "All TextNow Numbers" audience (POST /api/ai/audiences/import).
//   node scripts/textnow-build-list.js                 writes textnow-all-numbers.csv
//   node scripts/textnow-build-list.js --import        also imports (needs FIVESTARFLOW_URL + FIVESTARFLOW_TOKEN)
// Row format from the scrape: [number, name, lastDate, missedOrVoicemail(0|1), lastPreview]
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), 'textnow-export');
const rows = JSON.parse(fs.readFileSync(path.join(DIR, 'rows-stage1.json'), 'utf8'));
const namesFile = path.join(DIR, 'names-stage2.json');   // { "Cole - Greenco": "(204) 226-8395", ... }
const names = fs.existsSync(namesFile) ? JSON.parse(fs.readFileSync(namesFile, 'utf8')) : {};

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const TOLL_FREE = /^(800|833|844|855|866|877|888)/;
const SERVICE_TEXT = /\b(verification|your .* code|one-time|otp|do not reply|reply stop|unsubscribe)\b/i;
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const isoDate = (s) => {
  if (/^\d{4}-\d\d-\d\d$/.test(s)) return s;
  const m = String(s).match(/([A-Z][a-z]{2}) (\d{1,2})$/);
  return m ? `2026-${String(MONTHS[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}` : s;
};

const byKey = new Map();
let unresolved = 0;
for (const [num, name, date, missed, preview] of rows) {
  const phone = num || names[name] || '';
  const key = last10(phone);
  if (key.length !== 10) { unresolved++; continue; }
  const d = isoDate(date);
  const prev = byKey.get(key);
  const stop = /^\s*(stop|unsubscribe|stopall|cancel|end|quit)\s*$/i.test(preview || '');
  const textedWith = !missed && !SERVICE_TEXT.test(preview || '') && !TOLL_FREE.test(key);
  if (!prev) byKey.set(key, { key, name: name || '', last: d, textedWith, optedOut: stop, preview: preview || '' });
  else { prev.textedWith ||= textedWith; prev.optedOut ||= stop; if (!prev.name && name) prev.name = name; if (d > prev.last) prev.last = d; }
}

const list = [...byKey.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = [['phone', 'name', 'last_conversation', 'texted_with', 'opted_out', 'last_message']]
  .concat(list.map((p) => [`+1${p.key}`, p.name, p.last, p.textedWith ? 'yes' : 'no (call/voicemail/service only)', p.optedOut ? 'yes' : '', p.preview]))
  .map((r) => r.map(cell).join(',')).join('\r\n');
const out = path.join(DIR, 'textnow-all-numbers.csv');
fs.writeFileSync(out, '﻿' + csv);
console.log(`${list.length} unique numbers → ${out}`);
console.log(`  SMS-eligible (real text exchange, not toll-free/service, not STOP): ${list.filter((p) => p.textedWith && !p.optedOut).length}`);
console.log(`  rows with no number yet (named contacts not resolved / groups): ${unresolved}`);

if (process.argv.includes('--import')) {
  const API = (process.env.FIVESTARFLOW_URL || '').replace(/\/$/, '');
  const TOKEN = process.env.FIVESTARFLOW_TOKEN || process.env.AI_TOKEN;
  if (!API || !TOKEN) { console.error('Set FIVESTARFLOW_URL and FIVESTARFLOW_TOKEN (see ~/.5starflow/env)'); process.exit(1); }
  const contacts = list.map((p) => ({ phone: `+1${p.key}`, clientName: p.name, smsAllowed: p.textedWith && !p.optedOut }));
  fetch(`${API}/api/ai/audiences/import`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ name: 'All TextNow Numbers', contacts }) })
    .then(async (r) => { console.log(r.status, await r.text()); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
