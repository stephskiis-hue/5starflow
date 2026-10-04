/**
 * Owner notifications. Everything lands in the Notification Centre (index.html) and the weekly summary;
 * only `urgent` items are texted right away (and only if the owner left urgent texts on).
 */
const prisma = require('./prismaClient');

const DEFAULTS = { digestMode: 'weekly', digestDay: 6, digestHour: 15, urgentSms: true };

async function getSettings(userId) {
  const row = await prisma.notificationSettings.findUnique({ where: { userId } }).catch(() => null);
  return { ...DEFAULTS, ...(row || {}) };
}

/**
 * @param {string} userId
 * @param {{category?:string,title:string,body?:string,urgent?:boolean,routineSlug?:string,link?:string,smsText?:string,alreadySent?:boolean}} n
 *   smsText: text to send when urgent (defaults to title + body). alreadySent: the caller texted it itself; just record it.
 */
async function notify(userId, n) {
  if (!userId || !n?.title) return null;
  const urgent = !!n.urgent;
  let sentVia = n.alreadySent ? 'sms' : 'none';
  try {
    if (urgent && !n.alreadySent && process.env.OWNER_SMS !== 'off' && (await getSettings(userId)).urgentSms) {
      const { stripToGsm7 } = require('../services/smsService');
      const text = stripToGsm7(n.smsText || `${n.title}${n.body ? `: ${n.body}` : ''}`).slice(0, 320);
      const r = await require('../services/operatorService').notifyOwner(userId, text);
      if (r && (r.ok || r.dryRun)) sentVia = 'sms';
    }
    return await prisma.notification.create({
      data: {
        userId, category: n.category || 'system', title: String(n.title).slice(0, 200), body: String(n.body || '').slice(0, 1000),
        urgency: urgent ? 'urgent' : 'normal', routineSlug: n.routineSlug || null, link: n.link || null, sentVia,
      },
    });
  } catch (e) {
    console.warn(`[notify] failed: ${e.message}`);
    return null;
  }
}

module.exports = { notify, getSettings, DEFAULTS };
