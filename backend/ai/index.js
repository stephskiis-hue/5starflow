/**
 * AI OS bootstrap + manual-run table.
 *   startAiOs()  — seeds the registry, starts the heartbeat (every 15 min) and daily housekeeping.
 *   RUNNABLE     — slug → existing job function, so "Run now" calls the SAME code path as the cron.
 */
const cron = require('node-cron');
const { runRoutine } = require('./runner');
const { resolveOwnerId } = require('./owner');
const { seedRegistry } = require('./registry');
const { heartbeatTick, pruneOld } = require('./heartbeat');
const { smsMonitorTick, reconcileTwilioTick } = require('./smsMonitor');
const { digestTick, digestDue } = require('./digest');
const { pricingTick } = require('./learning/pricing');

// Lazy requires: services pull in ai/runner, so requiring them at module load would be circular.
const RUNNABLE = {
  'jobber-token-refresh':       { risk: 'safe',     fn: () => require('../services/tokenManager').tokenRefreshTick() },
  'jobber-client-sync':         { risk: 'safe',     fn: () => require('../services/jobberClientSync').clientSyncTick() },
  'jobber-invoice-poller':      { risk: 'queues',   fn: () => require('../services/invoicePoller').pollTick() },
  'operator-proposal-expiry':   { risk: 'safe',     fn: async () => { const n = await require('../services/operatorService').expirePendingProposals(); return { items_found: n }; } },
  'pricing-learner':            { risk: 'safe',     fn: (ctx) => pricingTick(ctx) },
  'routine-heartbeat':          { risk: 'safe',     fn: (ctx) => heartbeatTick(ctx) },
  'sms-monitor':                { risk: 'safe',     fn: (ctx) => smsMonitorTick(ctx) },
  'textnow-shadow-score':       { risk: 'safe',     fn: (ctx) => require('./textnow').scoreShadow(ctx) },
  'owner-daily-digest':         { risk: 'texts-owner', fn: (ctx) => digestTick(ctx) },
  'comm-ledger-reconcile':      { risk: 'safe',     fn: (ctx) => reconcileTwilioTick(ctx) },
  'vault-drive-import':         { risk: 'safe',     fn: (ctx) => require('./driveImport').driveImportTick(ctx) },
  'review-delivery-queue':      { risk: 'sends',    fn: () => require('../services/deliveryQueue').processPendingReviews() },
  'weather-morning-rain-check': { risk: 'texts-owner', fn: () => require('../services/weatherService').morningCheckTick() },
  'seo-gsc-sync':               { risk: 'safe',     fn: (ctx) => require('./seo/sync').gscSyncTick(ctx) },
  'seo-index-watch':            { risk: 'safe',     fn: (ctx) => require('./seo/indexWatch').indexWatchTick(ctx) },
  'seo-roadmap':                { risk: 'spends',   fn: (ctx) => require('./seo/roadmap').roadmapTick(ctx) },
  'site-publish-index':         { risk: 'safe',     fn: (ctx) => require('./site/tick').siteIndexTick(ctx) },
  'morning-note':               { risk: 'texts-owner', fn: (ctx) => require('./morningNote').morningNoteTick(ctx) },
  'seo-weekly-audit':           { risk: 'spends',   fn: async () => { const r = await require('../services/seoService').runWeeklyAudit(); if (r?.error) throw new Error(`SEO audit failed: ${r.error}`); return r || { skipped: true, summary: 'Audit did not run' }; } },
};

let started = false;

