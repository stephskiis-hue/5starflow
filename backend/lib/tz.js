// Business-timezone helpers (Winnipeg by default). One implementation shared by weather, social caps, briefs.
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'America/Winnipeg';

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, hour: '2-digit', hourCycle: 'h23' });

/** "YYYY-MM-DD" in the business timezone. */
function toDateString(date = new Date()) {
  return dateFmt.format(date instanceof Date ? date : new Date(date));
}

/** Hour of day (0-23) in the business timezone. */
function localHour(date) {
  return parseInt(hourFmt.format(date), 10);
}

/** UTC offset like "-05:00" / "-06:00" for a YYYY-MM-DD in the business timezone (DST-aware). */
function tzOffsetFor(dateStr) {
  const noon = new Date(`${dateStr}T18:00:00Z`);
  const part = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, timeZoneName: 'longOffset' })
    .formatToParts(noon).find((p) => p.type === 'timeZoneName')?.value || 'GMT-06:00';
  const m = part.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return m ? `${m[1]}:${m[2] || '00'}` : '-06:00';
}

/** [start, end) of a business-local day as UTC Dates. */
function dayBounds(dateStr = toDateString()) {
  const start = new Date(`${dateStr}T00:00:00${tzOffsetFor(dateStr)}`);
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}

module.exports = { BUSINESS_TZ, toDateString, localHour, tzOffsetFor, dayBounds };
