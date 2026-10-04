/**
 * Learns what No-Bs actually charges, from the owner's own texts (never from the AI's). Nightly and deterministic.
 * Writes Memory scope "pricing:<service>" (one row per service, JSON value) with count, min, median, max, last seen.
 * The dashboard shows it; a service becomes eligible for AI quoting only when the owner turns it on (not yet wired into replies).
 */
const prisma = require('../../lib/prismaClient');

const SERVICES = [
  ['snow', /snow|plow|plough|shovel|ice/i], ['aeration', /aerat|aero/i], ['power-rake', /power ?rak|dethatch/i],
  ['fall-cleanup', /fall clean|leaf|leaves|autumn/i], ['spring-cleanup', /spring clean/i], ['mowing', /\bmow|lawn cut|grass cut|\bcut\b/i],
  ['sod', /\bsod\b|turf/i], ['landscaping', /landscap|mulch|rock|bed|plant|patio|paver|retaining|fence|deck/i], ['junk', /junk|haul|removal/i],
];
const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?/g;

function extractPrices(text) {
  return [...String(text || '').matchAll(MONEY)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => n >= 20 && n <= 50000);
}
function classifyService(text) {
  for (const [name, re] of SERVICES) if (re.test(text)) return name;
  return 'other';
}
function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  const median = v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2);
  return { count: v.length, min: v[0], median, max: v[v.length - 1] };
}

async function pricingTick({ userId }) {
  const since = new Date(Date.now() - 365 * 86400000);
  const outs = await prisma.commMessage.findMany({ where: { userId, direction: 'out', source: { in: ['owner', 'manual'] }, at: { gte: since }, body: { contains: '$' } }, orderBy: { at: 'asc' }, take: 5000 });
  const byService = new Map();
  for (const m of outs) {
    const prices = extractPrices(m.body);
    if (!prices.length) continue;
    // the service is what the customer asked about, else what the owner wrote
    const ins = await prisma.commMessage.findFirst({ where: { userId, direction: 'in', phoneKey: m.phoneKey, at: { lt: m.at } }, orderBy: { at: 'desc' } });
    const svc = classifyService(`${ins?.body || ''} ${m.body}`);
    const arr = byService.get(svc) || { values: [], last: m.at };
    arr.values.push(...prices.slice(0, 1));           // first amount per text = the quote
    arr.last = m.at;
    byService.set(svc, arr);
  }
  let saved = 0;
  for (const [svc, { values, last }] of byService) {
    const s = stats(values);
    const value = JSON.stringify({ ...s, lastSeen: last.toISOString().slice(0, 10), basis: 'owner texts, last 12 months' });
    await prisma.memory.upsert({
      where: { userId_scope_key: { userId, scope: `pricing:${svc}`, key: 'observed' } },
      update: { value, confidence: Math.min(0.95, 0.5 + s.count / 40) },
      create: { userId, scope: `pricing:${svc}`, key: 'observed', value, confidence: Math.min(0.95, 0.5 + s.count / 40), source: 'system', agent: 'orchestrator' },
    });
    saved++;
  }
  return { items_found: outs.length, actions_taken: saved ? [`Updated price observations for ${saved} service(s)`] : [], summary: `${outs.length} owner texts with amounts, ${saved} service(s) learned` };
}

module.exports = { pricingTick, extractPrices, classifyService, stats };
