/**
 * The 5:30 am note to the owner, built from the operations brief with a plain template (no AI, so it never misses a
 * day). Lists everything that needs the owner, most urgent first. A quiet day posts nothing.
 */
const { notify } = require('../lib/notify');
const { buildBrief } = require('./brief');

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const joinNames = (items, max = 6) => `${items.slice(0, max).join(', ')}${items.length > max ? `, and ${items.length - max} more` : ''}`;

/** { title, body } or null on a quiet day. Pure: takes the brief. */
function composeNote(b) {
  const urgent = (b.tasks?.top || []).filter((t) => ['urgent', 'high'].includes(t.urgency));
  const approvals = b.approvals?.items || [];
  const quiet = b.routines?.unhealthy || [];
  const waiting = b.inbound?.items || [];
  const waitingCount = b.inbound?.unansweredSms || 0;
  const requests = b.requests?.pending || 0;
  if (!urgent.length && !approvals.length && !quiet.length && !waitingCount && !requests) return null;

  const lines = [];
  if (urgent.length) lines.push(`Needs you today: ${joinNames(urgent.map((t) => `${t.title}${t.customer ? ` (${t.customer})` : ''}`))}.`);
  if (waitingCount) {
    const names = waiting.map((c) => c.name || c.phone);
    const mins = b.inbound?.oldestWaitingMinutes || 0;
    lines.push(`${plural(waitingCount, 'customer')} waiting on a reply${names.length ? `: ${joinNames(names)}` : ''}${mins >= 60 ? `. The longest has waited ${Math.round(mins / 60)} hours` : ''}.`);
  }
  if (approvals.length) lines.push(`Waiting on your approval: ${joinNames(approvals.map((a) => a.summary))}.`);
  if (requests) lines.push(`${plural(requests, 'request')} from you ${requests === 1 ? 'is' : 'are'} still pending.`);
  if (quiet.length) lines.push(`Routines that went quiet: ${joinNames(quiet.map((r) => `${r.name} (${r.status})`))}.`);
  const open = b.tasks?.open || 0;
  if (open > urgent.length) lines.push(`${plural(open, 'open task')} in total.`);

  const n = urgent.length + approvals.length + waitingCount + quiet.length;
  return { title: n ? `Morning: ${plural(n, 'thing')} need${n === 1 ? 's' : ''} you` : 'Morning brief', body: lines.join('\n\n') };
}

async function morningNoteTick(ctx) {
  const note = composeNote(await buildBrief(ctx.userId, { agent: 'operations' }));
  if (!note) return { skipped: true, summary: 'Quiet day, nothing to post.' };
  await notify(ctx.userId, { category: 'routine', title: note.title.slice(0, 120), body: note.body, link: '/ai.html#tasks', routineSlug: 'morning-note' });
  return { items_found: 1, summary: 'Posted the morning note.', actions_taken: ['Posted the morning note to the Notification Centre'] };
}

module.exports = { composeNote, morningNoteTick };
