/**
 * Routine Registry — the single list of everything that runs for the business.
 * Backend schedulers are seeded as-is (their cron strings live in the services; this file only
 * DESCRIBES them). Claude routines on claude.ai are registered here by externalId so the dashboard
 * shows them next to the backend jobs; they report in via POST /api/ai/runs.
 *
 * seedRegistry() is idempotent: it refreshes descriptive fields but never overwrites owner-controlled
 * state (enabled, autonomy) or run history.
 */
const prisma = require('../lib/prismaClient');

const pollEvery = Number(process.env.POLL_INTERVAL_MINUTES) || 120;

const BACKEND = [
  { slug: 'jobber-token-refresh', name: 'Token refresh', agent: 'system', schedule: 'Every 5 min', category: 'integrations',
    purpose: 'Refreshes Jobber, Gmail and Google (SEO) OAuth tokens before they expire.', expectedEveryMinutes: 30, config: { quiet: true, files: ['services/tokenManager.js'] } },
  { slug: 'review-delivery-queue', name: 'Review request delivery', agent: 'communication', schedule: 'Every minute', category: 'reviews',
    purpose: 'Sends the SMS/email Google-review request once a paid invoice has waited REVIEW_DELAY_MINUTES.', expectedEveryMinutes: 15, config: { quiet: true, files: ['services/deliveryQueue.js'] } },
  { slug: 'review-followup-email', name: 'Review follow-up email', agent: 'communication', schedule: 'Every minute', category: 'reviews',
    purpose: 'Sends the 24h follow-up email to clients who got a review request and have an email.', expectedEveryMinutes: 15, config: { quiet: true, files: ['services/deliveryQueue.js'] } },
  { slug: 'jobber-invoice-poller', name: 'Paid-invoice poller', agent: 'operations', schedule: `Every ${pollEvery} min`, category: 'reviews',
    purpose: 'Backstop for missed Jobber webhooks: finds recently paid invoices and queues review requests.', expectedEveryMinutes: pollEvery * 2 + 30, config: { files: ['services/invoicePoller.js'] } },
  { slug: 'jobber-client-sync', name: 'Jobber client sync', agent: 'operations', schedule: 'Every 4 h at :15', category: 'integrations',
    purpose: 'Mirrors Jobber clients into the local cache used by SMS marketing, inbound matching and customer context.', expectedEveryMinutes: 600, config: { files: ['services/jobberClientSync.js'] } },
  { slug: 'weather-morning-rain-check', name: 'Morning rain check', agent: 'operations', schedule: 'Daily 5:30 am', category: 'weather',
    purpose: 'Checks the forecast and texts the owner a reschedule recommendation (YES <day> to approve).', expectedEveryMinutes: 2160, approvalRequired: true, config: { files: ['services/weatherService.js'] } },
  { slug: 'seo-weekly-audit', name: 'Weekly SEO audit', agent: 'research', schedule: 'Sunday 8:00 am', category: 'seo',
    purpose: 'PageSpeed + Search Console + competitor scrape, then a Claude-written proposal for the owner to approve.', expectedEveryMinutes: 10080, approvalRequired: true, researchEnabled: true, config: { files: ['services/seoService.js'] } },
  { slug: 'operator-proposal-expiry', name: 'Approval expiry', agent: 'system', schedule: 'Every 10 min', category: 'approvals',
    purpose: 'Expires approval requests the owner never answered.', expectedEveryMinutes: 60, config: { quiet: true, files: ['services/operatorService.js'] } },
  { slug: 'marketing-sms-retry-worker', name: 'SMS retry + stalled-campaign sweep', agent: 'communication', schedule: 'Every minute', category: 'sms',
    purpose: 'Re-sends transiently failed campaign texts and resumes campaigns that stalled mid-send.', expectedEveryMinutes: 15, config: { quiet: true, files: ['services/marketingService.js'] } },
  { slug: 'sms-monitor', name: 'Customer-waiting monitor (SMS)', agent: 'communication', schedule: 'Every 10 min', category: 'inbox',
    purpose: 'Finds customers whose last text has no human reply, keeps one task per conversation, escalates with age and texts the owner once.', expectedEveryMinutes: 60, config: { quiet: true, files: ['ai/smsMonitor.js'] } },
  { slug: 'comm-ledger-reconcile', name: 'Twilio log reconcile', agent: 'communication', schedule: 'Hourly', category: 'inbox',
    purpose: 'Adds texts sent from our number outside the app (Twilio console or other tools) to the ledger so answered threads are not shown as waiting.', expectedEveryMinutes: 240, config: { quiet: true, files: ['ai/smsMonitor.js'] } },
  { slug: 'owner-daily-digest', name: 'Daily summary text to the owner', agent: 'orchestrator', schedule: 'Daily 5:00 pm', category: 'inbox',
    purpose: 'The only text sent to the owner: one daily summary of money questions held, customers waiting 4h+ and failing routines (nothing if nothing needs them).', expectedEveryMinutes: 2160, config: { quiet: true, files: ['ai/digest.js'] } },
  { slug: 'pricing-learner', name: 'Price learner', agent: 'research', schedule: 'Daily 2:15 am', category: 'learning', learningEnabled: true,
    purpose: 'Learns what the business actually charges from the owner\'s own texts (min / median / max per service) so replies can eventually quote it.', expectedEveryMinutes: 2160, config: { quiet: true, files: ['ai/learning/pricing.js'] } },
  { slug: 'routine-heartbeat', name: 'Routine heartbeat', agent: 'system', schedule: 'Every 15 min', category: 'ai-os',
    purpose: 'Flags any routine that should have reported but has gone quiet (e.g. a Claude routine blocked by the plan limit).', expectedEveryMinutes: 60, config: { quiet: true, files: ['ai/heartbeat.js'] } },
];

