// Shared vocabulary for the AI OS. Keep in sync with the Prisma comments on Routine/Task/Memory.
const AGENTS = ['orchestrator', 'communication', 'operations', 'research', 'content', 'design', 'social', 'qa', 'system'];
const TASK_STATES = ['NEW', 'IN_PROGRESS', 'WAITING', 'APPROVAL', 'COMPLETED', 'DISMISSED'];
const OPEN_TASK_STATES = ['NEW', 'IN_PROGRESS', 'WAITING', 'APPROVAL'];
const URGENCIES = ['low', 'normal', 'high', 'urgent'];
const AUTONOMY = ['read', 'draft', 'approve', 'execute'];
const ROUTINE_KINDS = ['backend', 'claude_cloud', 'claude_desktop', 'zapier', 'local_ollama'];
const RUN_STATUSES = ['running', 'completed', 'failed', 'skipped', 'missed'];

// A task/memory field is never allowed to grow without bound — agents write these.
const LIMITS = { title: 160, text: 2000, key: 120, value: 2000, summary: 500 };

const clip = (v, n) => (v == null ? v : String(v).slice(0, n));

module.exports = { AGENTS, TASK_STATES, OPEN_TASK_STATES, URGENCIES, AUTONOMY, ROUTINE_KINDS, RUN_STATUSES, LIMITS, clip };
