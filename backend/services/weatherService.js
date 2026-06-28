const cron    = require('node-cron');
const axios   = require('axios');
const nodemailer = require('nodemailer');
const twilio  = require('twilio');
const prisma  = require('../lib/prismaClient');
const { jobberGraphQL } = require('./jobberClient');
const { getTwilioCreds } = require('./smsService');
const { getGmailCreds, ensureFreshToken } = require('./emailService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Jobber GraphQL — fetch all clients with tags, phone, email (paginated)
// ---------------------------------------------------------------------------
// NOTE: `first:` is required on ALL connections — without it Jobber assumes 100
// nodes per level, pushing requestedQueryCost past the 10,000 pt maximum.
const GET_ALL_CLIENTS = `
  query GetAllClients($cursor: String) {
    clients(first: 50, after: $cursor) {
      nodes {
        id
        name
        firstName
        emails { address primary }
        phones { number primary smsAllowed }
        tags(first: 10) { nodes { label } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ADD_CLIENT_TAG = `
  mutation AddClientTag($clientId: EncodedId!, $label: String!) {
    clientTagCreate(clientId: $clientId, label: $label) {
      tag { id label }
      errors { message path }
    }
  }
`;

const WEEKLY_VISITS_QUERY = `
  query WeeklyVisits($start: ISO8601DateTime!, $end: ISO8601DateTime!, $cursor: String) {
    visits(filter: { startAt: { after: $start, before: $end } }, first: 100, after: $cursor) {
      nodes {
        id
        title
        startAt
        endAt
        client {
          id
          name
          firstName
          emails { address primary }
          phones { number primary smsAllowed }
        }
        job {
          property {
            address {
              street
              city
              province
              postalCode
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const EDIT_VISIT_SCHEDULE_MUTATION = `
  mutation EditVisitSchedule(
    $id: EncodedId!,
    $startDate: ISO8601Date!,
    $startTime: ISO8601Time,
    $timezone: Timezone!
  ) {
    visitEditSchedule(id: $id, input: {
      startAt: { date: $startDate, time: $startTime, timezone: $timezone }
    }) {
      visit { id startAt endAt }
      userErrors { message path }
    }
  }
`;

// Fetch all Jobber clients in one paginated pass. Internal — used by getOpenDays().
async function fetchAllClients(userId) {
  const allClients = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await jobberGraphQL(GET_ALL_CLIENTS, { cursor }, userId);
    const nodes    = data?.clients?.nodes    ?? [];
    const pageInfo = data?.clients?.pageInfo ?? {};
    allClients.push(...nodes);
    hasNext = pageInfo.hasNextPage;
    cursor  = pageInfo.endCursor ?? null;
    if (hasNext) await sleep(500);
  }
  return allClients;
}

/**
 * Fetch Jobber visits within a date range (e.g. today → +7 days).
 * Returns visits with client contact info for SMS/email.
 */
async function fetchWeekVisits(userId, startDate, endDate) {
  // Use Winnipeg CDT (UTC-5) for boundary times so a job at 8 AM local is never missed
  const start = new Date(startDate + 'T00:00:00-05:00').toISOString();
  const end   = new Date(endDate   + 'T23:59:59-05:00').toISOString();

  const allNodes = [];
  let cursor  = null;
  let hasNext = true;

  while (hasNext) {
    // Errors propagate to caller — do NOT silently swallow them here
    const data     = await jobberGraphQL(WEEKLY_VISITS_QUERY, { start, end, cursor }, userId);
    const nodes    = data?.visits?.nodes    ?? [];
    const pageInfo = data?.visits?.pageInfo ?? {};
    allNodes.push(...nodes);
    hasNext = pageInfo.hasNextPage;
    cursor  = pageInfo.endCursor ?? null;
    if (hasNext) await sleep(500);
  }

  return allNodes.map((v) => {
    const primaryPhone = v.client?.phones?.find((p) => p.primary) ?? v.client?.phones?.[0] ?? null;
    const primaryEmail = v.client?.emails?.find((e) => e.primary) ?? v.client?.emails?.[0] ?? null;
    const addr = v.job?.property?.address;
    return {
      id:         v.id,
      title:      v.title || 'Visit',
      startAt:    v.startAt,
      endAt:      v.endAt || null,
      clientId:   v.client?.id    || null,
      clientName: v.client?.name  || 'Unknown',
      firstName:  v.client?.firstName || (v.client?.name || 'there').split(' ')[0],
      phone:      primaryPhone?.number    ?? null,
      smsAllowed: primaryPhone?.smsAllowed ?? false,
      email:      primaryEmail?.address   ?? null,
      address:    addr ? [addr.street, addr.city].filter(Boolean).join(', ') : null,
    };
  });
}

/**
 * Move a Jobber visit to a new date, preserving the original time-of-day.
 * Uses visitEditSchedule with LocalDateTimeAttributes { date, time, timezone }.
 */
async function rescheduleJobberVisit(visitId, newStartAt, newEndAt, userId) {
  const d = new Date(newStartAt);
  const localTime = d.toLocaleTimeString('en-GB', { timeZone: 'America/Winnipeg', hour12: false });
  // Jobber "Anytime" visits come back as midnight local — preserve that by sending null,
  // otherwise Jobber pins them to 12:00 AM with a 2-hour duration.
  const isAnytime = localTime === '00:00:00';
  const vars = {
    id:        visitId,
    startDate: d.toLocaleDateString('en-CA', { timeZone: 'America/Winnipeg' }),
    startTime: isAnytime ? null : localTime,
    timezone:  'Central Time (US & Canada)',
  };

  console.log('[reschedule] vars:', JSON.stringify(vars));
  const data   = await jobberGraphQL(EDIT_VISIT_SCHEDULE_MUTATION, vars, userId);
  const result = data?.visitEditSchedule;
  console.log('[reschedule] result:', JSON.stringify(result));

  if (!result) throw new Error('visitEditSchedule returned no data');
  if (result.userErrors?.length) throw new Error(result.userErrors.map((e) => e.message).join('; '));
  return result.visit;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns "monday", "tuesday", etc. for a given Date (default today).
 */
function getDayTag(date = new Date()) {
  return date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
}

/**
 * Converts a date string or Date to "YYYY-MM-DD" in local time.
 */
function toDateString(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 10);
}

/**
 * Formats a YYYY-MM-DD string as "Tuesday, March 18".
 */
function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00'); // noon avoids DST edge cases
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Map common abbreviations / typos to canonical weekday names.
const WEEKDAY_ALIASES = {
  sun: 'sunday', mon: 'monday', tue: 'tuesday', tues: 'tuesday', wed: 'wednesday',
  weds: 'wednesday', thu: 'thursday', thur: 'thursday', thurs: 'thursday',
  fri: 'friday', sat: 'saturday',
};

/**
 * Resolve a weekday name (e.g. "wednesday") to the soonest FUTURE date (YYYY-MM-DD)
 * matching that weekday, in Winnipeg local time. Always at least tomorrow.
 */
function nextWeekdayDate(dayName, from = new Date()) {
  const target = WEEKDAYS.indexOf(String(dayName || '').toLowerCase());
  if (target < 0) return null;
  // Walk forward 1..7 days until the weekday matches.
  for (let i = 1; i <= 7; i++) {
    const d = new Date(from);
    d.setDate(from.getDate() + i);
    if (d.getDay() === target) return toDateString(d);
  }
  return null;
}

/**
 * Parse an owner's free-text reply to a rain recommendation.
 * Examples: "yes wednesday", "Y thurs", "yes", "no", "nope".
 * Returns { intent: 'yes'|'no'|null, day: 'wednesday'|null }.
 */
function parseRainReply(body) {
  const text = String(body || '').toLowerCase().trim();
  if (!text) return { intent: null, day: null };

  let intent = null;
  if (/\b(yes|yep|yeah|yup|ya|sure|ok|okay|y)\b/.test(text)) intent = 'yes';
  if (/\b(no|nope|nah|n|keep|cancel)\b/.test(text)) intent = 'no'; // explicit no wins
  if (/\b(no|nope|nah|n|keep|cancel)\b/.test(text) && !/\b(yes|yep|yeah|yup|ya|sure|ok|okay|y)\b/.test(text)) intent = 'no';

  // Find a weekday anywhere in the text (full name or alias).
  let day = null;
  for (const w of WEEKDAYS) { if (text.includes(w)) { day = w; break; } }
  if (!day) {
    for (const [alias, full] of Object.entries(WEEKDAY_ALIASES)) {
      if (new RegExp(`\\b${alias}\\b`).test(text)) { day = full; break; }
    }
  }
  if (!day && /\btomorrow\b/.test(text)) {
    day = WEEKDAYS[new Date(Date.now() + 86400000).getDay()];
  }

  return { intent, day };
}

/**
 * Normalize phone to E.164 for Twilio.
 */
function toE164(raw, countryCode = '1') {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+${countryCode}${digits}`;
  if (digits.length === 11 && digits.startsWith(countryCode)) return `+${digits}`;
  return `+${countryCode}${digits}`;
}

/**
 * Load WeatherSettings from DB for a specific user.
 * Creates a default row if none exists.
 *
 * @param {string|null} userId
 */
async function getSettings(userId) {
  const where = userId ? { userId } : { userId: null };
  let settings = await prisma.weatherSettings.findFirst({ where });
  if (!settings) {
    settings = await prisma.weatherSettings.create({ data: userId ? { userId } : {} });
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Weather API
// ---------------------------------------------------------------------------

/**
 * Fetch 5-day / 3-hour forecast from OpenWeatherMap for a city.
 * Returns the raw list of forecast entries.
 */
async function getForecast(city) {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key) throw new Error('OPENWEATHER_API_KEY not set in .env');

  const url = 'https://api.openweathermap.org/data/2.5/forecast';
  const res = await axios.get(url, {
    params: { q: city, appid: key, units: 'metric' },
    timeout: 10000,
  });

  return res.data.list; // 40 entries: 5 days × 8 three-hour slots
}

/**
 * Map forecast entries to a simplified per-day summary for the next 7 days.
 */
function buildDaySummaries(forecastList) {
  const byDay = {};

  for (const entry of forecastList) {
    const dateStr = new Date(entry.dt * 1000).toISOString().slice(0, 10);
    if (!byDay[dateStr]) {
      byDay[dateStr] = { date: dateStr, pops: [], temps: [], conditions: [] };
    }
    byDay[dateStr].pops.push(entry.pop ?? 0);
    byDay[dateStr].temps.push(entry.main?.temp ?? 0);
    if (entry.weather?.[0]) byDay[dateStr].conditions.push(entry.weather[0]);
  }

  return Object.values(byDay)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 7)
    .map((d) => {
      const maxPop  = Math.max(...d.pops);
      const maxTemp = Math.max(...d.temps);
      const condition = d.conditions.reduce((best, c) => {
        // Prioritize rain conditions in the summary
        if (!best) return c;
        const rainWords = ['rain', 'drizzle', 'thunderstorm', 'snow'];
        const cIsRain   = rainWords.some((w) => c.main.toLowerCase().includes(w));
        const bIsRain   = rainWords.some((w) => best.main.toLowerCase().includes(w));
        return cIsRain && !bIsRain ? c : best;
      }, null);

      return {
        date:        d.date,
        dayName:     getDayTag(new Date(d.date + 'T12:00:00')),
        maxPop,                       // 0.0–1.0
        maxPopPct:   Math.round(maxPop * 100),
        maxTemp:     Math.round(maxTemp),
        condition:   condition?.main        ?? 'Unknown',
        description: condition?.description ?? '',
        icon:        condition?.icon        ?? '',
        rainExpected: maxPop >= 0.4,
      };
    });
}

/**
 * Check if rain is expected TODAY during business hours.
 * Reads settings for threshold and business hours.
 */
async function checkRainToday(settings) {
  const city      = settings?.city              || process.env.WEATHER_CITY || 'Winnipeg';
  const threshold = settings?.rainThreshold     ?? 0.4;
  const startH    = settings?.businessStartHour ?? 7;
  const endH      = settings?.businessEndHour   ?? 18;

  const forecastList = await getForecast(city);
  const todayStr     = toDateString();

  // Filter to today's entries within business hours
  const todayEntries = forecastList.filter((entry) => {
    const d = new Date(entry.dt * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    const hour    = d.getUTCHours(); // OWM timestamps are UTC
    return dateStr === todayStr && hour >= startH && hour <= endH;
  });

  if (todayEntries.length === 0) {
    // No entries for today in business hours — use any today entries
    const anyToday = forecastList.filter((e) =>
      new Date(e.dt * 1000).toISOString().slice(0, 10) === todayStr
    );
    todayEntries.push(...anyToday);
  }

  const pops       = todayEntries.map((e) => e.pop ?? 0);
  const maxPop     = pops.length ? Math.max(...pops) : 0;
  const rainExpected = maxPop >= threshold;

  // Build human-readable summary
  let summary = rainExpected
    ? `Rain likely during business hours (${Math.round(maxPop * 100)}% peak probability)`
    : `No significant rain expected (${Math.round(maxPop * 100)}% peak probability)`;

  const daySummaries = buildDaySummaries(forecastList);

  return { rainExpected, maxPop, maxPopPct: Math.round(maxPop * 100), summary, daySummaries };
}

// ---------------------------------------------------------------------------
// Jobber client fetch
// ---------------------------------------------------------------------------

/**
 * Fetch all Jobber clients and filter by day tag (e.g., "monday").
 * Returns clients with phone/email contact info.
 */
async function getClientsByTag(dayTag, userId) {
  const tag = dayTag.toLowerCase().trim();
  const allClients = await fetchAllClients(userId);

  return allClients
    .filter((c) => c.tags?.nodes?.some((t) => t.label.toLowerCase() === tag))
    .map((c) => {
      const primaryPhone = c.phones?.find((p) => p.primary) ?? c.phones?.[0] ?? null;
      const primaryEmail = c.emails?.find((e) => e.primary) ?? c.emails?.[0] ?? null;
      return {
        id:         c.id,
        name:       c.name,
        firstName:  c.firstName || c.name.split(' ')[0],
        phone:      primaryPhone?.number   ?? null,
        smsAllowed: primaryPhone?.smsAllowed ?? false,
        email:      primaryEmail?.address  ?? null,
      };
    });
}

/**
 * For each of the next `daysAhead` days, check how many clients are tagged
 * for that day. Used to show "busy" vs "open" in the reschedule dropdown.
 */
async function getOpenDays(daysAhead = 14, userId) {
  const results = [];
  const today   = new Date();

  // Fetch all clients once, then filter in memory for each day — avoids 14 separate Jobber API calls
  const allClients = await fetchAllClients(userId);

  for (let i = 1; i <= daysAhead; i++) {
    const d       = new Date(today);
    d.setDate(today.getDate() + i);
    const dateStr = toDateString(d);
    const dayName = getDayTag(d);
    const tag     = dayName.toLowerCase().trim();

    const clients = allClients.filter((c) =>
      c.tags?.nodes?.some((t) => t.label.toLowerCase() === tag)
    );

    results.push({
      date:        dateStr,
      dayName,
      clientCount: clients.length,
      label: clients.length === 0
        ? `${formatDate(dateStr)} — open`
        : `${formatDate(dateStr)} — ${clients.length} client${clients.length !== 1 ? 's' : ''} (busy)`,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Notification senders
// ---------------------------------------------------------------------------

/**
 * Send rain reschedule SMS via Twilio (uses per-user DB creds).
 */
async function sendRainSMS(phone, firstName, newDateLabel, customMessage, userId) {
  const to   = toE164(phone);
  const name = firstName || 'there';

  let body;
  if (customMessage) {
    // One-off from UI — still resolve placeholders so textarea can show {firstName}/{newDate}
    body = customMessage.replace(/\{firstName\}/g, name).replace(/\{newDate\}/g, newDateLabel);
  } else {
    const settings = await getSettings(userId);
    const template = settings?.rainSmsTemplate ||
      `Hi {firstName}! Due to rain in the forecast, your lawn cut has been rescheduled to {newDate}. We appreciate your flexibility! — No-Bs Yardwork`;
    body = template.replace(/\{firstName\}/g, name).replace(/\{newDate\}/g, newDateLabel);
  }

  if (process.env.DRY_RUN === 'true') {
    console.log(`[weatherService] DRY RUN — would send rain SMS to ${to}: "${body.slice(0, 80)}..."`);
    return 'dry-run';
  }

  const creds = await getTwilioCreds(userId);
  if (!creds.accountSid || !creds.authToken) throw new Error('Twilio credentials not configured');

  const client = twilio(creds.accountSid, creds.authToken);
  const params = { body, from: creds.fromNumber, to };
  if (process.env.APP_URL) {
    params.statusCallback = `${process.env.APP_URL}/api/weather/twilio-callback`;
  }
  const msg = await client.messages.create(params);

  console.log(`[weatherService] Rain SMS sent to ${to} | SID: ${msg.sid}`);
  return msg.sid;
}

/**
 * Send rain reschedule email via Gmail (uses per-user DB creds).
 */
async function sendRainEmail(to, firstName, newDateLabel, customMessage, userId) {
  const name = firstName || 'there';

  let text;
  if (customMessage) {
    // One-off from UI — still resolve placeholders so textarea can show {firstName}/{newDate}
    text = customMessage.replace(/\{firstName\}/g, name).replace(/\{newDate\}/g, newDateLabel);
  } else {
    const settings = await getSettings(userId);
    const template = settings?.rainSmsTemplate ||
      `Hi {firstName}! Due to rain in the forecast, your lawn cut has been rescheduled to {newDate}. We appreciate your flexibility! — No-Bs Yardwork`;
    text = template.replace(/\{firstName\}/g, name).replace(/\{newDate\}/g, newDateLabel);
  }

  if (process.env.DRY_RUN === 'true') {
    console.log(`[weatherService] DRY RUN — would send rain email to ${to} for ${firstName}`);
    return 'dry-run';
  }

  const creds = await getGmailCreds(userId);
  if (!creds || !creds.user) throw new Error('Gmail not connected for this account — sign in via Settings');

  const accessToken = await ensureFreshToken(userId, creds);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type:         'OAuth2',
      user:         creds.user,
      clientId:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: creds.refreshToken,
      accessToken,
    },
  });

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,sans-serif;background:#f9fafb;padding:40px 20px;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:40px;border:1px solid #f0f0f0;">
    <h2 style="color:#111827;font-size:20px;margin:0 0 16px;">Schedule Update</h2>
    <p style="color:#4b5563;font-size:16px;line-height:1.6;margin:0 0 24px;">${text}</p>
    <p style="color:#9ca3af;font-size:13px;margin:0;">— The No-Bs Yardwork Team</p>
  </div>
</body></html>`;

  const info = await transporter.sendMail({
    from:    `"${creds.fromName || 'No-Bs Yardwork'}" <${creds.user}>`,
    to,
    subject: `Hi ${name} — your lawn cut has been rescheduled`,
    html,
    text,
  });

  console.log(`[weatherService] Rain email sent to ${to} | id: ${info.messageId}`);
  return info.messageId;
}

/**
 * Tag a Jobber client with "rain-rescheduled" so they won't be double-notified.
 */
async function addRainTag(clientId) {
  try {
    await jobberGraphQL(ADD_CLIENT_TAG, { clientId, label: 'rain-rescheduled' });
  } catch (err) {
    console.warn(`[weatherService] Could not add rain tag to ${clientId}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Batch notify
// ---------------------------------------------------------------------------

/**
 * Send rain reschedule notifications to a list of clients.
 * Returns counts for logging.
 */
async function batchNotify({ clients, newDate, newDateLabel, customMessage, userId }) {
  let smsCount   = 0;
  let emailCount = 0;
  const errors   = [];

  for (const client of clients) {
    const { id, firstName, phone, smsAllowed, email } = client;
    let smsSent = false;

    // SMS first — if client has a phone number with SMS enabled
    if (phone && smsAllowed) {
      try {
        await sendRainSMS(phone, firstName, newDateLabel, customMessage, userId);
        smsCount++;
        smsSent = true;
      } catch (err) {
        console.error(`[weatherService] SMS failed for ${client.name}:`, err.message);
        errors.push({ clientId: id, type: 'sms', error: err.message });
      }
    }

    // Email fallback — only if SMS was not sent (no phone, smsAllowed false, or SMS failed)
    if (!smsSent && email) {
      try {
        await sendRainEmail(email, firstName, newDateLabel, customMessage, userId);
        emailCount++;
      } catch (err) {
        console.error(`[weatherService] Email failed for ${client.name}:`, err.message);
        errors.push({ clientId: id, type: 'email', error: err.message });
      }
    }

    // Tag client in Jobber so we don't double-notify
    await addRainTag(id);
    await sleep(300);
  }

  return { smsCount, emailCount, errors };
}

// ---------------------------------------------------------------------------
// Autonomous rain reschedule (owner-approved via SMS)
// ---------------------------------------------------------------------------

/**
 * Execute an approved rain_reschedule OperatorProposal: move each visit in Jobber
 * to payload.targetDate (preserving time-of-day + duration), notify each client,
 * and write RainReschedule + RainMessage audit rows. Mirrors the manual
 * POST /api/weather/reschedule-visits path.
 *
 * @param {object} proposal - OperatorProposal row; payload = { date, targetDate, visits:[...] }
 * @returns {{ moved:number, smsCount:number, emailCount:number, errors:Array, newDateLabel:string, targetDate:string }}
 */
async function executeRainReschedule(proposal) {
  const userId     = proposal.userId;
  const payload    = proposal.payload || {};
  const targetDate = payload.targetDate;
  const visits     = Array.isArray(payload.visits) ? payload.visits : [];

  if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error('rain_reschedule payload missing valid targetDate');
  }
  if (visits.length === 0) {
    return { moved: 0, smsCount: 0, emailCount: 0, errors: [], newDateLabel: formatDate(targetDate), targetDate };
  }

  const newDateLabel = formatDate(targetDate);
  let moved = 0, smsCount = 0, emailCount = 0;
  const errors = [];
  const messageLog = [];

  let rescheduleLog = null;
  try {
    rescheduleLog = await prisma.rainReschedule.create({
      data: {
        originalDay:  getDayTag(),
        originalDate: payload.date || toDateString(),
        newDate:      targetDate,
        clientCount:  visits.length,
        smsCount:     0,
        emailCount:   0,
        message:      `Auto-rescheduled to ${newDateLabel} (owner approved via SMS)`,
        userId,
      },
    });
  } catch (logErr) {
    console.warn('[weatherService] Failed to create auto-reschedule log:', logErr.message);
  }

  for (const visit of visits) {
    const { id: visitId, clientId, startAt, endAt, firstName, clientName, phone, smsAllowed, email } = visit;
    const name = firstName || clientName || 'there';

    const timeOfDay  = startAt ? startAt.slice(11) : '08:00:00Z';
    const newStartAt = `${targetDate}T${timeOfDay}`;
    let newEndAt = null;
    if (endAt && startAt) {
      const duration = new Date(endAt).getTime() - new Date(startAt).getTime();
      newEndAt = new Date(new Date(newStartAt).getTime() + duration).toISOString();
    }

    try {
      await rescheduleJobberVisit(visitId, newStartAt, newEndAt, userId);
      moved++;
    } catch (err) {
      console.error(`[weatherService] auto-reschedule Jobber move failed for ${visitId}:`, err.message);
      errors.push({ visitId, clientName, step: 'jobber', error: err.message });
      continue;
    }

    let smsSent = false;
    if (phone && smsAllowed) {
      try {
        const sid = await sendRainSMS(phone, name, newDateLabel, null, userId);
        smsCount++; smsSent = true;
        messageLog.push({ rescheduleId: rescheduleLog?.id, visitId, clientId: clientId || visitId, clientName: name, channel: 'sms', status: 'sent', messageSid: sid, userId });
      } catch (err) {
        errors.push({ visitId, clientName, step: 'sms', error: err.message });
        messageLog.push({ rescheduleId: rescheduleLog?.id, visitId, clientId: clientId || visitId, clientName: name, channel: 'sms', status: 'failed', error: err.message, userId });
      }
    }
    if (!smsSent && email) {
      try {
        await sendRainEmail(email, name, newDateLabel, null, userId);
        emailCount++;
        messageLog.push({ rescheduleId: rescheduleLog?.id, visitId, clientId: clientId || visitId, clientName: name, channel: 'email', status: 'sent', userId });
      } catch (err) {
        errors.push({ visitId, clientName, step: 'email', error: err.message });
        messageLog.push({ rescheduleId: rescheduleLog?.id, visitId, clientId: clientId || visitId, clientName: name, channel: 'email', status: 'failed', error: err.message, userId });
      }
    }
  }

  if (rescheduleLog) {
    try {
      await prisma.rainReschedule.update({
        where: { id: rescheduleLog.id },
        data:  { clientCount: moved, smsCount, emailCount },
      });
      const rows = messageLog.filter((m) => m.rescheduleId);
      if (rows.length) await prisma.rainMessage.createMany({ data: rows });
    } catch (logErr) {
      console.warn('[weatherService] Failed to update auto-reschedule log:', logErr.message);
    }
  }

  console.log(`[weatherService] Auto-reschedule complete — moved:${moved} SMS:${smsCount} Email:${emailCount} errors:${errors.length}`);
  return { moved, smsCount, emailCount, errors, newDateLabel, targetDate };
}

/**
 * Handle an inbound SMS from the owner's approver phone that may be a reply to a
 * pending rain recommendation. Parses "YES <day>" / "NO" in free text, resolves
 * the day to a date, executes the reschedule, and texts the owner the outcome.
 *
 * @returns {{ matched:boolean }} matched:true means this SMS was a rain reply
 *   (caller should stop further routing).
 */
async function handleRainReply({ userId, body }) {
  const op = require('./operatorService');

  // Find the newest pending, non-expired rain proposal for this user.
  const proposal = await prisma.operatorProposal.findFirst({
    where: { userId, category: 'rain_reschedule', status: 'pending', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!proposal) return { matched: false };

  const { intent, day } = parseRainReply(body);
  // A bare day name ("Wednesday") while a recommendation is pending = approve to that day.
  const effectiveIntent = intent || (day ? 'yes' : null);
  if (!effectiveIntent) return { matched: false }; // not a yes/no/day — let other handlers try

  if (effectiveIntent === 'no') {
    await prisma.operatorProposal.update({
      where: { id: proposal.id },
      data:  { status: 'declined', respondedAt: new Date(), respondedVia: 'sms' },
    });
    await op.notifyOwner(userId, '👍 No problem — your jobs stay as scheduled.');
    return { matched: true };
  }

  // effectiveIntent === 'yes' — need a target day
  const targetDate = day ? nextWeekdayDate(day) : (proposal.payload?.targetDate || null);
  if (!targetDate) {
    await op.notifyOwner(userId, 'Which day should I move them to? Reply e.g. "YES Wednesday".');
    return { matched: true }; // leave proposal pending for a follow-up reply
  }

  // Record approval + chosen date, then execute.
  await prisma.operatorProposal.update({
    where: { id: proposal.id },
    data:  {
      status: 'approved',
      respondedAt: new Date(),
      respondedVia: 'sms',
      payload: { ...(proposal.payload || {}), targetDate },
    },
  });

  const exec = await op.executeProposal(proposal.id);
  const r = exec?.result || {};
  if (exec?.ok) {
    const errNote = r.errors?.length ? ` · ${r.errors.length} error(s)` : '';
    await op.notifyOwner(userId, `✅ Done — moved ${r.moved} job(s) to ${r.newDateLabel}. SMS ${r.smsCount} · Email ${r.emailCount}${errNote}`);
  } else {
    await op.notifyOwner(userId, `⚠️ Reschedule hit a problem: ${exec?.error || 'unknown error'}`);
  }
  return { matched: true };
}

// ---------------------------------------------------------------------------
// Morning cron
// ---------------------------------------------------------------------------

/**
 * Run a morning rain check for a single user's WeatherSettings.
 */
async function runMorningCheckForUser(userId) {
  try {
    const settings = await getSettings(userId);
    if (!settings.checkEnabled) return;

    const result = await checkRainToday(settings);

    await prisma.weatherCheck.create({
      data: {
        date:            toDateString(),
        rainExpected:    result.rainExpected,
        maxPrecipProb:   result.maxPop,
        forecastSummary: result.summary,
        userId:          userId || null,
      },
    });

    if (result.rainExpected) {
      console.log(`[weatherService][user:${userId}] *** RAIN ALERT *** ${result.summary}`);
      // Proactively recommend a reschedule to the owner via SMS (they approve with a day).
      await maybeRecommendReschedule(userId, result).catch((err) =>
        console.error(`[weatherService][user:${userId}] recommend reschedule failed:`, err.message)
      );
    } else {
      console.log(`[weatherService][user:${userId}] No rain expected. ${result.summary}`);
    }
  } catch (err) {
    console.error(`[weatherService][user:${userId}] Morning check failed:`, err.message);
  }
}

/**
 * When rain is expected and the owner has jobs booked today, create an
 * approval-required OperatorProposal and text the owner a recommendation:
 *   "🌧️ Rain 80% today — 5 jobs booked. Reply YES + a day (e.g. YES Wednesday) …"
 * Guarded to one proposal per user per day so repeated checks/redeploys don't spam.
 */
async function maybeRecommendReschedule(userId, result) {
  if (!userId) return; // anonymous check — no owner to attribute/approve

  const op       = require('./operatorService');
  const todayStr = toDateString();

  // Don't create a duplicate for today.
  const existing = await prisma.operatorProposal.findFirst({
    where: {
      userId,
      category: 'rain_reschedule',
      payload:  { path: ['date'], equals: todayStr },
      status:   { in: ['pending', 'approved', 'executed'] },
    },
  });
  if (existing) {
    console.log(`[weatherService][user:${userId}] rain proposal already exists for ${todayStr} — skipping`);
    return;
  }

  // Which jobs are booked today?
  const visits = await fetchWeekVisits(userId, todayStr, todayStr);
  if (!visits.length) {
    console.log(`[weatherService][user:${userId}] rain expected but no jobs booked today — no recommendation`);
    return;
  }

  const pct = result.maxPopPct ?? Math.round((result.maxPop || 0) * 100);
  const summary = `Rain ${pct}% today — ${visits.length} job${visits.length !== 1 ? 's' : ''} booked.`;

  const proposal = await op.createProposal({
    userId,
    category: 'rain_reschedule',
    tier:     'approval_required',
    summary,
    payload:  { date: todayStr, visits, rainPct: pct },
    ttlHours: 12,
  });

  await op.notifyOwner(
    userId,
    `🌧️ ${summary} Reply "YES <day>" to move them (e.g. YES Wednesday), or NO to keep them.`
  );
  console.log(`[weatherService][user:${userId}] rain recommendation sent (proposal ${proposal.shortCode})`);
}

/**
 * Runs at 5:30 AM daily. Iterates all users with WeatherSettings and checks weather.
 * Does NOT auto-notify clients — operator always approves first from dashboard.
 */
async function runMorningCheck() {
  console.log('[weatherService] Running morning rain check for all users...');

  try {
    const allSettings = await prisma.weatherSettings.findMany();

    if (allSettings.length === 0) {
      // No users have configured weather yet — run a single anonymous check
      await runMorningCheckForUser(null);
      return;
    }

    for (const s of allSettings) {
      await runMorningCheckForUser(s.userId);
    }
  } catch (err) {
    console.error('[weatherService] Morning check failed:', err.message);
  }
}

/**
 * Start the weather check scheduler (5:30 AM daily).
 * Also runs immediately on startup.
 */
function startWeatherScheduler() {
  console.log('[weatherService] Starting weather scheduler (daily at 5:30 AM)');

  cron.schedule('30 5 * * *', () => {
    runMorningCheck().catch((err) =>
      console.error('[weatherService] Scheduler error:', err.message)
    );
  });

  // Run immediately on startup (non-blocking)
  runMorningCheck().catch((err) =>
    console.error('[weatherService] Startup check error:', err.message)
  );
}

module.exports = {
  getForecast,
  buildDaySummaries,
  checkRainToday,
  getDayTag,
  toDateString,
  formatDate,
  getClientsByTag,
  getOpenDays,
  fetchWeekVisits,
  rescheduleJobberVisit,
  batchNotify,
  sendRainSMS,
  sendRainEmail,
  getSettings,
  runMorningCheck,
  startWeatherScheduler,
  // Owner-in-the-loop rain rescheduling
  nextWeekdayDate,
  parseRainReply,
  executeRainReschedule,
  handleRainReply,
};