// Claude routines on claude.ai. expectedEveryMinutes stays null (unmonitored) until the routine's prompt
// is updated to POST its result to /api/ai/runs — then set it so the heartbeat can catch silence.
const EXTERNAL = [
  { slug: 'ext-overnight-revenue-runner', externalId: 'trig_01F1GE1hYhhngGqydHjUVrbq', name: 'Overnight Revenue Runner', agent: 'operations', kind: 'claude_cloud', schedule: 'Daily 10:00 UTC (5 am Winnipeg)', category: 'money',
    purpose: 'Ranks stale quotes, overdue invoices and stuck jobs; emails the owner a short brief.' },
  { slug: 'ext-weekly-cash-flow', externalId: 'trig_01HZAuqQUXaD84WanyzdhA59', name: 'Weekly Cash Flow Snapshot', agent: 'operations', kind: 'claude_cloud', schedule: 'Fri 14:00 UTC', category: 'money',
    purpose: 'Cash on hand, receivables, unbilled drafts, supplier bills and YTD P&L from Jobber + QuickBooks.' },
  { slug: 'ext-payroll-prep', externalId: 'trig_01B3jQvDBqRuG3TMZopgEHux', name: 'Payroll Prep - Crew Hours', agent: 'operations', kind: 'claude_cloud', schedule: 'Thu 13:00 UTC (acts every 2nd Friday cycle)', category: 'money',
    purpose: 'Gathers crew hours from Jobber and Jibble, flags manual entries; hours only, never pay amounts.' },
  { slug: 'ext-month-end-invoice-prep', externalId: 'trig_01RGWxrYQhWT8gjd8uJBWpxw', name: 'Month-End Invoice Prep', agent: 'operations', kind: 'claude_cloud', schedule: '26th 13:00 UTC', category: 'money',
    purpose: 'Draft invoices, requires_invoicing jobs and conflicting/past-due invoices before month end.' },
  { slug: 'ext-daily-stale-visit-check', externalId: 'trig_01YB5Q53p62iqy4wPKFtxbT5', name: 'Daily Stale Visit Check', agent: 'operations', kind: 'claude_cloud', schedule: 'Daily 13:00 UTC (acts Mon / 27th / month-end)', category: 'money', autonomy: 'execute',
    purpose: 'Marks stale Jobber visits complete (owner-approved) and escalates unbilled work via the FlagLog.' },
  { slug: 'ext-gbp-review-check', externalId: 'trig_01VtmVDD4P1j4ZtXW9D2NLkm', name: 'Weekly Google Business Profile Review Check', agent: 'communication', kind: 'claude_cloud', schedule: 'Sat 12:00 UTC', category: 'reviews', autonomy: 'execute',
    purpose: 'Auto-replies to 5-star reviews; drafts replies for lower ratings for the owner to approve.' },
  { slug: 'ext-invoicing-digest', externalId: 'trig_01KN7t8v1qjruCHNshV3B3jV', name: 'Weekly Invoicing and Payments Digest', agent: 'operations', kind: 'claude_cloud', schedule: 'Sat 12:00 UTC', category: 'money',
    purpose: 'Past-due, draft and conflicting invoices plus payments received this week.' },
  { slug: 'ext-weekly-email-review', externalId: 'trig_01LSHEhwqm2UrmKyePzVXaAG', name: 'Weekly Email Review', agent: 'communication', kind: 'claude_cloud', schedule: 'Sat 12:00 UTC', category: 'inbox', autonomy: 'execute',
    purpose: 'Finds overlooked client emails in Inbox and Spam, labels them and rescues genuine ones from Spam.' },
  { slug: 'ext-night-studio', name: 'Night Studio (content + design)', agent: 'content', kind: 'claude_cloud', schedule: 'Daily 1:00 am Winnipeg', category: 'content', autonomy: 'execute', enabled: false, researchEnabled: true,
    purpose: 'Researches a timely topic, writes copy, renders on-brand graphics with the design system, QA-checks and queues posts. Prompt: ai/prompts/night-studio.md' },
  { slug: 'ext-inbox-watch', name: 'Inbox Watch (SMS + Gmail)', agent: 'communication', kind: 'claude_cloud', schedule: '3x daily (8:00, 13:00, 18:00 Winnipeg)', category: 'inbox', autonomy: 'draft', enabled: false,
    purpose: 'Triages unanswered texts and emails, drafts replies as tasks, records hidden operational info. Prompt: ai/prompts/inbox-watch.md' },
  { slug: 'ext-social-mac', name: 'Social shifts (Claude app on the Mac, MSI Chrome)', agent: 'social', kind: 'claude_desktop', schedule: '6:15 am and 7:30 pm Winnipeg', category: 'social', autonomy: 'execute', expectedEveryMinutes: 780,
    purpose: 'Publishes the queue, replies to comments and DMs, posts in groups and records metrics through Claude in Chrome (Browser 2), within server-enforced daily caps.' },
  { slug: 'ext-social-daily', externalId: 'trig_01JL7wxcDHNL3wRYrY8yiGMY', name: 'No-Bs social media daily (Claude in Chrome)', agent: 'social', kind: 'claude_desktop', schedule: 'Daily 7:45 am Winnipeg (MSI PC)', category: 'social', autonomy: 'execute', enabled: false,
    purpose: 'Facebook + Instagram inbox, leads, groups, stories and weekly content using Claude in Chrome.' },
];

