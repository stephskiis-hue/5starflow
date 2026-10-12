/**
 * TextNow Watch — the server half. The owner's TextNow line is read by a script on the MSI PC (scripts/textnow-watch.js,
 * zero Claude tokens) that POSTs new messages here. They land in the same CommMessage ledger as Twilio texts
 * (channel 'textnow'), so the monitor, the brief and customer context see them. Phase 1 is read-only: nothing here
 * ever sends to a customer. A daily Claude run (prompts/textnow-insight.md) classifies the threads, records what it
 * WOULD have replied (CommInsight), and this file scores that against what the owner actually said.
 */
const prisma = require('../lib/prismaClient');
const { classifyConversation, getConversationStates, NEEDS_US, COMPLAINT } = require('./comms');
const { createTask, completeByDedupKey } = require('./tasks');
const { notify } = require('../lib/notify');
const { e164, last10, normalizeMessage } = require('../lib/textnow');
const { toDateString, localHour } = require('../lib/tz');
const { clip } = require('./constants');

const CH = 'textnow';
const WATCH_SLUG = 'local-textnow-watch';
const INSIGHT_SLUG = 'ext-textnow-insight';
const INTENTS = ['cancel_visit', 'skip_visit', 'reschedule', 'schedule_question', 'quote_request', 'access_info', 'complaint', 'billing', 'praise', 'ack', 'other'];
const HEALTH_STATES = ['ok', 'needs_login', 'parse_error', 'rate_limited', 'error'];
const MEDIA_MARK = '[photo/media attached]';
const MAX_BATCH = 500;
const FRESH_MS = 6 * 3600 * 1000;   // only a message this recent can raise an immediate alert (a backfill must not text the owner 500 times)

// ---------------------------------------------------------------------------------------------
// Deterministic urgency: the few things worth a text before the next summary. Everything else waits for the digest.
// ---------------------------------------------------------------------------------------------
const WHEN = "today|tonight|tomorrow|this (?:morning|afternoon|evening)|monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const CANCEL_SOON = new RegExp(`\\b(?:cancel\\w*|skip\\w*|don'?t come|no need (?:to come|for you)|hold off|postpone\\w*)\\b[^.?!]{0,60}\\b(?:${WHEN})\\b|\\b(?:${WHEN})\\b[^.?!]{0,60}\\b(?:cancel\\w*|skip\\w*|don'?t come|no need)\\b`, 'i');
const DAMAGE = /\b(damag\w*|broke\w*|scratch\w*|dent\w*|flood\w*|injur\w*|hurt)\b/i;
const EMERGENCY = /\b(asap|urgent|emergency|right away|immediately|tree (is )?down|leak\w*)\b/i;

