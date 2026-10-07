#!/usr/bin/env node
// TextNow export: every conversation's phone number (+ full message history) into a spreadsheet.
// The owner signs in by hand the first time (the window opens); the login is kept in a local browser
// profile so later runs can use --headless. Never types a password, never solves a captcha.
//   node scripts/textnow-export.js              first run: sign in, then it exports
//   node scripts/textnow-export.js --headless   later runs
// Options: --out <dir> (default ~/textnow-export)  --profile <dir> (default ~/.5starflow/textnow-profile)
// Output: textnow-contacts-<date>.csv (one row per number, opens in Excel/Sheets) + textnow-messages-<date>.json
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : def; };
const HEADLESS = process.argv.includes('--headless');
const OUT = arg('--out', path.join(os.homedir(), 'textnow-export'));
const PROFILE = arg('--profile', path.join(os.homedir(), '.5starflow', 'textnow-profile'));
const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 1200;   // human pace: TextNow is not an API we're entitled to hammer
const LOGIN_WAIT_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const digits = (v) => String(v || '').replace(/\D/g, '');
function e164(v) {
  const d = digits(v);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d.length > 11 ? `+${d}` : null;   // short codes / system senders → null (skipped)
}

// TextNow's field names have changed over the years: accept the variants we know of.
function normalizeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const contact = m.contact_value ?? m.contactValue ?? m.e164_contact_value ?? m.contact?.value;
  const id = m.id ?? m.message_id ?? m.messageId;
  if (!contact || id == null) return null;
  const dir = m.message_direction ?? m.direction ?? m.messageDirection;
  return {
    id: String(id),
    contact: String(contact),
    name: m.contact_name ?? m.contactName ?? m.contact?.name ?? '',
    direction: dir === 1 || dir === 'incoming' || dir === 'in' ? 'in' : dir === 2 || dir === 'outgoing' || dir === 'out' ? 'out' : String(dir ?? ''),
    body: m.message ?? m.body ?? m.text ?? '',
    at: m.date ?? m.timestamp ?? m.created_at ?? m.createdAt ?? null,
  };
}

// Walk any JSON TextNow loads and keep every message-shaped object (fallback when the paged pull fails).
function harvest(node, into, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) { for (const x of node) harvest(x, into, depth + 1); return; }
  const m = normalizeMessage(node);
  if (m) into.set(m.id, m);
  for (const v of Object.values(node)) if (v && typeof v === 'object') harvest(v, into, depth + 1);
}

const isLoggedOut = (url) => /\/login|\/signup|\/sign-in/i.test(url);

