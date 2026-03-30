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
const GET_ALL_CLIENTS = `
  query GetAllClients($cursor: String) {
    clients(after: $cursor) {
      nodes {
        id
        name
        firstName
        emails { address primary }
        phones { number primary smsAllowed }
        tags { nodes { label } }
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
  const vars = {
    id:        visitId,
    startDate: d.toLocaleDateString('en-CA', { timeZone: 'America/Winnipeg' }),
    startTime: d.toLocaleTimeString('en-GB', { timeZone: 'America/Winnipeg', hour12: false }),
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
  const body = customMessage
    ? `Hi ${name}, ${customMessage}`
    : `Hi ${name}! Due to rain in the forecast, your lawn cut has been rescheduled to ${newDateLabel}. We appreciate your flexibility! — No-Bs Yardwork`;

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
  const text = customMessage
    ? `Hi ${name}, ${customMessage}`
    : `Hi ${name}! Due to rain in the forecast, your lawn cut has been rescheduled to ${newDateLabel}. We appreciate your flexibility! — No-Bs Yardwork`;

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
    } else {
      console.log(`[weatherService][user:${userId}] No rain expected. ${result.summary}`);
    }
  } catch (err) {
    console.error(`[weatherService][user:${userId}] Morning check failed:`, err.message);
  }
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
};
