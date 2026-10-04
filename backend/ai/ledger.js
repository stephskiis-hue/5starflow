// Run ledger + activity feed helpers. Pure persistence — no scheduling logic (that's runner.js).
const prisma = require('../lib/prismaClient');
const { LIMITS, clip } = require('./constants');

function classifyError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.response?.status;
  if (/weekly limit|rate.?limit|usage limit|too many requests/.test(msg) || status === 429) return 'rate_limit';
  if (/throttl/.test(msg)) return 'throttled';
  if (status === 401 || status === 403 || /unauthor|forbidden|invalid.*token|token.*(expired|invalid)|refresh/.test(msg)) return 'auth';
  if (/econn|etimedout|enotfound|socket hang up|network|timeout/.test(msg)) return 'network';
  if (/invalid|required|validation|not found/.test(msg)) return 'validation';
  return 'unknown';
}

// Standard structured result every routine returns (the "TRIGGER→...→STORE" contract).
function normalizeResult(out, status = 'completed') {
  const o = out && typeof out === 'object' && !Array.isArray(out) ? out : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const items = arr(o.items);
  const result = {
    status: o.status || status,
    items_found: o.items_found != null ? n(o.items_found) : (typeof out === 'number' ? out : items.length),
    requires_attention: n(o.requires_attention),
    high_priority: n(o.high_priority),
    summary: clip(o.summary || (typeof out === 'string' ? out : ''), LIMITS.summary) || '',
    actions_taken: arr(o.actions_taken),
    learnings: arr(o.learnings),
    research_findings: arr(o.research_findings),
    items: items.slice(0, 50),
  };
  // keep any extra scalar fields a routine wants to expose (counts, ids) without letting them balloon
  for (const [k, v] of Object.entries(o)) {
    if (!(k in result) && (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length < 200))) result[k] = v;
  }
  return result;
}

async function recordActivity(userId, a) {
  try {
    return await prisma.agentActivity.create({
      data: {
        userId,
        agent: clip(a.agent || 'system', 40),
        routineSlug: clip(a.routineSlug, 80) || null,
        runId: a.runId || null,
        action: clip(a.action || 'did something', 120),
        summary: clip(a.summary || '', LIMITS.text),
        source: clip(a.source, 40) || null,
        result: clip(a.result, 40) || null,
        tool: clip(a.tool, 80) || null,
        approval: clip(a.approval, 40) || null,
        learning: clip(a.learning, LIMITS.text) || null,
        customerRef: clip(a.customerRef, 120) || null,
        error: clip(a.error, LIMITS.text) || null,
      },
    });
  } catch (err) {
    console.warn('[ai.activity] write failed:', err.message); // never let the feed break a routine
    return null;
  }
}

module.exports = { classifyError, normalizeResult, recordActivity };
