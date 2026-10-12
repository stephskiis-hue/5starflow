#!/usr/bin/env node
// TextNow watcher (MSI PC). Reads the owner's TextNow line and posts new messages to 5StarFlow. READ ONLY: it never
// types in a conversation, never types a password, never solves a captcha. Zero Claude tokens. The owner signs in by
// hand once (--login); the login lives in a local browser profile, so normal runs are headless.
//   node scripts/textnow-watch.js --login      first time: opens a window, sign in, it then does a normal run
//   node scripts/textnow-watch.js              normal run (the request gate starts it every 2 hours, 7 am to 9 pm)
//   node scripts/textnow-watch.js --backfill   one-off: page back through the whole history (the learning bootstrap)
//   node scripts/textnow-watch.js --dry        read and print, post nothing
// Options: --profile <dir> (default ~/.5starflow/textnow-profile)  --max-pages <n>
// Needs FIVESTARFLOW_URL and FIVESTARFLOW_TOKEN (the request gate loads them from ~/.5starflow/env).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { harvest, toIso } = require('../lib/textnow');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : def; };
const flag = (name) => process.argv.includes(name);
const LOGIN = flag('--login');
const BACKFILL = flag('--backfill');
const DRY = flag('--dry');
const PROFILE = arg('--profile', path.join(os.homedir(), '.5starflow', 'textnow-profile'));
const MAX_PAGES = Number(arg('--max-pages', BACKFILL ? 600 : 5));
const API = (process.env.FIVESTARFLOW_URL || '').replace(/\/$/, '');
const TOKEN = process.env.FIVESTARFLOW_TOKEN || process.env.AI_TOKEN;
const SLUG = 'local-textnow-watch';
const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 1500;          // human pace: TextNow is not an API we are entitled to hammer
const LOGIN_WAIT_MS = 10 * 60 * 1000;
const OVERLAP_MS = 10 * 60 * 1000;   // page a little past the stored cursor; ingest is idempotent
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * 800);
const isLoggedOut = (url) => /\/login|\/signup|\/sign-in/i.test(url);

