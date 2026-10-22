/**
 * Winnipeg Fence Pros scheduler (business timezone). Every job goes through wfp/runner.runJob and skips quietly
 * until the page has what it needs, so a fresh install does nothing.
 *   daily  7:17  gsc-sync   Search Console numbers, keyword rescore
 *   Monday 7:37  research   keyword research, Serper discovery + rank tracking, recommendations
 *   daily  8:05  health     setup / FTP / sitemap / posts / Search Console checks
 * The writing is done by the Claude routine on claude.ai (wfp/prompts/blog-writer.md), which asks GET /api/wfp/assignment
 * and hands the post in with POST /api/wfp/publish. Nothing here calls an AI model.
 */
const cron = require('node-cron');
const { runJob } = require('./runner');

const TZ = process.env.BUSINESS_TZ || 'America/Winnipeg';

const JOBS = {
  'gsc-sync': (ctx) => require('./research').gscSyncTick(ctx),
  research: (ctx) => require('./research').researchTick(ctx),
  health: (ctx) => require('./health').healthTick(ctx),
  'migrate-wordpress': (ctx, opts) => require('./migrate').migrateTick(ctx, opts),
};

const run = (job, trigger = 'schedule', opts = {}) => runJob(job, (ctx) => JOBS[job](ctx, opts), { trigger });

let started = false;
function startWfp() {
  if (started || process.env.WFP_DISABLED === 'true') return;
  started = true;
  cron.schedule('17 7 * * *', () => run('gsc-sync'), { timezone: TZ });
  cron.schedule('37 7 * * 1', () => run('research'), { timezone: TZ });
  cron.schedule('5 8 * * *', () => run('health'), { timezone: TZ });
  // first boot with Search Console set up: pull the numbers and research once instead of waiting for Monday
  setTimeout(async () => {
    try {
      const prisma = require('../lib/prismaClient');
      if (await prisma.wfpDaily.count() === 0) {
        const r = await run('gsc-sync');
        if (r.run?.status === 'completed' && await prisma.wfpKeyword.count() === 0) await run('research');
      }
    } catch (e) { console.warn('[wfp] first sync failed:', e.message); }
  }, 4 * 60 * 1000);
  console.log('[wfp] Winnipeg Fence Pros scheduler started');
}

module.exports = { startWfp, run, JOBS };