async function upsertDef(userId, d, defaults) {
  const base = {
    name: d.name, kind: d.kind || defaults.kind, agent: d.agent, category: d.category || 'operations',
    purpose: d.purpose, schedule: d.schedule, expectedEveryMinutes: d.expectedEveryMinutes ?? null,
    approvalRequired: !!d.approvalRequired, researchEnabled: !!d.researchEnabled, externalId: d.externalId || null,
  };
  const existing = await prisma.routine.findUnique({ where: { userId_slug: { userId, slug: d.slug } } });
  if (existing) {
    // keep owner-controlled state; merge config so a manually-set value (e.g. reporting:true) survives
    const config = { ...(d.config || {}), ...(existing.config || {}) };
    return prisma.routine.update({ where: { id: existing.id }, data: { ...base, expectedEveryMinutes: existing.expectedEveryMinutes ?? base.expectedEveryMinutes, config } });
  }
  try {
    return await prisma.routine.create({
      data: { userId, slug: d.slug, ...base, enabled: d.enabled ?? true, autonomy: d.autonomy || (defaults.kind === 'backend' ? 'execute' : 'approve'), config: { reporting: defaults.kind === 'backend', ...(d.config || {}) } },
    });
  } catch (err) {
    if (err.code !== 'P2002') throw err;       // a scheduler's first run created the row between our read and write
    const row = await prisma.routine.findUnique({ where: { userId_slug: { userId, slug: d.slug } } });
    return prisma.routine.update({ where: { id: row.id }, data: { ...base, config: { ...(d.config || {}), ...(row.config || {}) } } });
  }
}

async function seedRegistry(userId) {
  for (const d of BACKEND) await upsertDef(userId, d, { kind: 'backend' });
  for (const d of EXTERNAL) await upsertDef(userId, d, { kind: 'claude_cloud' });
}

const ALL_DEFS = [...BACKEND, ...EXTERNAL];
module.exports = { seedRegistry, BACKEND, EXTERNAL, ALL_DEFS };