async function api(method, route, body) {
  const res = await fetch(`${API}/api/ai${route}`, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, 'X-Agent': 'communication', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${data.error || ''}`.trim());
  return data;
}
// Reporting must never mask the real outcome: a failed health/run post is only logged.
const tell = (method, route, body) => (DRY ? Promise.resolve() : api(method, route, body)).catch((e) => console.warn(`  (could not report: ${e.message})`));

async function finish(code, { state, detail, runStatus, summary, result }) {
  await tell('POST', '/textnow/health', { state, detail });
  await tell('POST', '/runs', { slug: SLUG, status: runStatus, summary, trigger: LOGIN ? 'manual' : 'schedule', result, error: runStatus === 'failed' ? detail : undefined });
  console.log(`${new Date().toISOString()} ${state}: ${summary}${detail ? ` (${detail})` : ""}`);
  process.exit(code);
}

async function main() {
  if (!DRY && (!API || !TOKEN)) { console.error('FIVESTARFLOW_URL and FIVESTARFLOW_TOKEN are required (or use --dry).'); process.exit(1); }
  fs.mkdirSync(PROFILE, { recursive: true });
  const launch = { headless: !LOGIN, viewport: { width: 1280, height: 900 } };
  let ctx;
  try { ctx = await chromium.launchPersistentContext(PROFILE, { ...launch, channel: 'chrome' }); }
  catch { ctx = await chromium.launchPersistentContext(PROFILE, launch); }   // no Chrome installed → Playwright's Chromium
  const page = ctx.pages()[0] || await ctx.newPage();
  const done = async (code, o) => { await ctx.close().catch(() => {}); return finish(code, o); };

  const seen = new Map();   // messages TextNow itself loads on the page (fallback when the paged pull fails)
  let username = null; let apiHeaders = null;
  page.on('request', (req) => {
    const m = req.url().match(/textnow\.com\/api\/users\/([^/?]+)\//);
    if (m && !username) {
      username = decodeURIComponent(m[1]);
      apiHeaders = Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !/^(cookie|host|content-length|:)/i.test(k)));
    }
  });
  page.on('response', async (res) => {
    if (!/textnow\.com\/api\//.test(res.url()) || !(res.headers()['content-type'] || '').includes('json')) return;
    try { harvest(await res.json(), seen); } catch { /* not JSON after all */ }
  });

  await sleep(jitter(1000));
  await page.goto('https://www.textnow.com/messaging', { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  if (isLoggedOut(page.url())) {
    if (!LOGIN) return done(2, { state: 'needs_login', detail: 'TextNow shows its login page. Run: node scripts/textnow-watch.js --login', runStatus: 'failed', summary: 'TextNow is logged out' });
    console.log('Sign in to TextNow in the browser window (up to 10 minutes). The first run starts by itself after that.');
    const until = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < until && (isLoggedOut(page.url()) || !page.url().includes('/messaging'))) await sleep(2000);
    if (isLoggedOut(page.url())) return done(2, { state: 'needs_login', detail: 'Timed out waiting for the sign-in.', runStatus: 'failed', summary: 'Sign-in timed out' });
  }

  for (let i = 0; i < 30 && !username; i++) await sleep(1000);
  if (!username) { await page.reload({ waitUntil: 'domcontentloaded' }); for (let i = 0; i < 30 && !username; i++) await sleep(1000); }
  if (!username) {
    const loggedOut = isLoggedOut(page.url());
    return done(loggedOut ? 2 : 3, { state: loggedOut ? 'needs_login' : 'parse_error', detail: loggedOut ? 'Session expired.' : 'Signed in, but could not see TextNow\'s API calls (captcha or layout change?).', runStatus: 'failed', summary: loggedOut ? 'TextNow is logged out' : 'Could not read TextNow' });
  }

  const cursor = BACKFILL || DRY ? { lastAt: null, lastId: null, count: 0 } : await api('GET', '/textnow/cursor').catch(() => ({ lastAt: null, lastId: null, count: 0 }));
  const stopAt = cursor.lastAt ? new Date(cursor.lastAt).getTime() - OVERLAP_MS : null;
  console.log(`Signed in as ${username}. ${BACKFILL ? 'Backfilling the whole history' : cursor.lastAt ? `Reading messages newer than ${cursor.lastAt}` : 'No stored messages yet: reading the latest pages'}...`);

  const messages = new Map();
  let pagedOk = false; let startId = null; let pages = 0; let retries = 0;
  for (;;) {
    const qs = new URLSearchParams({ page_size: String(PAGE_SIZE), direction: 'past', get_all: '1' });
    if (startId) qs.set('start_message_id', startId);
    const r = await page.evaluate(async ({ url, headers }) => {
      const res = await fetch(url, { headers, credentials: 'include' });
      return { status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
    }, { url: `/api/users/${encodeURIComponent(username)}/messages?${qs}`, headers: apiHeaders });
    if (r.status === 401 || r.status === 403) return done(2, { state: 'needs_login', detail: `TextNow answered ${r.status}`, runStatus: 'failed', summary: 'TextNow is logged out' });
    if (r.status === 429) {
      if (++retries > 3) return done(4, { state: 'rate_limited', detail: 'TextNow kept saying slow down.', runStatus: 'failed', summary: 'TextNow rate limited the watcher' });
      console.log('TextNow says slow down; waiting 60s...'); await sleep(60000); continue;
    }
    if (r.status !== 200 || !r.body) break;
    pagedOk = true;
    const batch = new Map(); harvest(r.body, batch);
    let added = 0;
    for (const [id, m] of batch) if (!messages.has(id)) { messages.set(id, m); added++; }
    pages++;
    const ids = [...batch.keys()].map(Number).filter(Number.isFinite);
    const oldest = ids.length ? String(Math.min(...ids)) : null;
    const oldestAt = Math.min(...[...batch.values()].map((m) => new Date(toIso(m.at) || Date.now()).getTime()));
    process.stdout.write(`\r  page ${pages}: ${messages.size} messages`);
    if (!batch.size || !added || !oldest || oldest === startId || pages >= MAX_PAGES) break;
    if (stopAt && oldestAt < stopAt) break;   // already stored beyond this point
    startId = oldest;
    await sleep(jitter(PAGE_DELAY_MS));
  }
  process.stdout.write('\n');

  if (!pagedOk) for (const [id, m] of seen) messages.set(id, m);   // fall back to what the page loaded by itself
  await ctx.close().catch(() => {});

  const out = [...messages.values()].map((m) => ({ id: m.id, contact: m.contact, name: m.name, direction: m.direction, body: m.body, at: toIso(m.at), media: !!m.media })).filter((m) => m.at);
  if (!out.length && !pagedOk) return finish(3, { state: 'parse_error', detail: 'The history endpoint failed and the page loaded no messages.', runStatus: 'failed', summary: 'Could not read TextNow messages' });
  if (DRY) { console.log(`DRY: would post ${out.length} message(s)`); console.log(JSON.stringify(out.slice(0, 3), null, 1)); process.exit(0); }

  let inserted = 0; let newInbound = 0; let urgent = 0;
  for (let i = 0; i < out.length; i += 400) {
    const r = await api('POST', '/textnow/ingest', { messages: out.slice(i, i + 400) });
    inserted += r.inserted; newInbound += r.newInbound; urgent += r.urgent;
  }
  return finish(0, {
    state: 'ok', detail: '', runStatus: inserted ? 'completed' : 'skipped',
    summary: inserted ? `Read ${out.length} TextNow message(s), ${inserted} new (${newInbound} from customers)` : 'No new TextNow messages',
    result: { items_found: newInbound, requires_attention: urgent, actions_taken: inserted ? [`Ingested ${inserted} TextNow message(s)`] : [] },
  });
}

main().catch((err) => finish(1, { state: 'error', detail: String(err.message || err).slice(0, 300), runStatus: 'failed', summary: 'TextNow watcher crashed' }));
