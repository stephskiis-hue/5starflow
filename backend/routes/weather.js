const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/prismaClient');
const {
  getForecast,
  buildDaySummaries,
  checkRainToday,
  getDayTag,
  toDateString,
  getClientsByTag,
  getOpenDays,
  batchNotify,
  getSettings,
  runMorningCheck,
} = require('../services/weatherService');

/**
 * GET /api/weather/forecast
 * Returns a 7-day forecast summary for the configured city.
 */
router.get('/forecast', async (req, res) => {
  try {
    const settings = await getSettings();
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
    const settings = await getSettings();
    const todayStr = toDateString();

    if (req.query.force !== 'true') {
      const cached = await prisma.weatherCheck.findFirst({
        where: { date: todayStr },
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
    const clients = await getClientsByTag(dayTag);
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
    const days = await getOpenDays(14);
    res.json({ days });
  } catch (err) {
    console.error('[weather] /open-days error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
    let clients   = await getClientsByTag(dayTag);

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
      },
    });

    // Save preferred reschedule day to settings for next time
    const settings = await getSettings();
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
    const settings = await getSettings();
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
    const settings = await getSettings();

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
 * Returns last 20 rain reschedule events.
 */
router.get('/history', async (req, res) => {
  try {
    const records = await prisma.rainReschedule.findMany({
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
    await runMorningCheck();
    const today = await prisma.weatherCheck.findFirst({
      where: { date: toDateString() },
      orderBy: { checkedAt: 'desc' },
    });
    res.json({ success: true, result: today });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
