/**
 * zapierClient — thin wrapper for dispatching operator actions to Zapier Catch Hooks.
 *
 * All channel URLs are configured in Railway env vars:
 *   ZAPIER_FB_POST_URL         → Facebook Pages "Create Post"
 *   ZAPIER_IG_POST_URL         → Instagram "Publish Photo"
 *   ZAPIER_GBP_POST_URL        → Google Business Profile "Create Post"
 *   ZAPIER_GMAIL_URL           → Gmail "Send Email"
 *   ZAPIER_SHEET_LOG_URL       → Google Sheet audit log (EVERY dispatch is mirrored here)
 *   ZAPIER_GBP_REVIEWS_PULL_URL → GET-equivalent hook that returns GBP reviews (for reviews-watch)
 *
 * DRY_RUN=true short-circuits every send (no network call, returns synthetic success).
 */

const logger = require('../lib/logger');

const CHANNEL_URL_ENV = {
  fb:    'ZAPIER_FB_POST_URL',
  ig:    'ZAPIER_IG_POST_URL',
  gbp:   'ZAPIER_GBP_POST_URL',
  gmail: 'ZAPIER_GMAIL_URL',
  log:   'ZAPIER_SHEET_LOG_URL',
};

// Retryable HTTP conditions — network flakiness or Zapier 5xx transient issues.
const MAX_ATTEMPTS   = 3;
const BACKOFF_BASE_MS = 750;
const REQUEST_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envUrlFor(channel) {
  const key = CHANNEL_URL_ENV[channel];
  if (!key) return null;
  const url = process.env[key];
  return url && url.trim() ? url.trim() : null;
}

/**
 * Low-level POST with retry. Used by every higher-level helper.
 * Returns { ok, status, body, attempts, durationMs, error? }.
 */
async function postJson(url, payload, { userId, channel } = {}) {
  const start = Date.now();
  let   lastErr = null;
  let   attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload || {}),
        signal:  ctrl.signal,
      });
      clearTimeout(timer);

      const text = await res.text().catch(() => '');
      const durationMs = Date.now() - start;

      if (res.ok) {
        await logger.info('zapier', `POST ok (${channel || 'raw'}, ${res.status})`, {
          channel, status: res.status, attempt, durationMs,
        }, userId);
        return { ok: true, status: res.status, body: text, attempts: attempt, durationMs };
      }

      // Retry on 5xx / 429. Permanent 4xx fails immediately.
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        lastErr = new Error(`Zapier ${res.status}: ${text.slice(0, 300)}`);
        await logger.warn('zapier', `POST transient ${res.status} — retrying`, {
          channel, status: res.status, attempt, bodyPreview: text.slice(0, 300),
        }, userId);
      } else {
        await logger.error('zapier', `POST permanent ${res.status}`, {
          channel, status: res.status, attempt, bodyPreview: text.slice(0, 300), durationMs,
        }, userId);
        return { ok: false, status: res.status, body: text, attempts: attempt, durationMs, error: `HTTP ${res.status}` };
      }
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      await logger.warn('zapier', `POST error attempt ${attempt}: ${err.message}`, {
        channel, attempt, errorName: err.name,
      }, userId);
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));  // 750, 1500, 3000
    }
  }

  return {
    ok:         false,
    attempts:   attempt,
    durationMs: Date.now() - start,
    error:      lastErr?.message || 'Unknown zapier error',
  };
}

/**
 * Mirror every dispatch to the Google Sheet audit log (best-effort, non-blocking).
 * Swallows errors — log failures must never block a real action.
 */
async function mirrorToAuditLog(entry) {
  const url = envUrlFor('log');
  if (!url) return; // audit log optional
  try {
    await postJson(url, { ...entry, at: new Date().toISOString() }, { channel: 'log' });
  } catch { /* swallow */ }
}

/**
 * Post to a social channel (fb/ig/gbp) or a generic Zapier hook.
 * payload shape (agreed with Zapier zap field mapping):
 *   { caption, hashtags?, mediaUrls?, targetUrl?, title?, kind? }
 *
 * Returns { ok, status?, body?, error?, dryRun? }.
 */
async function post(channel, payload, ctx = {}) {
  const { userId, proposalId } = ctx;
  const url = envUrlFor(channel);
  if (!url) {
    return { ok: false, error: `No Zapier URL configured for channel=${channel} (set env ${CHANNEL_URL_ENV[channel] || '?'})` };
  }

  const enriched = { ...(payload || {}), channel, proposalId };

  if (process.env.DRY_RUN === 'true') {
    console.log(`[zapier] DRY RUN — would POST to ${channel} (${url.slice(0, 60)}...):`, JSON.stringify(enriched).slice(0, 300));
    await mirrorToAuditLog({ channel, proposalId, userId, dryRun: true, payloadPreview: JSON.stringify(enriched).slice(0, 500) });
    return { ok: true, dryRun: true, status: 200 };
  }

  const result = await postJson(url, enriched, { userId, channel });
  await mirrorToAuditLog({
    channel, proposalId, userId,
    ok: result.ok, status: result.status, error: result.error,
    attempts: result.attempts, durationMs: result.durationMs,
  });
  return result;
}

/**
 * Send an email via the Zapier Gmail hook.
 * payload: { to, subject, bodyHtml | bodyText, replyTo?, cc?, bcc? }
 */
async function email(payload, ctx = {}) {
  return post('gmail', payload, ctx);
}

module.exports = {
  post,
  email,
  envUrlFor,
  CHANNEL_URL_ENV,
};
