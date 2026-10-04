// Selective memory: upsert by (userId, scope, key). Only durable, decision-improving facts belong here —
// the filter below rejects empty/trivial writes so agents can't fill it with noise.
const prisma = require('../lib/prismaClient');
const { LIMITS, clip } = require('./constants');

const MIN_VALUE_LEN = 12;

function validate(m) {
  if (!m || !m.scope || !m.key || !m.value) return 'scope, key and value are required';
  if (String(m.value).trim().length < MIN_VALUE_LEN) return `value too short to be durable knowledge (<${MIN_VALUE_LEN} chars)`;
  return null;
}

async function saveMemory(userId, m) {
  const err = validate(m);
  if (err) { const e = new Error(err); e.code = 'INVALID_MEMORY'; throw e; }
  const data = {
    value: clip(m.value, LIMITS.value),
    confidence: Math.min(1, Math.max(0, Number(m.confidence ?? 0.8))),
    source: clip(m.source, 120) || null,
    agent: clip(m.agent, 40) || null,
  };
  return prisma.memory.upsert({
    where: { userId_scope_key: { userId, scope: clip(m.scope, 80), key: clip(m.key, LIMITS.key) } },
    update: data,
    create: { userId, scope: clip(m.scope, 80), key: clip(m.key, LIMITS.key), ...data },
  });
}

async function searchMemory(userId, { scope, q, limit = 30 } = {}) {
  const where = { userId };
  if (scope) where.scope = scope.endsWith('*') ? { startsWith: scope.slice(0, -1) } : scope;
  if (q) where.OR = [{ key: { contains: q, mode: 'insensitive' } }, { value: { contains: q, mode: 'insensitive' } }];
  const rows = await prisma.memory.findMany({ where, take: Math.min(limit, 100), orderBy: [{ confidence: 'desc' }, { updatedAt: 'desc' }] });
  if (rows.length) {
    prisma.memory.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { hits: { increment: 1 }, lastUsedAt: new Date() } }).catch(() => {});
  }
  return rows;
}

module.exports = { saveMemory, searchMemory };
