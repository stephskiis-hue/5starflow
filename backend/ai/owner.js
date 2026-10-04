// Resolves which portal user the AI OS acts for. Single-tenant today (the business owner):
// OPERATOR_USER_ID wins, otherwise the first admin. Cached — the owner doesn't change at runtime.
const prisma = require('../lib/prismaClient');

let cached = null;

async function resolveOwnerId() {
  if (cached) return cached;
  if (process.env.OPERATOR_USER_ID) return (cached = process.env.OPERATOR_USER_ID);
  const admin = await prisma.user.findFirst({ where: { role: 'admin', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (admin) cached = admin.id;
  return cached;
}

module.exports = { resolveOwnerId, _reset: () => { cached = null; } };
