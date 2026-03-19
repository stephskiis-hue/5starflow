const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/prismaClient');
const {
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
} = require('../services/weatherService');

// In-memory calendar cache — busted on reschedule, expires after 15 min
const calendarCache = new Map(); // userId -> { data, cachedAt }
const CALENDAR_TTL  = 15 * 60 * 1000;

/**
 * GET /api/weather/forecast
 * Returns a 7-day forecast summary for the configured city.
 */
router.get('/forecast', async (req, res) => {
  try {
    const settings = await getSettings(req.user.userId);
    const city     = settings.city || process.env.WEATHER_CITY || 'Winnipeg';
    const list     = await getForecast(city);
    const days     = buildDaySummaries(list);
    res.json({ city, days });
  } catch (err) {
    console.error('[weather] /forecast error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/weather/today
 * Returns today's rain check result.
 * ?force=true re-runs the check live instead of returning the cached DB value.
 */
router.get('/today', async (req, res) => {
  try {
    const settings = await getSettings(req.user.userId);
    const todayStr = toDateString();

    // ── Debug / test mode ─────────────────────────────────────────────────
    if (req.query.debugRain === 'true') {
      const rawProb    = parseInt(req.query.rainProb, 10);
      const rainProb   = Math.max(0, Math.min(100, isNaN(rawProb) ? 75 : rawProb)) / 100;
      const threshold  = settings.rainThreshold ?? 0.4;
      const rainExpected = rainProb >= threshold;
      return res.json({
        cached:          false,
        date:            todayStr,
        rainExpected,
        maxPrecipProb:   rainProb,
        maxPopPct:       Math.round(rainProb * 100),
        forecastSummary: `[DEBUG] Simulated ${Math.round(rainProb * 100)}% rain probability`,
        checkedAt:       new Date().toISOString(),
        debug:           true,
      });
    }

    if (req.query.force !== 'true') {
      const cached = await prisma.weatherCheck.findFirst({
        where: { date: todayStr, userId: req.user.userId },
        orderBy: { checkedAt: 'desc' },
      });
      if (cached) {
        return res.json({
          cached: true,
          date:           cached.date,
          rainExpected:   cached.rainExpected,
          maxPrecipProb:  cached.maxPrecipProb,
          maxPopPct:      Math.round(cached.maxPrecipProb * 100),
          forecastSummary: cached.forecastSummary,
          checkedAt:      cached.checkedAt.toISOString(),
        });
      }
    }

    // Live check
    const result = await checkRainToday(settings);
    await prisma.weatherCheck.create({
      data: {
        date:            todayStr,
        rainExpected:    result.rainExpected,
        maxPrecipProb:   result.maxPop,
        forecastSummary: result.summary,
        userId:          req.user.userId,
      },
    });

    res.json({
      cached:          false,
      date:            todayStr,
      rainExpected:    result.rainExpected,
      maxPrecipProb:   result.maxPop,
      maxPopPct:       result.maxPopPct,
      forecastSummary: result.summary,
      daySummaries:    result.daySummaries,
      checkedAt:       new Date().toISOString(),
    });
  } catch (err) {
    console.error('[weather] /today error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/weather/affected-clients
 * Returns Jobber clients tagged with the given day (default: today).
 * Query: ?day=monday  (optional, defaults to today's day tag)
 */
router.get('/affected-clients', async (req, res) => {
  try {
    const dayTag = (req.query.day || getDayTag()).toLowerCase();
    const clients = await getClientsByTag(dayTag, req.user.userId);
    res.json({ dayTag, count: clients.length, clients });
  } catch (err) {
    console.error('[weather] /affected-clients error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/weather/open-days
 * Returns next 14 days with client counts — used to populate reschedule dropdown.
 */
router.get('/open-days', async (req, res) => {
  try {
    const days = await getOpenDays(14, req.user.userId);
    res.json({ days });
  } catch (err) {
    console.error('[weather] /open-days error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/weather/calendar
 * Returns 7-day weather forecast merged with real Jobber visits per day.
 * Cached in memory for 15 minutes per user.
 */
router.get('/calendar', async (req, res) => {
  try {
    const userId = req.user.userId;

    // Honour ?force=true to bypass cache (used by the Refresh button)
    if (req.query.force === 'true') calendarCache.delete(userId);

    const cached = calendarCache.get(userId);
    if (cached && (Date.now() - cached.cachedAt) < CALENDAR_TTL) {
      return res.json({ calendar: cached.data, cached: true });
    }

    const settings = await getSettings(userId);
    const city = settings.city || process.env.WEATHER_CITY || 'Winnipeg';

    // Use Winnipeg local date (not UTC) so the window is correct regardless of time of day
    const now       = new Date();
    const startDate = now.toLocaleDateString('en-CA', { timeZone: 'America/Winnipeg' });
    const endDay    = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const endDate   = endDay.toLocaleDateString('en-CA', { timeZone: 'America/Winnipeg' });

    // Fetch weather and Jobber visits in parallel
    // visitsFetch errors are logged but don't break the whole calendar — weather still shows
    let visitFetchError = null;
    const [forecastList, visits] = await Promise.all([
      getForecast(city).catch(() => []),
      fetchWeekVisits(userId, startDate, endDate).catch((err) => {
        visitFetchError = err.message;
        console.error('[weather] /calendar visits fetch failed:', err.message);
        return [];
      }),
    ]);

    const daySummaries = buildDaySummaries(forecastList);

    // Seed calendar with forecast days
    const calendar = {};
    for (const day of daySummaries) {
      calendar[day.date] = {
        date:       day.date,
        dayName:    day.dayName,
        rainProb:   day.maxPop,
        maxPopPct:  day.maxPopPct,
        isRainy:    day.rainExpected,
        condition:  day.condition,
        visits:     [],
      };
    }

    // Merge in visits
    for (const visit of visits) {
      const dateStr = (visit.startAt || '').slice(0, 10);
      if (!dateStr) continue;
      if (!calendar[dateStr]) {
        calendar[dateStr] = { date: dateStr, dayName: '', rainProb: 0, maxPopPct: 0, isRainy: false, visits: [] };
      }
      calendar[dateStr].visits.push(visit);
    }

    calendarCache.set(userId, { data: calendar, cachedAt: Date.now() });
    res.json({ calendar, cached: false, ...(visitFetchError && { visitError: visitFetchError }) });
  } catch (err) {
    console.error('[weather] /calendar error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/weather/reschedule-visits
 * Moves real Jobber visits to a new date AND notifies each client via SMS + email.
 *
 * Body:
 *   visits     {array}  — each: { id, title, startAt, clientId, clientName, firstName, phone, smsAllowed, email }
 *   targetDate {string} — YYYY-MM-DD
 *   message    {string} — optional custom message
 */
router.post('/reschedule-visits', async (req, res) => {
  const { visits, targetDate, message: customMessage } = req.body || {};

  if (!Array.isArray(visits) || visits.length === 0) {
    return res.status(400).json({ error: 'visits array is required' });
  }
  if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return res.status(400).json({ error: 'targetDate is required (YYYY-MM-DD)' });
  }

  const userId       = req.user.userId;
  const newDateLabel = formatDate(targetDate);
  let movedCount   = 0;
  let smsCount     = 0;
  let emailCount   = 0;
  const errors     = [];

  for (const visit of visits) {
    const { id: visitId, startAt, endAt, firstName, clientName, phone, smsAllowed, email } = visit;

    // Preserve same time-of-day, change only the date
    const timeOfDay  = startAt ? startAt.slice(11) : '08:00:00Z';
    const newStartAt = `${targetDate}T${timeOfDay}`;

    // Preserve visit duration when moving endAt
    let newEndAt = null;
    if (endAt && startAt) {
      const duration = new Date(endAt).getTime() - new Date(startAt).getTime();
      newEndAt = new Date(new Date(newStartAt).getTime() + duration).toISOString();
    }

    // 1. Move in Jobber
    try {
      await rescheduleJobberVisit(visitId, newStartAt, newEndAt, userId);
      movedCount++;
    } catch (err) {
      console.error(`[weather] Jobber reschedule failed for visitId=${visitId}:`, err.message);
      errors.push({ visitId, clientName, step: 'jobber', error: err.message });
      continue; // skip notification if Jobber move failed
    }

    // 2. Notify client via SMS
    if (phone && smsAllowed) {
      try {
        await sendRainSMS(phone, firstName || clientName || 'there', newDateLabel, customMessage, userId);
        smsCount++;
      } catch (err) {
        console.error(`[weather] SMS failed for visitId=${visitId}:`, err.message);
        errors.push({ visitId, clientName, step: 'sms', error: err.message });
      }
    }

    // 3. Notify client via email
    if (email) {
      try {
        await sendRainEmail(email, firstName || clientName || 'there', newDateLabel, customMessage, userId);
        emailCount++;
      } catch (err) {
        console.error(`[weather] Email failed for visitId=${visitId}:`, err.message);
        errors.push({ visitId, clientName, step: 'email', error: err.message });
      }
    }
  }

  // Log the batch reschedule event
  try {
    await prisma.rainReschedule.create({
      data: {
        originalDay:  getDayTag(),
        originalDate: toDateString(),
        newDate:      targetDate,
        clientCount:  movedCount,
        smsCount,
        emailCount,
        message:      customMessage || `Rescheduled to ${newDateLabel} via calendar`,
        userId,
      },
    });
  } catch (logErr) {
    console.warn('[weather] Failed to log reschedule event:', logErr.message);
  }

  // Bust calendar cache so it reflects the new visit dates
  calendarCache.delete(userId);

  console.log(`[weather] Reschedule complete — moved:${movedCount} SMS:${smsCount} Email:${emailCount} errors:${errors.length}`);
  res.json({ success: true, moved: movedCount, smsCount, emailCount, errors });
});

/**
 * POST /api/weather/notify
 * Sends rain reschedule notifications to selected clients.
 *
 * Body:
 *   newDate      {string}   YYYY-MM-DD
 *   newDateLabel {string}   "Tuesday, March 18"
 *   clientIds    {string[]} optional — if omitted, sends to ALL today's tagged clients
 *   customMessage {string}  optional — override default message text
 */
router.post('/notify', async (req, res) => {
  const { newDate, newDateLabel, clientIds, customMessage } = req.body || {};

  if (!newDate || !newDateLabel) {
    return res.status(400).json({ error: 'newDate and newDateLabel are required' });
  }

  try {
    const dayTag  = getDayTag();
    let clients   = await getClientsByTag(dayTag, req.user.userId);

    // Filter to requested subset if clientIds provided
    if (Array.isArray(clientIds) && clientIds.length > 0) {
      clients = clients.filter((c) => clientIds.includes(c.id));
    }

    if (clients.length === 0) {
      return res.status(400).json({ error: `No clients found with tag "${dayTag}"` });
    }

    const { smsCount, emailCount, errors } = await batchNotify({
      clients,
      newDate,
      newDateLabel,
      customMessage: customMessage || null,
      userId: req.user.userId,
    });

    const message = customMessage ||
      `Hi [client]! Due to rain in the forecast, your lawn cut has been rescheduled to ${newDateLabel}. We appreciate your flexibility! — No-Bs Yardwork`;

    // Log the reschedule event
    await prisma.rainReschedule.create({
      data: {
        originalDay:  dayTag,
        originalDate: toDateString(),
        newDate,
        clientCount:  clients.length,
        smsCount,
        emailCount,
        message,
        userId:       req.user.userId,
      },
    });

    // Save preferred reschedule day to settings for next time
    const settings = await getSettings(req.user.userId);
    await prisma.weatherSettings.update({
      where: { id: settings.id },
      data:  { preferredRescheduleDay: newDate },
    });

    console.log(`[weather] Rain notifications sent — SMS: ${smsCount}, Email: ${emailCount}, Clients: ${clients.length}`);
    res.json({ success: true, smsCount, emailCount, clientCount: clients.length, errors });

  } catch (err) {
    console.error('[weather] /notify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/weather/settings
 */
router.get('/settings', async (req, res) => {
  try {
    const settings = await getSettings(req.user.userId);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/weather/settings
 * Body: { city, rainThreshold, businessStartHour, businessEndHour, preferredRescheduleDay, checkEnabled }
 */
router.post('/settings', async (req, res) => {
  try {
    const { city, rainThreshold, businessStartHour, businessEndHour, preferredRescheduleDay, checkEnabled } = req.body || {};
    const settings = await getSettings(req.user.userId);

    const updated = await prisma.weatherSettings.update({
      where: { id: settings.id },
      data: {
        ...(city                   !== undefined && { city }),
        ...(rainThreshold          !== undefined && { rainThreshold: parseFloat(rainThreshold) }),
        ...(businessStartHour      !== undefined && { businessStartHour: parseInt(businessStartHour, 10) }),
        ...(businessEndHour        !== undefined && { businessEndHour: parseInt(businessEndHour, 10) }),
        ...(preferredRescheduleDay !== undefined && { preferredRescheduleDay }),
        ...(checkEnabled           !== undefined && { checkEnabled: Boolean(checkEnabled) }),
      },
    });

    res.json({ success: true, settings: updated });
  } catch (err) {
    console.error('[weather] /settings POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/weather/history
 * Returns last 20 rain reschedule events for this user.
 */
router.get('/history', async (req, res) => {
  try {
    const records = await prisma.rainReschedule.findMany({
      where:   { userId: req.user.userId },
      orderBy: { notifiedAt: 'desc' },
      take: 20,
    });
    res.json({ records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/weather/run-check
 * Manual trigger for the morning rain check (for testing).
 */
router.post('/run-check', async (req, res) => {
  try {
    const settings = await getSettings(req.user.userId);
    if (!settings.checkEnabled) {
      return res.json({ success: false, message: 'Weather check is disabled in settings' });
    }
    const result = await checkRainToday(settings);
    const todayStr = toDateString();
    await prisma.weatherCheck.create({
      data: {
        date:            todayStr,
        rainExpected:    result.rainExpected,
        maxPrecipProb:   result.maxPop,
        forecastSummary: result.summary,
        userId:          req.user.userId,
      },
    });
    const today = await prisma.weatherCheck.findFirst({
      where:   { date: todayStr, userId: req.user.userId },
      orderBy: { checkedAt: 'desc' },
    });
    res.json({ success: true, result: today });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
