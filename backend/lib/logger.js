/**
 * Structured logger — persists every notable event to the AppLog table
 * (and mirrors to console so existing stdout tail in Railway still works).
 *
 * Usage:
 *   const logger = require('../lib/logger');
 *   await logger.info('sms', 'SMS sent', { campaignId, phone, sid, attempts, durationMs }, userId);
 *   await logger.warn('sms', 'Transient Twilio 5xx — will retry', { campaignId, phone, errorCode });
 *   await logger.error('campaign', 'Dispatch crashed', { campaignId, message: err.message });
 *
 * Categories: sms | email | campaign | webhook | jobber | weather | auth | server | seo
 * Levels:     info | warn | error
 *
 * All writes are best-effort — if the DB is down the logger swallows the write
 * error so logging never takes down the caller.
 */

const prisma = require('./prismaClient');

function consoleTag(level, category) {
  const prefix = `[${category}]`;
  if (level === 'error') return (msg) => console.error(prefix, msg);
  if (level === 'warn')  return (msg) => console.warn(prefix, msg);
  return (msg) => console.log(prefix, msg);
}

// Trim large payloads so we don't blow up the DB with megabyte JSON blobs.
function sanitizeContext(ctx) {
  if (!ctx) return null;
  try {
    const serialized = JSON.stringify(ctx);
    if (serialized.length > 10_000) {
      return { _truncated: true, preview: serialized.slice(0, 9_500) };
    }
    return ctx;
  } catch {
    return { _unserializable: true };
  }
}

async function log(level, category, message, context = null, userId = null) {
  const msgStr  = typeof message === 'string' ? message : String(message);
  const ctx     = sanitizeContext(context);
  const write   = consoleTag(level, category);

  // Mirror to console first — even if DB write fails, we still have the line in Railway logs
  const consoleLine = ctx
    ? `${msgStr} ${JSON.stringify(ctx)}`
    : msgStr;
  write(consoleLine);

  try {
    await prisma.appLog.create({
      data: {
        userId,
        category,
        level,
        message: msgStr.slice(0, 2000),
        context: ctx || undefined,
      },
    });
  } catch (err) {
    // Never let logging take down the caller — just note on console
    console.warn(`[logger] DB write failed (${category}/${level}):`, err.message);
  }
}

module.exports = {
  info:  (category, message, context, userId) => log('info',  category, message, context, userId),
  warn:  (category, message, context, userId) => log('warn',  category, message, context, userId),
  error: (category, message, context, userId) => log('error', category, message, context, userId),
  log,
};
