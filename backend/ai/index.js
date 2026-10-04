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

// Lazy requires: services pull in ai/runner, so requiring them at module load would be circular.
const RUNNABLE = {
  'jobber-token-refresh':       { risk: 'safe',     fn: () => require('../services/tokenManager').tokenRefreshTick() },
  'jobber-client-sync':         { risk: 'safe',     fn: () => require('../services/jobberClientSync').clientSyncTick() },
  'jobber-invoice-poller':      { risk: 'queues',   fn: () => require('../services/invoicePoller').pollTick() },
  'operator-proposal-expiry':   { risk: 'safe',     fn: async () => { const n = await require('../services/operatorService').expirePendingProposals(); return { items_found: n }; } },
  'routine-heartbeat':          { risk: 'safe',     fn: (ctx) => heartbeatTick(ctx) },
  'sms-monitor':                { risk: 'texts-owner', fn: (ctx) => smsMonitorTick(ctx) },
  'comm-ledger-reconcile':      { risk: 'safe',     fn: (ctx) => reconcileTwilioTick(ctx) },
  'review-delivery-queue':      { risk: 'sends',    fn: () => require('../services/deliveryQueue').processPendingReviews() },
  'weather-morning-rain-check': { risk: 'texts-owner', fn: () => require('../services/weatherService').morningCheckTick() },
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
    console.log('[ai] Routine registry ready');

    const beat = () => runRoutine('routine-heartbeat', (ctx) => heartbeatTick(ctx), { quiet: true });
    cron.schedule('*/15 * * * *', beat);
    setTimeout(beat, 90_000); // grace after boot so freshly-started schedulers can report first
    const sms = () => runRoutine('sms-monitor', (ctx) => smsMonitorTick(ctx), { quiet: true });
    cron.schedule('*/10 * * * *', sms);
    setTimeout(sms, 150_000);
    const recon = () => runRoutine('comm-ledger-reconcile', (ctx) => reconcileTwilioTick(ctx), { quiet: true });
    cron.schedule('40 * * * *', recon);
    setTimeout(recon, 120_000);
    // first boot after the ledger shipped: import existing inbound + sent history once
    require('../lib/prismaClient').commMessage.count({ where: { userId } })
      .then((n) => (n === 0 ? require('../lib/commLedger').backfillComm(userId).then((k) => console.log(`[ai] Comm ledger backfilled (${k} messages)`)) : null))
      .catch((e) => console.warn('[ai] ledger backfill failed:', e.message));
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
