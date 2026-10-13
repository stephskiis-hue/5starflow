#!/usr/bin/env node
// TextNow watcher (MSI PC). Reads the owner's TextNow line and posts new messages to 5StarFlow. READ ONLY: it never
// types in a conversation, never types a password, never solves a captcha. Zero Claude tokens. The owner signs in by
// hand once (--login); the login lives in a local browser profile, so normal runs are headless.
//   node scripts/textnow-watch.js --login      first time: opens a window, sign in, it then does a normal run
//   node scripts/textnow-watch.js              normal run (the request gate starts it every 2 hours, 7 am to 9 pm)
//   node scripts/textnow-watch.js --backfill   one-off: page back through the whole history (the learning bootstrap)
//   node scripts/textnow-watch.js --dry        read and print, post nothing
//   node scripts/textnow-watch.js --probe      diagnose: records WHICH calls TextNow's page makes (names and shapes only: no cookies,
//                                              tokens or message text) into ~/.5starflow/textnow-probe.json to paste into a chat
// Options: --profile <dir> (default ~/.5starflow/textnow-profile)  --max-pages <n>
// Needs FIVESTARFLOW_URL and FIVESTARFLOW_TOKEN (the request gate loads them from ~/.5starflow/env).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { harvest, toIso, maskPath, shapeOf, CHALLENGE_RE, chromeCandidates, pickExisting, isSignedInTab } = require('../lib/textnow');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : def; };
const flag = (name) => process.argv.includes(name);
const LOGIN = flag('--login');
const BACKFILL = flag('--backfill');
const DRY = flag('--dry');
const PROBE = flag('--probe');
const PROFILE = arg('--profile', path.join(os.homedir(), '.5starflow', 'textnow-profile'));   // engine 'playwright' only
// Default engine: start a normal Chrome as its own process (own profile folder, debugging port) and attach AFTERWARDS.
// Playwright's own launch marks the browser as automated, which TextNow's bot check answers with an endless captcha.
const ENGINE = arg('--engine', process.env.TEXTNOW_ENGINE || 'native');
const CHROME_PROFILE = arg('--chrome-profile', path.join(os.homedir(), '.5starflow', 'textnow-chrome'));
const CDP_PORT = Number(process.env.TEXTNOW_CDP_PORT || 9223);
const MAX_PAGES = Number(arg('--max-pages', BACKFILL ? 600 : 5));
const API = (process.env.FIVESTARFLOW_URL || '').replace(/\/$/, '');
const TOKEN = process.env.FIVESTARFLOW_TOKEN || process.env.AI_TOKEN;
const SLUG = 'local-textnow-watch';
const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 1500;          // human pace: TextNow is not an API we are entitled to hammer
const LOGIN_WAIT_MS = 10 * 60 * 1000;
const PROBE_MS = Number(process.env.TEXTNOW_PROBE_SECONDS || 75) * 1000;
const OVERLAP_MS = 10 * 60 * 1000;   // page a little past the stored cursor; ingest is idempotent
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * 800);
const isLoggedOut = (url) => /\/login|\/signup|\/sign-in/i.test(url);

