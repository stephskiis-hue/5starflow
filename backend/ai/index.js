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

// Lazy requires: services pull in ai/runner, so requiring them at module load would be circular.
const RUNNABLE = {
  'jobber-token-refresh':       { risk: 'safe',     fn: () => require('../services/tokenManager').tokenRefreshTick() },
  'jobber-client-sync':         { risk: 'safe',     fn: () => require('../services/jobberClientSync').clientSyncTick() },
  'jobber-invoice-poller':      { risk: 'queues',   fn: () => require('../services/invoicePoller').pollTick() },
  'operator-proposal-expiry':   { risk: 'safe',     fn: async () => { const n = await require('../services/operatorService').expirePendingProposals(); return { items_found: n }; } },
  'routine-heartbeat':          { risk: 'safe',     fn: (ctx) => heartbeatTick(ctx) },
  'review-delivery-queue':      { risk: 'sends',    fn: () => require('../services/deliveryQueue').processPendingReviews() },
  'weather-morning-rain-check': { risk: 'texts-owner', fn: () => require('../services/weatherService').morningCheckTick() },
  'seo-weekly-audit':           { risk: 'spends',   fn: async () => { await require('../services/seoService').runWeeklyAudit(); return { summary: 'Audit started' }; } },
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