function urgentCheck(body) {
  const b = String(body || '');
  if (COMPLAINT.test(b)) return 'complaint wording';
  if (DAMAGE.test(b)) return 'damage or injury wording';
  if (CANCEL_SOON.test(b)) return 'cancel or skip for a near date';
  if (EMERGENCY.test(b)) return 'urgent wording';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Shadow scoring: how close was the draft to what the owner actually sent? A cheap word-overlap heuristic (Dice) that
// is downgraded when the two name different days or times. The daily Claude run can re-grade borderline cases.
// ---------------------------------------------------------------------------------------------
const STOPWORDS = new Set('a an and are as at be but by can for from have i if in is it me my of on or our so that the this to we will with you your would just thanks thank hi hey hello ok okay'.split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
const FACT = /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b|\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\btomorrow\b|\bnext week\b/g;
const facts = (s) => new Set((String(s || '').toLowerCase().match(FACT) || []).map((f) => f.slice(0, 3)));

/** @returns {'match'|'partial'|'miss'|null} null when there was no draft to compare (we would have held it for the owner) */
function agreementScore(proposed, actual) {
  const p = new Set(words(proposed));
  const a = new Set(words(actual));
  if (!p.size || !a.size) return null;
  let inter = 0;
  for (const w of p) if (a.has(w)) inter++;
  const dice = (2 * inter) / (p.size + a.size);
  let grade = dice >= 0.5 ? 2 : dice >= 0.25 ? 1 : 0;
  const fp = facts(proposed); const fa = facts(actual);
  if (fp.size && fa.size && ![...fp].some((f) => fa.has(f))) grade = Math.max(0, grade - 1);   // different day or time named
  return ['miss', 'partial', 'match'][grade];
}

// ---------------------------------------------------------------------------------------------
// Routine config doubles as the small state store (health, last sync, digest cadence). seedRegistry creates the rows.
// ---------------------------------------------------------------------------------------------
const getRoutine = (userId, slug) => prisma.routine.findUnique({ where: { userId_slug: { userId, slug } } }).catch(() => null);
async function patchConfig(userId, slug, patch) {
  const r = await getRoutine(userId, slug);
  if (!r) return null;
  return prisma.routine.update({ where: { id: r.id }, data: { config: { ...(r.config || {}), ...patch } } });
}

// Both TextNow routines are registered disabled so the heartbeat stays quiet until the MSI is set up; the first real
// signal (a healthy watcher run, the first digest) switches the heartbeat on, once. After that the owner's toggle wins.
async function autoEnable(userId, slug) {
  const r = await getRoutine(userId, slug);
  if (!r || r.enabled || r.config?.autoEnabled) return;
  await prisma.routine.update({ where: { id: r.id }, data: { enabled: true, config: { ...(r.config || {}), autoEnabled: true } } });
}

const approverKeys = (userId) => require('../services/operatorService').getApproverPhonesLast10(userId).catch(() => new Set());

function toDate(v) {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------------------------
const isNormalized = (r) => r && r.id != null && r.contact && (r.direction === 'in' || r.direction === 'out');

/** @param raw  messages as posted by the watcher: already normalized ({id, contact, direction, body, at}) or TextNow's own JSON */
async function ingestMessages(userId, raw) {
  const list = (Array.isArray(raw) ? raw : []).slice(0, MAX_BATCH);
  const rows = []; let skipped = 0;
  for (const r of list) {
    const m = isNormalized(r) ? r : normalizeMessage(r);
    const phone = m && e164(m.contact);
    const at = m && toDate(m.at);
    if (!m || !phone || !at || (m.direction !== 'in' && m.direction !== 'out')) { skipped++; continue; }
    const body = (String(m.body || '').slice(0, 1900) + (m.media ? ` ${MEDIA_MARK}` : '')).trim();
    rows.push({ providerId: String(m.id), direction: m.direction, phone, phoneKey: last10(phone), name: m.name || null, body, at });
  }
  if (!rows.length) return { received: list.length, inserted: 0, newInbound: 0, newOutbound: 0, skipped, urgent: 0 };

  const known = await prisma.commMessage.findMany({ where: { userId, channel: CH, providerId: { in: rows.map((r) => r.providerId) } }, select: { providerId: true, direction: true } });
  const have = new Set(known.map((k) => `${k.direction}:${k.providerId}`));
  const fresh = rows.filter((r) => !have.has(`${r.direction}:${r.providerId}`));
  if (!fresh.length) return { received: list.length, inserted: 0, newInbound: 0, newOutbound: 0, skipped, urgent: 0 };

  const keys = [...new Set(fresh.map((r) => r.phoneKey))];
  const clients = await prisma.cachedJobberClient.findMany({ where: { userId, OR: keys.map((k) => ({ phone: { endsWith: k } })) }, select: { id: true, jobberClientId: true, name: true, phone: true, optedOut: true } });
  const byKey = new Map(clients.map((c) => [last10(c.phone), c]));

  const created = await prisma.commMessage.createMany({
    data: fresh.map((r) => {
      const c = byKey.get(r.phoneKey);
      return {
        userId, channel: CH, direction: r.direction, phone: r.phone, phoneKey: r.phoneKey, jobberClientId: c?.jobberClientId || null,
        clientName: c?.name || r.name || null, body: r.body, source: r.direction === 'in' ? 'inbound' : 'owner', providerId: r.providerId,
        status: r.direction === 'out' ? 'sent' : null, at: r.at,
      };
    }),
    skipDuplicates: true,
  });

  const incoming = fresh.filter((r) => r.direction === 'in');
  // A plain STOP on this line is honoured everywhere (the bare word "cancel" is a visit request here, never an opt-out)
  for (const r of incoming.filter((x) => /^\s*(stop|stopall|unsubscribe)\s*$/i.test(x.body))) {
    const c = byKey.get(r.phoneKey);
    if (c && !c.optedOut) await prisma.cachedJobberClient.update({ where: { id: c.id }, data: { optedOut: true, optedOutAt: r.at } }).catch(() => {});
  }

  let urgent = 0;
  const owner = await approverKeys(userId);
  for (const r of incoming) {
    if (Date.now() - r.at.getTime() > FRESH_MS || owner.has(r.phoneKey)) continue;
    const reason = urgentCheck(r.body);
    if (!reason) continue;
    const who = byKey.get(r.phoneKey)?.name || r.name || r.phone;
    const { created: isNew } = await createTask(userId, {
      dedupKey: `textnow-urgent:${r.phoneKey}:${toDateString()}`, title: `${who} on TextNow: ${reason}`, source: 'textnow', agent: 'communication', urgency: 'urgent',
      customerName: byKey.get(r.phoneKey)?.name || null, customerKey: byKey.get(r.phoneKey)?.jobberClientId || r.phone, reason,
      whatHappened: `TextNow: "${r.body.slice(0, 220)}"`, whatNeeds: 'Read it and answer from TextNow. The AI does not reply on this line yet.',
    });
    if (isNew) { urgent++; await notify(userId, { category: 'customer', urgent: true, title: `${who} texted TextNow: ${reason}`, body: r.body.slice(0, 160), routineSlug: WATCH_SLUG, link: '/ai.html' }); }
  }
  return { received: list.length, inserted: created.count, newInbound: incoming.length, newOutbound: fresh.length - incoming.length, skipped, urgent };
}

/** Where the watcher should stop paging back: everything older than `lastAt` is already stored. */
async function getCursor(userId) {
  const [last, count] = await Promise.all([
    prisma.commMessage.findFirst({ where: { userId, channel: CH }, orderBy: { at: 'desc' }, select: { providerId: true, at: true } }),
    prisma.commMessage.count({ where: { userId, channel: CH } }),
  ]);
  return { lastId: last?.providerId || null, lastAt: last?.at || null, count };
}

// ---------------------------------------------------------------------------------------------
// Watcher health: one task while it is broken, one text per day at most, nothing when it is fine.
// ---------------------------------------------------------------------------------------------
async function setHealth(userId, { state, detail = '' }) {
  if (!HEALTH_STATES.includes(state)) throw new Error(`state must be one of ${HEALTH_STATES.join(', ')}`);
  const now = new Date();
  await patchConfig(userId, WATCH_SLUG, { health: state, healthDetail: clip(detail, 300), lastSeenAt: now, ...(state === 'ok' ? { lastSyncAt: now } : {}) });
  if (state === 'ok') { await autoEnable(userId, WATCH_SLUG); await completeByDedupKey(userId, 'textnow-health'); return { ok: true }; }

  const fix = state === 'needs_login' ? 'On the MSI PC run: node scripts/textnow-watch.js --login (sign in to TextNow in the window that opens).'
    : state === 'parse_error' ? 'TextNow may have changed its page. Run node scripts/textnow-watch.js --login to look at it, then tell Claude.'
    : 'Nothing to do yet; it retries on the next run.';
  await createTask(userId, { dedupKey: 'textnow-health', title: 'TextNow watcher needs attention', source: 'textnow', agent: 'operations', urgency: state === 'rate_limited' ? 'normal' : 'high', reason: state, whatHappened: clip(detail || state, 500), whatNeeds: fix });
  if (state === 'needs_login' || state === 'parse_error') {
    const { created } = await createTask(userId, { dedupKey: `textnow-health:${toDateString()}`, title: 'TextNow watcher alert sent', source: 'textnow', agent: 'operations', urgency: 'low', whatHappened: state });
    if (created) await notify(userId, { category: 'routine', urgent: true, title: 'TextNow watcher stopped', body: state === 'needs_login' ? 'TextNow logged out. Sign in again on the PC.' : 'TextNow looks different. Check the PC.', routineSlug: WATCH_SLUG, link: '/ai.html' });
  }
  return { ok: false, state };
}

// ---------------------------------------------------------------------------------------------
// Threads for the daily run, insights back from it, readiness, scoring
// ---------------------------------------------------------------------------------------------
async function getThreads(userId, { sinceDays = 3, limit = 40, offset = 0 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400000);
  const owner = await approverKeys(userId);
  const active = await prisma.commMessage.findMany({ where: { userId, channel: CH, at: { gte: since } }, select: { phoneKey: true }, distinct: ['phoneKey'], take: 500 });
  const keys = active.map((a) => a.phoneKey).filter((k) => k && !owner.has(k));
  if (!keys.length) return [];

  const msgs = await prisma.commMessage.findMany({ where: { userId, channel: CH, phoneKey: { in: keys }, at: { gte: new Date(Date.now() - Math.max(60, sinceDays) * 86400000) } }, orderBy: { at: 'asc' }, take: 20000 });
  const insights = await prisma.commInsight.findMany({ where: { userId, channel: CH, phoneKey: { in: keys } }, orderBy: { createdAt: 'desc' }, take: 500 });
  const clients = await prisma.cachedJobberClient.findMany({ where: { userId, OR: keys.map((k) => ({ phone: { endsWith: k } })) }, select: { jobberClientId: true, name: true, phone: true } });
  const clientByKey = new Map(clients.map((c) => [last10(c.phone), c]));

  const byKey = new Map();
  for (const m of msgs) (byKey.get(m.phoneKey) || byKey.set(m.phoneKey, []).get(m.phoneKey)).push(m);
  const out = [];
  for (const [phoneKey, list] of byKey) {
    const c = classifyConversation(list, Date.now(), { channel: CH });
    const recent = list.slice(-25);
    const client = clientByKey.get(phoneKey);
    out.push({
      phoneKey, phone: list[list.length - 1].phone, clientName: client?.name || list.find((m) => m.clientName)?.clientName || null,
      jobberClientId: client?.jobberClientId || null, knownClient: !!client,
      state: c.state, urgency: c.urgency, reason: c.reason, waitingMinutes: c.waitingMinutes, urgentReason: urgentCheck(c.lastMessage),
      hasMedia: recent.slice(-5).some((m) => m.body.includes(MEDIA_MARK)), lastAt: list[list.length - 1].at,
      messages: recent.map((m) => ({ id: m.providerId, dir: m.direction, at: m.at, source: m.source, body: m.body })),
      insights: insights.filter((i) => i.phoneKey === phoneKey).slice(0, 3).map((i) => ({ lastInboundId: i.lastInboundId, intent: i.intent, summary: i.summary, proposedReply: i.proposedReply, ownerReply: i.ownerReply, agreement: i.agreement })),
    });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt).slice(offset, offset + limit);
}

async function upsertInsights(userId, items) {
  let saved = 0; const rejected = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, 100)) {
    const phoneKey = last10(it.phoneKey || it.phone);
    const lastInboundId = it.lastInboundId == null ? '' : String(it.lastInboundId);
    if (phoneKey.length !== 10 || !lastInboundId) { rejected.push({ lastInboundId, why: 'phoneKey and lastInboundId required' }); continue; }
    // an insight must point at a message we really stored: never accept a made-up id
    const msg = await prisma.commMessage.findFirst({ where: { userId, channel: CH, phoneKey, direction: 'in', providerId: lastInboundId }, select: { id: true, jobberClientId: true } });
    if (!msg) { rejected.push({ lastInboundId, why: 'no such inbound TextNow message' }); continue; }
    const has = (k) => it[k] !== undefined && it[k] !== null;
    const data = { jobberClientId: msg.jobberClientId };
    if (has('intent')) data.intent = INTENTS.includes(it.intent) ? it.intent : 'other';
    if (has('confidence')) data.confidence = Math.min(1, Math.max(0, Number(it.confidence) || 0));
    if (has('summary')) data.summary = clip(it.summary, 500);
    if (has('proposedReply')) data.proposedReply = clip(it.proposedReply, 600);
    if (it.proposedAction && typeof it.proposedAction === 'object' && JSON.stringify(it.proposedAction).length <= 2000) data.proposedAction = it.proposedAction;
    const key = { userId_channel_lastInboundId: { userId, channel: CH, lastInboundId } };
    const existing = await prisma.commInsight.findUnique({ where: key });
    if (!existing) await prisma.commInsight.create({ data: { userId, channel: CH, phoneKey, lastInboundId, intent: 'other', ...data } });
    else {
      // a re-grade or a photo note sends only what changed; the Claude re-grade is the only thing allowed to change a scored row
      if (existing.ownerReply != null && ['match', 'partial', 'miss'].includes(it.agreement)) data.agreement = it.agreement;
      await prisma.commInsight.update({ where: { id: existing.id }, data });
    }
    saved++;
  }
  return { saved, rejected };
}

async function scoreShadow({ userId }) {
  const open = await prisma.commInsight.findMany({ where: { userId, channel: CH, ownerReply: null, createdAt: { gte: new Date(Date.now() - 21 * 86400000) } }, take: 200 });
  let scored = 0;
  for (const ins of open) {
    const inbound = await prisma.commMessage.findFirst({ where: { userId, channel: CH, direction: 'in', providerId: ins.lastInboundId }, select: { at: true } });
    if (!inbound) continue;
    const out = await prisma.commMessage.findFirst({ where: { userId, channel: CH, direction: 'out', phoneKey: ins.phoneKey, at: { gt: inbound.at } }, orderBy: { at: 'asc' } });
    if (out) {
      await prisma.commInsight.update({ where: { id: ins.id }, data: { ownerReply: out.body.slice(0, 600), ownerReplyAt: out.at, agreement: agreementScore(ins.proposedReply, out.body) } });
      scored++;
    } else if (!ins.proposedReply && Date.now() - inbound.at.getTime() > 48 * 3600 * 1000) {
      // we would have said nothing and the owner said nothing either
      await prisma.commInsight.update({ where: { id: ins.id }, data: { ownerReply: '', agreement: 'match' } });
      scored++;
    }
  }
  return { items_found: open.length, summary: scored ? `Scored ${scored} TextNow draft(s) against the owner's replies` : 'Nothing new to score', actions_taken: scored ? [`Scored ${scored} shadow draft(s)`] : [] };
}

const READY_MIN_CASES = 20;
const READY_MIN_PCT = 0.9;

async function getReadiness(userId) {
  const rows = await prisma.commInsight.findMany({ where: { userId, channel: CH, agreement: { not: null } }, select: { intent: true, agreement: true } });
  const routine = await getRoutine(userId, INSIGHT_SLUG);
  const levels = routine?.config?.intentAutonomy || {};
  return INTENTS.map((intent) => {
    const r = rows.filter((x) => x.intent === intent);
    const match = r.filter((x) => x.agreement === 'match').length; const partial = r.filter((x) => x.agreement === 'partial').length;
    const pct = r.length ? Math.round(((match + partial * 0.5) / r.length) * 100) / 100 : null;
    return { intent, cases: r.length, match, partial, miss: r.length - match - partial, pct, ready: r.length >= READY_MIN_CASES && pct >= READY_MIN_PCT, level: levels[intent] || 'read' };
  }).filter((x) => x.cases > 0 || x.level !== 'read');
}

// ---------------------------------------------------------------------------------------------
// Digest: always stored; texted only when digestEveryDays has passed (default 2)
// ---------------------------------------------------------------------------------------------
async function recordDigest(userId, { summary, sms }) {
  const routine = await getRoutine(userId, INSIGHT_SLUG);
  const cfg = routine?.config || {};
  const every = Math.min(14, Math.max(1, Number(cfg.digestEveryDays) || 2));
  const now = new Date();
  await patchConfig(userId, INSIGHT_SLUG, { lastDigest: { at: now, summary: clip(summary, 3000) } });
  await autoEnable(userId, INSIGHT_SLUG);

  const hoursSince = cfg.lastDigestSmsAt ? (now - new Date(cfg.lastDigestSmsAt)) / 3600000 : Infinity;
  const due = hoursSince >= every * 24 - 3;   // 3 h of slack so a run that drifts a little later each day is not skipped
  const h = localHour(now);
  let texted = false;
  if (sms && due && h >= 8 && h < 21) {
    const { stripToGsm7 } = require('../services/smsService');
    const r = await require('../services/operatorService').notifyOwner(userId, stripToGsm7(String(sms)).slice(0, 320));
    texted = !!(r && (r.ok || r.dryRun));
    if (texted) await patchConfig(userId, INSIGHT_SLUG, { lastDigestSmsAt: now });
  }
  await notify(userId, { category: 'digest', title: 'TextNow summary', body: String(summary || '').slice(0, 1000), routineSlug: INSIGHT_SLUG, link: '/ai.html', alreadySent: texted });
  return { stored: true, texted, digestEveryDays: every };
}

async function getStatus(userId) {
  const [watch, insight, convs, count] = await Promise.all([
    getRoutine(userId, WATCH_SLUG), getRoutine(userId, INSIGHT_SLUG),
    getConversationStates(userId, { sinceDays: 14, channel: CH }),
    prisma.commMessage.count({ where: { userId, channel: CH, at: { gte: new Date(Date.now() - 7 * 86400000) } } }),
  ]);
  const wcfg = watch?.config || {};
  const waiting = convs.filter((c) => NEEDS_US.has(c.state));
  return {
    health: wcfg.health || 'unknown', healthDetail: wcfg.healthDetail || null, lastSyncAt: wcfg.lastSyncAt || null, lastSeenAt: wcfg.lastSeenAt || null,
    messages7d: count, waiting: waiting.length, urgent: waiting.filter((c) => c.urgency === 'urgent').length,
    oldestWaitingMinutes: waiting.reduce((m, c) => Math.max(m, c.waitingMinutes || 0), 0),
    lastDigest: insight?.config?.lastDigest || null, digestEveryDays: insight?.config?.digestEveryDays || 2,
  };
}

module.exports = {
  INTENTS, HEALTH_STATES, MEDIA_MARK, WATCH_SLUG, INSIGHT_SLUG,
  urgentCheck, agreementScore, ingestMessages, getCursor, setHealth, getThreads, upsertInsights, scoreShadow, getReadiness, recordDigest, getStatus,
};