// ---------------------------------------------------------------------------------------------------------------------
// Browser launch. Nothing here hides automation or solves anything: it starts an ordinary Chrome and, for sign-in, waits
// for the owner to finish BEFORE attaching (it only polls Chrome's tab list over HTTP, which does not touch the page).
// ---------------------------------------------------------------------------------------------------------------------
const cdpUrl = (route) => `http://127.0.0.1:${CDP_PORT}${route}`;
const cdpUp = async () => { try { return (await fetch(cdpUrl('/json/version'), { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
const cdpTabs = async () => { try { return await (await fetch(cdpUrl('/json/list'), { signal: AbortSignal.timeout(2000) })).json(); } catch { return []; } };
async function waitUntil(fn, ms, every = 1000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(every); } return false; }

async function openNative({ headless, waitSignIn }) {
  let spawned = false;
  if (!(await cdpUp())) {
    const exe = pickExisting(chromeCandidates(), fs.existsSync);
    if (!exe) throw new Error('Chrome was not found. Install Google Chrome, or set CHROME_BIN to its chrome.exe.');
    fs.mkdirSync(CHROME_PROFILE, { recursive: true });
    const args = [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${CHROME_PROFILE}`, '--no-first-run', '--no-default-browser-check',
      ...(headless ? ['--headless=new'] : []), ...(process.env.TEXTNOW_CHROME_ARGS ? process.env.TEXTNOW_CHROME_ARGS.split(';;').filter(Boolean) : []),
      'https://www.textnow.com/messaging'];
    spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
    spawned = true;
    if (!(await waitUntil(cdpUp, 30000, 500))) throw new Error(`Chrome started but never opened its debugging port ${CDP_PORT}. Close any Chrome started by this script and retry.`);
  }
  if (waitSignIn) {
    console.log('A normal Chrome window is open on TextNow. Sign in there yourself (up to 10 minutes). Do not close it; the script carries on by itself once you are in.');
    const ok = await waitUntil(async () => (await cdpTabs()).some((t) => isSignedInTab(t.url)), LOGIN_WAIT_MS, 2000);
    if (!ok) { const e = new Error('Timed out waiting for the TextNow sign-in.'); e.code = 'SIGNIN_TIMEOUT'; throw e; }
  }
  const browser = await chromium.connectOverCDP(cdpUrl(''));
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = ctx.pages().find((pg) => /textnow\.com/.test(pg.url())) || ctx.pages()[0] || await ctx.newPage();
  // Only close Chrome if this run started it; a window the owner already had open is just disconnected from.
  const close = async () => {
    if (spawned) { try { await (await browser.newBrowserCDPSession()).send('Browser.close'); } catch { /* already gone */ } }
    try { await browser.close(); } catch { /* disconnected */ }
  };
  return { ctx, page, close };
}

async function openPlaywright({ headless }) {
  fs.mkdirSync(PROFILE, { recursive: true });
  const launch = { headless, viewport: { width: 1280, height: 900 } };
  let ctx;
  try { ctx = await chromium.launchPersistentContext(PROFILE, { ...launch, channel: 'chrome' }); }
  catch { ctx = await chromium.launchPersistentContext(PROFILE, launch); }   // no Chrome installed → Playwright's Chromium
  return { ctx, page: ctx.pages()[0] || await ctx.newPage(), close: () => ctx.close().catch(() => {}) };
}

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
const tell = (method, route, body) => (DRY || PROBE ? Promise.resolve() : api(method, route, body)).catch((e) => console.warn(`  (could not report: ${e.message})`));

async function finish(code, { state, detail, runStatus, summary, result }) {
  await tell('POST', '/textnow/health', { state, detail });
  await tell('POST', '/runs', { slug: SLUG, status: runStatus, summary, trigger: LOGIN ? 'manual' : 'schedule', result, error: runStatus === 'failed' ? detail : undefined });
  console.log(`${new Date().toISOString()} ${state}: ${summary}${detail ? ` (${detail})` : ""}`);
  process.exit(code);
}

async function main() {
  if (!DRY && !PROBE && (!API || !TOKEN)) { console.error('FIVESTARFLOW_URL and FIVESTARFLOW_TOKEN are required (or use --dry).'); process.exit(1); }
  const headless = !(LOGIN || PROBE);
  let browserSession;
  try { browserSession = ENGINE === 'playwright' ? await openPlaywright({ headless }) : await openNative({ headless, waitSignIn: !headless }); }
  catch (e) {
    if (e.code === 'SIGNIN_TIMEOUT') return finish(2, { state: 'needs_login', detail: e.message, runStatus: 'failed', summary: 'Sign-in timed out' });
    throw e;
  }
  const { ctx, page } = browserSession;
  const done = async (code, o) => { await browserSession.close(); return finish(code, o); };

  const seen = new Map();   // messages TextNow itself loads on the page (fallback when the paged pull fails)
  const traffic = new Map();   // what the page called: "METHOD host /masked/path status" → { n, type, shape?, headerNames? } (no values)
  const sockets = new Set();
  let username = null; let apiHeaders = null;
  const isTextNow = (u) => { try { return new URL(u).hostname.endsWith('textnow.com'); } catch { return false; } };
  page.on('websocket', (ws) => { if (isTextNow(ws.url())) { const m = maskPath(ws.url()); sockets.add(`${m.host}${m.path}`); } });
  page.on('request', (req) => {
    if (!isTextNow(req.url())) return;
    const m = req.url().match(/\/api\/(?:v\d+\/)?users\/([^/?]+)\//);
    if (m && !username) {
      username = decodeURIComponent(m[1]);
      apiHeaders = Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !/^(cookie|host|content-length|:)/i.test(k)));
    }
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (!isTextNow(url)) return;
    const type = (res.headers()['content-type'] || '').split(';')[0];
    const m = maskPath(url);
    const key = `${res.request().method()} ${m.host} ${m.path}${m.query.length ? `?${m.query.join('&')}` : ''} ${res.status()}`;
    const entry = traffic.get(key) || { n: 0, type };
    entry.n++;
    if (!entry.headerNames && /\/api\//.test(url)) entry.headerNames = Object.keys(res.request().headers()).filter((h) => !/^(cookie|host|:)/i.test(h)).sort();   // names only, never values
    if (type.includes('json')) {
      try {
        const body = await res.json();
        harvest(body, seen);
        if (PROBE && !entry.shape) entry.shape = shapeOf(body);   // shape only: key names and types
      } catch { /* not JSON after all */ }
    }
    traffic.set(key, entry);
  });
  const snapshot = async () => {
    let diag = {};
    try {
      diag = await page.evaluate((re) => ({
        webdriver: navigator.webdriver, frames: [...document.querySelectorAll('iframe')].map((f) => { try { return new URL(f.src, location.href).hostname; } catch { return ''; } }).filter(Boolean),
        challengeText: new RegExp(re, 'i').test((document.body && document.body.innerText || '').slice(0, 6000)),
      }), CHALLENGE_RE.source);
    } catch { /* page closed */ }
    const u = maskPath(page.url());
    return { url: `${u.host}${u.path}`, title: String(await page.title().catch(() => '')).replace(/\d+/g, 'N').slice(0, 60), ...diag };
  };
  // one short line for the health task / console: what the page showed and which TextNow calls it made
  const describeSeen = async () => {
    const d = await snapshot();
    const top = [...traffic.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5).map(([k, v]) => `${k} x${v.n}`).join('; ');
    return `page ${d.url} "${d.title}", challenge: ${d.challengeText || (d.frames || []).some((h) => /captcha|recaptcha|hcaptcha|challenge|cloudflare/i.test(h)) ? 'yes' : 'no'}, webdriver: ${d.webdriver}, messages seen: ${seen.size}, calls: ${top || 'none'}`;
  };

  await sleep(jitter(1000));
  await page.goto('https://www.textnow.com/messaging', { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  if (isLoggedOut(page.url())) {
    if (!LOGIN && !PROBE) return done(2, { state: 'needs_login', detail: 'TextNow shows its login page. Run: node scripts/textnow-watch.js --login', runStatus: 'failed', summary: 'TextNow is logged out' });
    console.log('Sign in to TextNow in the browser window (up to 10 minutes). The first run starts by itself after that.');
    const until = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < until && (isLoggedOut(page.url()) || !page.url().includes('/messaging'))) await sleep(2000);
    if (isLoggedOut(page.url())) return done(2, { state: 'needs_login', detail: 'Timed out waiting for the sign-in.', runStatus: 'failed', summary: 'Sign-in timed out' });
  }

  if (PROBE) {
    console.log(`\nPROBE: recording what TextNow's page does for ${PROBE_MS / 1000} seconds.\n  Please CLICK ONE CONVERSATION in the window now, then scroll its messages up a little.\n  Nothing is sent anywhere; only call names and data shapes (no message text, cookies or tokens) are saved.`);
    await sleep(PROBE_MS);
    const d = await snapshot();
    const out = {
      at: new Date().toISOString(), node: process.version, platform: process.platform, page: d, messagesSeenOnPage: seen.size, websockets: [...sockets],
      calls: [...traffic.entries()].sort((a, b) => b[1].n - a[1].n).map(([call, v]) => ({ call, ...v })),
    };
    const file = path.join(os.homedir(), '.5starflow', 'textnow-probe.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
    await browserSession.close();
    console.log(`\nSaved ${file}\n--- copy everything between the lines and paste it into the chat ---\n${JSON.stringify(out, null, 1)}\n--- end ---`);
    process.exit(0);
  }

  // Wait for the page to make its API calls (or for messages to appear in them); reload once if nothing shows up.
  const ready = () => username || seen.size > 0;
  for (let i = 0; i < 30 && !ready(); i++) await sleep(1000);
  if (!ready()) { await page.reload({ waitUntil: 'domcontentloaded' }); for (let i = 0; i < 30 && !ready(); i++) await sleep(1000); }
  if (!ready()) {
    const loggedOut = isLoggedOut(page.url());
    const detail = loggedOut ? 'Session expired.' : `Signed in, but the page made no readable TextNow calls. ${await describeSeen()}`;
    return done(loggedOut ? 2 : 3, { state: loggedOut ? 'needs_login' : 'parse_error', detail, runStatus: 'failed', summary: loggedOut ? 'TextNow is logged out' : 'Could not read TextNow' });
  }

  const cursor = BACKFILL || DRY ? { lastAt: null, lastId: null, count: 0 } : await api('GET', '/textnow/cursor').catch(() => ({ lastAt: null, lastId: null, count: 0 }));
  const stopAt = cursor.lastAt ? new Date(cursor.lastAt).getTime() - OVERLAP_MS : null;
  console.log(`${username ? `Signed in as ${username}.` : 'Signed in (reading what the page loads by itself).'} ${BACKFILL ? 'Backfilling the whole history' : cursor.lastAt ? `Reading messages newer than ${cursor.lastAt}` : 'No stored messages yet: reading the latest pages'}...`);

  const messages = new Map();
  let pagedOk = false; let startId = null; let pages = 0; let retries = 0;
  while (username) {
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
  const seenDesc = await describeSeen().catch(() => '');
  await browserSession.close();

  const out = [...messages.values()].map((m) => ({ id: m.id, contact: m.contact, name: m.name, direction: m.direction, body: m.body, at: toIso(m.at), media: !!m.media })).filter((m) => m.at);
  if (!out.length && !pagedOk) return finish(3, { state: 'parse_error', detail: `The history endpoint failed and the page loaded no messages. ${seenDesc}`, runStatus: 'failed', summary: 'Could not read TextNow messages' });
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
