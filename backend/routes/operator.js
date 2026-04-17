/**
 * Operator API — internal endpoints called by Claude /schedule runs.
 *
 * Auth: Bearer token via OPERATOR_TOKEN env var (NOT session auth — these are
 * hit by a scheduled job, not a browser). Every request must carry:
 *   Authorization: Bearer <OPERATOR_TOKEN>
 *
 * userId: single-tenant operator — the Claude scheduled run serves exactly one
 * portal user (Steph). That user's id comes from env OPERATOR_USER_ID. Every
 * operator endpoint scopes queries to this userId.
 *
 * Endpoints:
 *   GET  /api/operator/state                       — today's jobs, requests, invoices, pending proposals, weather, inbound SMS
 *   POST /api/operator/propose                     — create an OperatorProposal
 *   GET  /api/operator/pending-executions          — approved-but-not-executed proposals
 *   POST /api/operator/execute/:id                 — dispatch an approved proposal to Zapier/etc.
 *   POST /api/operator/send-pending-sms            — batch all pending proposals into one SMS
 *   GET  /api/operator/inbound-commands-since-last — slash commands from Steph's approver phone
 *   GET  /api/operator/seo-data                    — Search Console + Serper pull for weekly audit
 *   GET  /api/operator/day-close                   — completed jobs + invoicing for evening-wrap
 *   POST /api/operator/apply-site-changes/:id      — record applied SEO site changes via Claude
 */

const express = require('express');
const router  = express.Router();

const prisma  = require('../lib/prismaClient');
const logger  = require('../lib/logger');
const op      = require('../services/operatorService');
const { jobberGraphQL } = require('../services/jobberClient');
const { sendSmsSafely, toE164, getTwilioCreds } = require('../services/smsService');
const twilio  = require('twilio');

// ---------------------------------------------------------------------------
// Auth middleware — Bearer OPERATOR_TOKEN + OPERATOR_USER_ID resolution.
// ---------------------------------------------------------------------------
function requireOperatorAuth(req, res, next) {
  const expected = process.env.OPERATOR_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'OPERATOR_TOKEN not configured on server' });
  }
  const hdr = req.headers.authorization || '';
  const m   = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== expected) {
    return res.status(401).json({ error: 'Invalid or missing bearer token' });
  }

  const userId = process.env.OPERATOR_USER_ID;
  if (!userId) {
    return res.status(503).json({ error: 'OPERATOR_USER_ID not configured on server' });
  }
  req.operatorUserId = userId;
  next();
}