async function startAiOs() {
  if (started) return;
  started = true;
  try {
    const userId = await resolveOwnerId();
    if (!userId) { console.warn('[ai] No owner user yet (create the first admin) — AI OS idle until restart.'); started = false; return; }
    await seedRegistry(userId);
    // weekly now: the old daily expectation would make the heartbeat flag it as missed
    await require('../lib/prismaClient').routine.updateMany({ where: { userId, slug: 'owner-daily-digest', expectedEveryMinutes: { not: null } }, data: { expectedEveryMinutes: null } }).catch(() => {});
    console.log('[ai] Routine registry ready');

    const beat = () => runRoutine('routine-heartbeat', (ctx) => heartbeatTick(ctx), { quiet: true });
    cron.schedule('*/15 * * * *', beat);
    setTimeout(beat, 90_000); // grace after boot so freshly-started schedulers can report first
    const sms = () => runRoutine('sms-monitor', (ctx) => smsMonitorTick(ctx), { quiet: true });
    cron.schedule('*/10 * * * *', sms);
    cron.schedule('50 * * * *', () => runRoutine('textnow-shadow-score', (ctx) => require('./textnow').scoreShadow(ctx), { quiet: true }));
    setTimeout(sms, 150_000);
    // hourly check: the run only happens in the day/hour the owner chose (default Saturday 3 pm)
    cron.schedule('0 * * * *', async () => { try { if (await digestDue(userId)) await runRoutine('owner-daily-digest', (ctx) => digestTick(ctx), { quiet: true }); } catch (e) { console.warn('[ai] weekly digest check failed:', e.message); } });
    // before the Night Studio, so new Drive photos are waiting for it to curate
    cron.schedule('30 1 * * *', () => runRoutine('vault-drive-import', (ctx) => require('./driveImport').driveImportTick(ctx)), { timezone: 'America/Winnipeg' });
    cron.schedule('15 2 * * *', () => runRoutine('pricing-learner', (ctx) => pricingTick(ctx), { quiet: true }), { timezone: 'America/Winnipeg' });
    const recon = () => runRoutine('comm-ledger-reconcile', (ctx) => reconcileTwilioTick(ctx), { quiet: true });
    cron.schedule('40 * * * *', recon);
    setTimeout(recon, 120_000);
    // first boot after the ledger shipped: import existing inbound + sent history once
    require('../lib/prismaClient').commMessage.count({ where: { userId } })
      .then((n) => (n === 0 ? require('../lib/commLedger').backfillComm(userId).then((k) => console.log(`[ai] Comm ledger backfilled (${k} messages)`)) : null))
      .catch((e) => console.warn('[ai] ledger backfill failed:', e.message));
    // SEO Growth Engine: Search Console data first, then the crawl/index check, roadmap + Serper weekly
    cron.schedule('7 6 * * *', () => runRoutine('seo-gsc-sync', (ctx) => require('./seo/sync').gscSyncTick(ctx), { maxRuntimeMinutes: 30 }), { timezone: 'America/Winnipeg' });
    cron.schedule('23 6 * * *', () => runRoutine('seo-index-watch', (ctx) => require('./seo/indexWatch').indexWatchTick(ctx), { maxRuntimeMinutes: 30 }), { timezone: 'America/Winnipeg' });
    cron.schedule('15 6 * * *', () => runRoutine('site-publish-index', (ctx) => require('./site/tick').siteIndexTick(ctx), { maxRuntimeMinutes: 20 }), { timezone: 'America/Winnipeg' });
    cron.schedule('30 5 * * *', () => runRoutine('morning-note', (ctx) => require('./morningNote').morningNoteTick(ctx), { quiet: true }), { timezone: 'America/Winnipeg' });
    cron.schedule('37 6 * * 1', () => runRoutine('seo-roadmap', (ctx) => require('./seo/roadmap').roadmapTick(ctx), { maxRuntimeMinutes: 30 }), { timezone: 'America/Winnipeg' });
    // first boot with the engine: crawl, seed + import the existing posts, pull Search Console
    setTimeout(async () => {
      try {
        const prisma = require('../lib/prismaClient');
        if (await prisma.seoPage.count({ where: { userId } }) === 0) {
          await runRoutine('seo-index-watch', (ctx) => require('./seo/indexWatch').indexWatchTick(ctx), { trigger: 'manual', maxRuntimeMinutes: 30 });
          await runRoutine('seo-roadmap', (ctx) => require('./seo/roadmap').roadmapTick(ctx), { trigger: 'manual', maxRuntimeMinutes: 30 });
        }
        const row = await prisma.seoSettings.findUnique({ where: { userId } });
        if (!row?.growthState?.lastSyncAt) await runRoutine('seo-gsc-sync', (ctx) => require('./seo/sync').gscSyncTick(ctx), { trigger: 'manual', maxRuntimeMinutes: 30 });
      } catch (e) { console.warn('[ai] SEO bootstrap failed:', e.message); }
    }, 5 * 60_000);
    cron.schedule('20 3 * * *', async () => {
      const r = await pruneOld(userId).catch((e) => ({ error: e.message }));
      console.log('[ai] housekeeping', JSON.stringify(r));
    }, { timezone: 'America/Winnipeg' });
  } catch (err) {
    started = false;
    console.error('[ai] startup failed:', err.message);
  }
}

module.exports = { startAiOs, RUNNABLE };