async function main() {
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const launch = { headless: HEADLESS, viewport: { width: 1280, height: 900 } };
  let ctx;
  try { ctx = await chromium.launchPersistentContext(PROFILE, { ...launch, channel: 'chrome' }); }
  catch { ctx = await chromium.launchPersistentContext(PROFILE, launch); }   // no Chrome installed → Playwright's Chromium
  const page = ctx.pages()[0] || await ctx.newPage();

  const messages = new Map();
  let username = null;
  let apiHeaders = null;
  page.on('request', (req) => {
    const m = req.url().match(/textnow\.com\/api\/users\/([^/?]+)\//);
    if (m && !username) {
      username = decodeURIComponent(m[1]);
      apiHeaders = Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !/^(cookie|host|content-length|:)/i.test(k)));
    }
  });
  page.on('response', async (res) => {
    if (!/textnow\.com\/api\//.test(res.url())) return;
    if (!(res.headers()['content-type'] || '').includes('json')) return;
    try { harvest(await res.json(), messages); } catch { /* not JSON after all */ }
  });

  await page.goto('https://www.textnow.com/messaging', { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  if (isLoggedOut(page.url())) {
    if (HEADLESS) {
      console.error('Not signed in. Run once WITHOUT --headless and sign in to TextNow in the window that opens.');
      await ctx.close(); process.exit(2);
    }
    console.log('Sign in to TextNow in the browser window (up to 10 min). The export starts by itself after that.');
    const until = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < until && (isLoggedOut(page.url()) || !page.url().includes('/messaging'))) await sleep(2000);
    if (isLoggedOut(page.url())) { console.error('Timed out waiting for sign-in.'); await ctx.close(); process.exit(2); }
  }

  // The messaging page calls /api/users/<username>/... on load; that gives us the username + headers to reuse.
  for (let i = 0; i < 30 && !username; i++) await sleep(1000);
  if (!username) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 30 && !username; i++) await sleep(1000);
  }
  if (!username) {
    console.error('Signed in, but could not see TextNow\'s API calls (captcha or layout change?). Re-run without --headless and look at the window.');
    await ctx.close(); process.exit(3);
  }
  console.log(`Signed in as ${username}. Pulling message history, newest first...`);

  // Page back through every message on the account: the endpoint the web app itself uses for history.
  let cursor = null;
  let pages = 0;
  let pagedOk = false;
  for (;;) {
    const qs = new URLSearchParams({ page_size: String(PAGE_SIZE), direction: 'past', get_all: '1' });
    if (cursor) qs.set('start_message_id', cursor);
    const url = `/api/users/${encodeURIComponent(username)}/messages?${qs}`;
    const r = await page.evaluate(async ({ url, headers }) => {
      const res = await fetch(url, { headers, credentials: 'include' });
      return { status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
    }, { url, headers: apiHeaders });
    if (r.status === 429) { console.log('TextNow says slow down; waiting 60s...'); await sleep(60000); continue; }
    if (r.status !== 200 || !r.body) { if (!pagedOk) console.warn(`History endpoint answered ${r.status}; falling back to scrolling the conversation list.`); break; }
    pagedOk = true;
    const batch = new Map();
    harvest(r.body, batch);
    let added = 0;
    for (const [id, m] of batch) if (!messages.has(id)) { messages.set(id, m); added++; }
    pages++;
    const ids = [...batch.keys()].map(Number).filter(Number.isFinite);
    const oldest = ids.length ? String(Math.min(...ids)) : null;
    process.stdout.write(`\r  page ${pages}: ${messages.size} messages`);
    if (!batch.size || !added || !oldest || oldest === cursor) break;
    cursor = oldest;
    await sleep(PAGE_DELAY_MS);
  }
  process.stdout.write('\n');

  if (!pagedOk) {
    // Fallback: scroll the left conversation list to the bottom; the response listener harvests what loads.
    let last = -1;
    for (let i = 0; i < 400 && messages.size !== last; i++) {
      last = messages.size;
      await page.mouse.move(200, 500);
      for (let k = 0; k < 5; k++) { await page.mouse.wheel(0, 2000); await sleep(400); }
      await sleep(PAGE_DELAY_MS);
      process.stdout.write(`\r  scrolling: ${messages.size} messages`);
    }
    process.stdout.write('\n');
  }
  await ctx.close();

  // One row per phone number.
  const people = new Map();
  let skipped = 0;
  for (const m of messages.values()) {
    const phone = e164(m.contact);
    if (!phone) { skipped++; continue; }
    const t = m.at ? new Date(m.at) : null;
    const p = people.get(phone) || { phone, name: '', first: null, last: null, lastIn: null, count: 0, inCount: 0, outCount: 0, lastDirection: '', lastMessage: '', optedOut: false };
    if (m.name && !/^\+?\d[\d\s()-]*$/.test(m.name)) p.name = m.name;
    p.count++;
    if (m.direction === 'in') { p.inCount++; if (t && (!p.lastIn || t > p.lastIn)) p.lastIn = t; }
    if (m.direction === 'out') p.outCount++;
    if (m.direction === 'in' && /^\s*(stop|unsubscribe|stopall|cancel|end|quit)\s*$/i.test(m.body)) p.optedOut = true;
    if (t && (!p.first || t < p.first)) p.first = t;
    if (t && (!p.last || t >= p.last)) { p.last = t; p.lastDirection = m.direction; p.lastMessage = String(m.body).replace(/\s+/g, ' ').slice(0, 200); }
    people.set(phone, p);
  }

  const day = (d) => (d ? d.toISOString().slice(0, 10) : '');
  const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = ['phone', 'name', 'first_message', 'last_message', 'last_inbound', 'messages', 'inbound', 'outbound', 'last_direction', 'opted_out', 'last_message_text'];
  const rows = [...people.values()].sort((a, b) => (b.last || 0) - (a.last || 0)).map((p) => [
    p.phone, p.name, day(p.first), day(p.last), day(p.lastIn), p.count, p.inCount, p.outCount, p.lastDirection, p.optedOut ? 'yes' : '', p.lastMessage,
  ]);
  const stamp = new Date().toISOString().slice(0, 10);
  const csvPath = path.join(OUT, `textnow-contacts-${stamp}.csv`);
  const jsonPath = path.join(OUT, `textnow-messages-${stamp}.json`);
  fs.writeFileSync(csvPath, '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n'));   // BOM so Excel reads UTF-8
  fs.writeFileSync(jsonPath, JSON.stringify([...messages.values()], null, 1));

  console.log(`Done: ${people.size} phone numbers from ${messages.size} messages (${skipped} from short codes/system senders skipped).`);
  console.log(`  spreadsheet: ${csvPath}`);
  console.log(`  messages:    ${jsonPath}`);
  if (people.size && !pagedOk) console.log('Note: used the scroll fallback; check the count against the TextNow sidebar.');
}

main().catch((err) => { console.error(err); process.exit(1); });