router.use(express.json({ limit: '1mb' }));
router.use(requireOperatorAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return { startUtc, endUtc } for a local calendar date in a named IANA tz.
 * Uses Intl parts to avoid pulling in a tz library.
 */
function dayBoundsInTz(dateStr /* YYYY-MM-DD */, tz /* e.g. America/Winnipeg */) {
  // Build a Date for "midnight in tz" by asking Intl what UTC offset that zone
  // has at the given local midnight. Good enough for DST boundaries because we
  // only use it to bracket "today" for ground-truth queries.
  const [y, m, d] = dateStr.split('-').map(Number);
  // Trial UTC midnight, then correct by the tz offset at that instant.
  const trial     = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const fmt       = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(trial).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMs = trial.getTime() - asUtc;
  const startUtc = new Date(trial.getTime() + offsetMs);
  const endUtc   = new Date(startUtc.getTime() + 24 * 3600 * 1000);
  return { startUtc, endUtc };
}

function todayInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts; // en-CA yields YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// GET /api/operator/state
// The shared preamble's step 2 — a single fetch for current business state.
// ---------------------------------------------------------------------------
router.get('/state', async (req, res) => {
  const userId = req.operatorUserId;
  const tz     = req.query.tz || 'America/Winnipeg';
  const today  = todayInTz(tz);
  const { startUtc, endUtc } = dayBoundsInTz(today, tz);

  const state = { today, tz, todayScheduled: [], newRequests24h: [], overdueInvoices: [], pendingProposals: [], inboundSmsSinceLast: [], weather: null, errors: [] };

  // Jobber data (ground truth for jobs/requests/invoices). Every failure is
  // recorded in state.errors so the Claude run can still produce useful output.
  // Uses `visits` (confirmed working in weatherService.js) — NOT scheduledItems.
  // Invoices fetched without filter, then sliced client-side (invoiceStatus is
  // NOT a valid filter arg per CLAUDE.md, only a return field).
  try {
    const q = `
      query OperatorState($start: ISO8601DateTime!, $end: ISO8601DateTime!) {
        visits(first: 50, filter: { startAt: { after: $start, before: $end } }) {
          nodes {
            id
            title
            startAt
            endAt
            client { id name firstName }
            job { jobNumber title }
          }
          totalCount
        }
        requests(first: 25) {
          nodes { id title createdAt client { id name } }
          totalCount
        }
        invoices(first: 50) {
          nodes {
            id invoiceNumber invoiceStatus issuedDate dueDate
            amounts { total depositAmount outstandingAmount }
            client { id name firstName }
          }
          totalCount
        }
      }
    `;
    const rangeStart = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const data = await jobberGraphQL(q, { start: startUtc.toISOString(), end: endUtc.toISOString() }, userId);

    state.todayScheduled = (data?.visits?.nodes || []).filter(Boolean);

    state.newRequests24h = (data?.requests?.nodes || [])
      .filter((r) => r?.createdAt && new Date(r.createdAt) >= new Date(rangeStart));

    const now = new Date();
    state.overdueInvoices = (data?.invoices?.nodes || []).filter((inv) => {
      if (!inv) return false;
      if (inv.invoiceStatus !== 'awaiting_payment' && inv.invoiceStatus !== 'past_due') return false;
      const out = inv.amounts?.outstandingAmount;
      if (!out || Number(out) <= 0) return false;
      if (!inv.dueDate) return false;
      const days = (now - new Date(inv.dueDate)) / (24 * 3600 * 1000);
      return days > 0;
    });
  } catch (err) {
    state.errors.push({ source: 'jobber', message: err.message });
  }

  // Pending proposals — the Claude run can see what's still waiting for approval.
  try {
    state.pendingProposals = await op.listPendingForUser(userId);
  } catch (err) {
    state.errors.push({ source: 'proposals', message: err.message });
  }

  // Inbound SMS since the most recent proposal SMS was sent — gives the run a
  // window of what Steph has replied to / sent commands for.
  try {
    const lastSmsAt = await prisma.operatorProposal.findFirst({
      where:   { userId, smsSentAt: { not: null } },
      orderBy: { smsSentAt: 'desc' },
      select:  { smsSentAt: true },
    });
    const since = lastSmsAt?.smsSentAt || new Date(Date.now() - 6 * 3600 * 1000);
    state.inboundSmsSinceLast = await prisma.inboundSMS.findMany({
      where:   { userId, receivedAt: { gte: since } },
      orderBy: { receivedAt: 'asc' },
      take:    100,
    });
  } catch (err) {
    state.errors.push({ source: 'inboundSms', message: err.message });
  }

  // Most recent WeatherCheck (already written by weatherScheduler).
  try {
    state.weather = await prisma.weatherCheck.findFirst({
      where:   { userId },
      orderBy: { checkedAt: 'desc' },
    });
  } catch (err) {
    state.errors.push({ source: 'weather', message: err.message });
  }

  res.json(state);
});

// ---------------------------------------------------------------------------
// POST /api/operator/propose
// Body: { category, tier, summary, payload, ttlHours? }
// ---------------------------------------------------------------------------
router.post('/propose', async (req, res) => {
  const userId = req.operatorUserId;
  const { category, tier, summary, payload, ttlHours } = req.body || {};

  const VALID_CAT  = ['ad', 'seo', 'client_recovery', 'social_post', 'quote', 'email', 'review_response', 'other'];
  const VALID_TIER = ['auto', 'approval_required'];
  if (!VALID_CAT.includes(category))  return res.status(400).json({ error: `category must be one of ${VALID_CAT.join('|')}` });
  if (!VALID_TIER.includes(tier))     return res.status(400).json({ error: `tier must be one of ${VALID_TIER.join('|')}` });
  if (!summary || typeof summary !== 'string') return res.status(400).json({ error: 'summary required (string)' });

  try {
    const row = await op.createProposal({ userId, category, tier, summary, payload, ttlHours });
    res.json({ ok: true, proposal: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/operator/pending-executions
// Approved proposals (either auto-tier or YES'd) that haven't been dispatched yet.
// ---------------------------------------------------------------------------
router.get('/pending-executions', async (req, res) => {
  const userId = req.operatorUserId;
  try {
    const rows = await op.listApprovedUnexecuted(userId);
    res.json({ proposals: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/operator/execute/:id
// Dispatch an approved proposal. Safe to call repeatedly — executeProposal
// is idempotent on executedAt.
// ---------------------------------------------------------------------------
router.post('/execute/:id', async (req, res) => {
  const userId = req.operatorUserId;
  const id     = req.params.id;

  const proposal = await prisma.operatorProposal.findUnique({ where: { id } });
  if (!proposal)                     return res.status(404).json({ error: 'Proposal not found' });
  if (proposal.userId !== userId)    return res.status(403).json({ error: 'Proposal belongs to a different user' });

  try {
    const result = await op.executeProposal(id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/operator/send-pending-sms
// Batch every approval_required proposal that hasn't had its SMS sent into ONE
// SMS. Keeps Steph from getting 5 texts per run. Returns { sent, skipped, sid? }.
// ---------------------------------------------------------------------------
router.post('/send-pending-sms', async (req, res) => {
  const userId = req.operatorUserId;

  const pending = await prisma.operatorProposal.findMany({
    where: {
      userId,
      tier:      'approval_required',
      status:    'pending',
      smsSentAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (pending.length === 0) return res.json({ sent: 0, skipped: 0 });

  // Build one combined SMS. Hard cap: 3 segments ~= 480 chars. Anything past
  // that is trimmed and the remaining codes get appended as a bare list.
  const lines = pending.map((p) => `#${p.shortCode}: ${p.summary}`);
  const codes = pending.map((p) => p.shortCode).join(' ');
  let body = `🌱 ${pending.length} to review:\n${lines.join('\n')}\nReply YES ${codes} or NO ${codes}`;
  if (body.length > 480) {
    // Fall back to terse mode: just codes + summaries trimmed.
    const tight = pending.map((p) => `#${p.shortCode}: ${p.summary.slice(0, 50)}`);
    body = `🌱 ${pending.length} to review:\n${tight.join('\n')}\nReply YES/NO <code>`;
    if (body.length > 480) body = body.slice(0, 477) + '...';
  }

  const creds   = await getTwilioCreds(userId).catch(() => null);
  const credRow = await prisma.twilioCredential.findUnique({ where: { userId } }).catch(() => null);
  const toRaw   = credRow?.notifyPhone || process.env.OPERATOR_APPROVER_PHONE;

  if (!toRaw)               return res.status(503).json({ error: 'No approver phone configured' });
  if (!creds?.accountSid)   return res.status(503).json({ error: 'Twilio credentials missing for user' });

  const to = toE164(toRaw);

  if (process.env.DRY_RUN === 'true') {
    console.log(`[operator] DRY RUN — would batch SMS to ${to}: "${body.slice(0, 200)}..."`);
    await prisma.operatorProposal.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data:  { smsSentAt: new Date(), smsMessageSid: 'dry-run-batch' },
    });
    return res.json({ sent: pending.length, skipped: 0, dryRun: true });
  }

  const client = twilio(creds.accountSid, creds.authToken);
  const result = await sendSmsSafely({ to, from: creds.fromNumber, body, client, userId });

  if (result.ok) {
    await prisma.operatorProposal.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data:  { smsSentAt: new Date(), smsMessageSid: result.sid },
    });
    await logger.info('operator', `Batched approval SMS for ${pending.length} proposals`, {
      count: pending.length, sid: result.sid,
    }, userId);
    return res.json({ sent: pending.length, skipped: 0, sid: result.sid });
  }

  await logger.error('operator', 'Batch approval SMS failed', {
    count: pending.length, errorCode: result.errorCode, errorMessage: result.errorMessage,
  }, userId);
  return res.status(502).json({ error: result.errorMessage || 'Twilio send failed', errorCode: result.errorCode });
});

// ---------------------------------------------------------------------------
// GET /api/operator/inbound-commands-since-last?sinceMinutes=130
// Returns inbound SMS from Steph's approver phone that start with /post, /quote,
// /save, or /note. Pulse uses this to catch commands between runs.
// ---------------------------------------------------------------------------
router.get('/inbound-commands-since-last', async (req, res) => {
  const userId       = req.operatorUserId;
  const sinceMinutes = Math.max(1, Math.min(1440, parseInt(req.query.sinceMinutes, 10) || 130));
  try {
    const rows = await op.listInboundCommandsSinceLast({ userId, sinceMinutes });
    res.json({ commands: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/operator/seo-data
// Aggregates Search Console + recent PageSpeed history for the Monday audit.
// The run calls Serper itself (API key lives client-side in Claude run), but
// this gives it the "what we already know" snapshot.
// ---------------------------------------------------------------------------
router.get('/seo-data', async (req, res) => {
  const userId = req.operatorUserId;
  const out = { seoSettings: null, latestAudit: null, recentPageSpeed: [], recentAuditPages: [] };
  try {
    out.seoSettings = await prisma.seoSettings.findUnique({ where: { userId } });
    out.latestAudit = await prisma.seoAudit.findFirst({
      where: { userId }, orderBy: { runAt: 'desc' },
    });
    out.recentPageSpeed = await prisma.pageSpeedHistory.findMany({
      where: { userId }, orderBy: { runAt: 'desc' }, take: 10,
    });
    out.recentAuditPages = await prisma.auditPage.findMany({
      where: { userId }, orderBy: { updatedAt: 'desc' }, take: 20,
      select: { id: true, path: true, filename: true, auditScore: true, seoScore: true, perfScore: true, auditIssuesJson: true, pageUrl: true, updatedAt: true },
    });
  } catch (err) {
    out.error = err.message;
  }
  res.json(out);
});

// ---------------------------------------------------------------------------
// GET /api/operator/day-close?date=YYYY-MM-DD&tz=America/Winnipeg
// Evening wrap ground-truth: scheduled vs completed, invoicing totals,
// tomorrow preview, expiring proposals tonight.
// ---------------------------------------------------------------------------
router.get('/day-close', async (req, res) => {
  const userId = req.operatorUserId;
  const tz     = req.query.tz   || 'America/Winnipeg';
  const date   = req.query.date || todayInTz(tz);
  const { startUtc, endUtc } = dayBoundsInTz(date, tz);

  const tomorrow = new Date(new Date(date + 'T00:00:00Z').getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { startUtc: tomorrowStart, endUtc: tomorrowEnd } = dayBoundsInTz(tomorrow, tz);

  const out = {
    date, tz,
    todayScheduled: [], todayCompleted: [], todayInvoiced: [], todayInvoiceTotal: 0,
    todayQuotedHoursVsActual: [],
    tomorrowScheduled: [],
    pendingProposals: [], expiringTonight: [],
    errors: [],
  };

  try {
    // `visits` is the confirmed-working field for scheduled work (weatherService.js uses it).
    // Invoices use no server-side filter (invoiceStatus/issuedDate aren't guaranteed filter
    // args per CLAUDE.md) — we slice client-side by issuedDate.
    const q = `
      query DayClose($start: ISO8601DateTime!, $end: ISO8601DateTime!, $tStart: ISO8601DateTime!, $tEnd: ISO8601DateTime!) {
        today: visits(first: 50, filter: { startAt: { after: $start, before: $end } }) {
          nodes {
            id title startAt endAt
            client { name }
            job { jobNumber title }
          }
        }
        tomorrow: visits(first: 50, filter: { startAt: { after: $tStart, before: $tEnd } }) {
          nodes {
            id title startAt
            client { name firstName }
          }
        }
        invoices(first: 50) {
          nodes {
            id invoiceNumber issuedDate invoiceStatus
            amounts { total }
            client { name }
          }
        }
      }
    `;
    const data = await jobberGraphQL(q, {
      start:  startUtc.toISOString(),
      end:    endUtc.toISOString(),
      tStart: tomorrowStart.toISOString(),
      tEnd:   tomorrowEnd.toISOString(),
    }, userId);

    const todayVisits   = (data?.today?.nodes    || []).filter(Boolean);
    out.todayScheduled  = todayVisits;
    // Jobber's `visits` doesn't carry a completedAt field in all plans — the Claude
    // run correlates completion via the Job's jobStatus. We surface all of today's
    // visits here and let the run decide.
    out.todayCompleted  = [];
    out.tomorrowScheduled = (data?.tomorrow?.nodes || []).filter(Boolean);

    const allInvs = (data?.invoices?.nodes || []).filter(Boolean);
    const invs    = allInvs.filter((i) => {
      if (!i.issuedDate) return false;
      const d = new Date(i.issuedDate);
      return d >= startUtc && d < endUtc;
    });
    out.todayInvoiced     = invs;
    out.todayInvoiceTotal = invs.reduce((s, i) => s + Number(i.amounts?.total || 0), 0);

    // Quoted-vs-actual: raw scheduled duration per visit. The Claude run pulls
    // actual tracked hours via its own Jobber calls if deeper signal is needed.
    out.todayQuotedHoursVsActual = todayVisits
      .filter((v) => v.startAt && v.endAt)
      .map((v) => ({
        visitId:      v.id,
        jobNumber:    v.job?.jobNumber,
        scheduledMin: Math.round((new Date(v.endAt) - new Date(v.startAt)) / 60000),
      }));
  } catch (err) {
    out.errors.push({ source: 'jobber', message: err.message });
  }

  try {
    out.pendingProposals = await op.listPendingForUser(userId);
    out.expiringTonight  = out.pendingProposals.filter((p) => {
      const expires = new Date(p.expiresAt);
      return expires > new Date() && expires < tomorrowStart;
    });
  } catch (err) {
    out.errors.push({ source: 'proposals', message: err.message });
  }

  res.json(out);
});

// ---------------------------------------------------------------------------
// POST /api/operator/apply-site-changes/:id
// Called by the weekly-site-audit run AFTER Claude has already edited local
// files in C:\...\Website Stuff\public_html. This endpoint just records the
// change set against the proposal and (optionally) flips status to executed.
//
// Body: { files: [{ filePath, oldContent, newContent, description }], pushed?: bool }
// ---------------------------------------------------------------------------
router.post('/apply-site-changes/:id', async (req, res) => {
  const userId = req.operatorUserId;
  const id     = req.params.id;
  const { files, pushed } = req.body || {};

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files[] required (non-empty)' });
  }

  const proposal = await prisma.operatorProposal.findUnique({ where: { id } });
  if (!proposal)                  return res.status(404).json({ error: 'Proposal not found' });
  if (proposal.userId !== userId) return res.status(403).json({ error: 'Proposal belongs to a different user' });
  if (proposal.category !== 'seo') return res.status(400).json({ error: 'apply-site-changes is only valid for category=seo proposals' });

  // We piggy-back on the existing SeoChange table rather than invent a new one.
  // A lightweight SeoProposal anchor is created if not already present — keeps
  // the SEO dashboard listing these alongside existing SEO runs.
  let seoProposal = await prisma.seoProposal.findFirst({
    where: { userId, title: `operator:${proposal.shortCode}` },
  });
  if (!seoProposal) {
    seoProposal = await prisma.seoProposal.create({
      data: {
        auditId:     'operator-run',
        userId,
        status:      'approved',
        title:       `operator:${proposal.shortCode}`,
        summaryJson: JSON.stringify(files.map((f) => ({ fix: f.description || '', fileTarget: f.filePath }))),
        respondedAt: new Date(),
      },
    });
  }

  const rows = await prisma.$transaction(files.map((f) => prisma.seoChange.create({
    data: {
      proposalId:  seoProposal.id,
      filePath:    String(f.filePath || ''),
      oldContent:  String(f.oldContent || ''),
      newContent:  String(f.newContent || ''),
      description: String(f.description || ''),
      status:      pushed ? 'applied' : 'pending',
      userId,
      appliedAt:   pushed ? new Date() : null,
    },
  })));

  // Mark the operator proposal as executed (the real edits already happened on disk).
  await prisma.operatorProposal.update({
    where: { id },
    data:  {
      status:     'executed',
      executedAt: new Date(),
      result:     { changeCount: rows.length, seoProposalId: seoProposal.id, pushed: !!pushed },
    },
  });
  await logger.info('operator', `Applied ${rows.length} site changes for proposal #${proposal.shortCode}`, {
    proposalId: id, seoProposalId: seoProposal.id, pushed: !!pushed,
  }, userId);

  res.json({ ok: true, changeCount: rows.length, seoProposalId: seoProposal.id });
});

module.exports = router;
