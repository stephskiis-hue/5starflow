#!/usr/bin/env node
// Local model worker (Ollama on the MSI). Does the cheap AI OS work so Claude's weekly limit goes to
// connectors, Chrome and creative runs. It NEVER sends anything: it only drafts tasks and posts
// non-urgent notes. Talks to Railway through /api/ai with the same bearer token as request-gate.ps1.
//   node scripts/ollama-worker.js --job sms-triage|morning-summary
const fs = require('fs');
const path = require('path');

const SLUG = 'local-ollama-worker';
const API = (process.env.FIVESTARFLOW_URL || '').replace(/\/$/, '');
const TOKEN = process.env.FIVESTARFLOW_TOKEN || process.env.AI_TOKEN;
// 127.0.0.1, not localhost: Node 18 on Windows resolves localhost to ::1 first and Ollama only listens on IPv4.
const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace('//localhost', '//127.0.0.1').replace(/\/$/, '');
const MODEL = process.env.OLLAMA_MODEL || 'qwen3:4b';
const MAX_SMS = Number(process.env.OLLAMA_MAX_SMS || 10);
const job = (process.argv.find((a, i) => process.argv[i - 1] === '--job') || '').trim();

const skill = (name) => {
  try { return fs.readFileSync(path.join(__dirname, '../../.claude/skills', name, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, ''); }
  catch { return ''; }
};

async function api(method, route, body, agent) {
  const res = await fetch(`${API}/api/ai${route}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Agent': agent, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${data.error || ''}`);
  return data;
}

// Structured output: Ollama constrains the reply to the JSON schema. One retry on unparseable output.
async function ollama(system, user, schema) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, stream: false, think: false, format: schema, options: { temperature: 0.2, num_predict: 600, num_ctx: 8192 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    try { return JSON.parse((await res.json()).message.content); } catch { /* retry */ }
  }
  return null;
}

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['question', 'booking', 'reschedule', 'complaint', 'money', 'thanks', 'spam', 'other'] },
    urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
    whatHappened: { type: 'string' },
    whatNeeds: { type: 'string' },
    proposedResponse: { type: 'string' },
    confident: { type: 'boolean' },
  },
  required: ['category', 'urgency', 'whatHappened', 'whatNeeds', 'proposedResponse', 'confident'],
};
const OWNER_ONLY = new Set(['complaint', 'money']);
const PRICE = /\$\s?\d|\d+\s?(dollars|bucks)\b/i;   // belt and braces next to the server lint

async function smsTriage() {
  const agent = 'communication';
  const brief = await api('GET', '/brief?agent=communication', null, agent);
  if (!brief.inbound?.unansweredSms) return { status: 'skipped', summary: 'No unanswered texts.', agent };

  const system = `You triage inbound customer texts for No-Bs Yardwork and draft replies for the owner to approve. You never send anything.
Reply with JSON only. proposedResponse is the SMS draft (under 300 characters). If the text is about money, a price, a complaint,
damage, a refund, a schedule promise or you are unsure, set confident=false. Never write a price or a dollar amount.
Categories: question = asks about a service; booking = wants work done or a quote; reschedule = moving a visit;
complaint = unhappy, damage, missed work; money = invoice, payment, refund, price; thanks = thank you or praise;
spam = not from a real customer (ads, scams, wrong number); other = anything else. A real customer is never spam.\n\n${skill('nobs-communication')}\n\n${skill('nobs-brand')}`;

  const items = (await api('GET', `/inbox/unanswered-sms?limit=${MAX_SMS}`, null, agent)).slice(0, MAX_SMS);
  const actions = [];
  for (const sms of items) {
    const ctx = await api('GET', `/customers/context?phone=${encodeURIComponent(sms.phone)}`, null, agent).catch(() => ({}));
    if (ctx.customer?.optedOut) { actions.push(`Skipped sms:${sms.phone} (opted out)`); continue; }
    const timeline = (ctx.sms?.timeline || []).slice(0, 10).reverse()
      .map((m) => `${m.dir === 'in' ? 'Customer' : 'No-Bs'}: ${String(m.body || '').slice(0, 200)}`).join('\n');
    const user = `Customer: ${sms.clientName || 'unknown'} (${sms.phone}), waiting ${sms.waitingMinutes} min.
Latest text: "${sms.lastMessage}"
Recent conversation (oldest first):\n${timeline || '(none)'}
First name: ${ctx.customer?.firstName || 'unknown'}
Known context: ${JSON.stringify({ ...ctx, sms: undefined, customer: undefined }).slice(0, 1500)}`;

    const t = await ollama(system, user, TRIAGE_SCHEMA);
    let draft = t?.proposedResponse?.trim() || '';
    const lint = draft ? await api('POST', '/content/lint', { caption: draft }, agent).catch(() => null) : null;
    const lintErrors = [...(lint?.errors || []), ...(draft && !lint ? ['Brand lint unavailable.'] : []), ...(PRICE.test(draft) ? ['Contains a price.'] : [])];
    const needsOwner = !t || !t.confident || OWNER_ONLY.has(t.category) || lintErrors.length > 0;
    if (lintErrors.length) draft = '';   // a draft that breaks brand rules is worse than none

    await api('POST', '/tasks', {
      dedupKey: `sms:${sms.phone}`,
      title: `Reply to ${sms.clientName || sms.phone}${t ? ` (${t.category})` : ''}`,
      source: 'routine', routineSlug: SLUG,
      customerName: sms.clientName || null, customerKey: sms.jobberClientId || sms.phone,
      whatHappened: t?.whatHappened || `Text: "${sms.lastMessage}"`,
      whatNeeds: needsOwner ? `Needs the owner or Claude. ${t?.whatNeeds || ''}${lintErrors.length ? ` Draft failed brand lint: ${lintErrors.join(' ')}` : ''}`.trim() : t.whatNeeds,
      proposedResponse: draft,
      urgency: needsOwner || sms.waitingMinutes > 24 * 60 ? 'high' : t.urgency,
      context: { by: 'ollama', model: MODEL, category: t?.category, confident: !!t?.confident },
    }, agent);
    actions.push(`Drafted task sms:${sms.phone}${needsOwner ? ' (flagged for owner)' : ''}`);
  }
  return { status: 'completed', items_found: items.length, requires_attention: items.length, summary: `Triaged ${items.length} unanswered text(s) on ${MODEL}.`, actions_taken: actions, agent };
}

async function morningSummary() {
  const agent = 'operations';
  const b = await api('GET', '/brief?agent=operations', null, agent);
  const facts = {
    openTasks: (b.tasks?.top || []).map((t) => ({ title: t.title, urgency: t.urgency, customer: t.customer, timesFlagged: t.flagged })),
    approvals: (b.approvals?.items || []).map((a) => a.summary),
    unhealthyRoutines: (b.routines?.unhealthy || []).map((r) => `${r.name} (${r.status})`),
    customersWaiting: b.inbound?.items || [],
  };
  const quiet = !facts.openTasks.length && !facts.approvals.length && !facts.unhealthyRoutines.length && !facts.customersWaiting.length;
  if (quiet) return { status: 'skipped', summary: 'Quiet day, nothing to post.', agent };

  const out = await ollama(
    `You write the owner's morning note for No-Bs Yardwork. Under 200 words, plain and human, no dashes mid-sentence, no markdown headers.
Order: most important first (biggest dollar figures, customers waiting longest), then every pending approval, then routines that went quiet. Mention every item given. Only use the facts given:
report them to the owner, never promise or invent an action (no "we'll call").\n\n${skill('nobs-brand')}`,
    JSON.stringify(facts),
    { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
  );
  if (!out?.body) throw new Error('model returned no summary');
  // The lists are appended by code so a small model can't drop one.
  const lists = [
    facts.approvals.length && `Waiting on your approval: ${facts.approvals.join('. ')}.`,
    facts.unhealthyRoutines.length && `Routines that went quiet: ${facts.unhealthyRoutines.join(', ')}.`,
    facts.customersWaiting.length && `Customers waiting on a reply: ${facts.customersWaiting.map((c) => c.name || c.phone).join(', ')}.`,
  ].filter(Boolean).join('\n');
  await api('POST', '/notify', { title: out.title.slice(0, 120) || 'Morning brief', body: [out.body, lists].filter(Boolean).join('\n\n'), category: 'routine', link: '/ai.html#tasks', routineSlug: SLUG }, agent);
  return { status: 'completed', items_found: facts.openTasks.length, summary: 'Posted the morning note.', actions_taken: ['Posted morning note to the Notification Centre'], agent };
}

const JOBS = { 'sms-triage': smsTriage, 'morning-summary': morningSummary };

(async () => {
  if (!JOBS[job]) { console.error(`usage: --job ${Object.keys(JOBS).join('|')}`); process.exit(2); }
  if (!API || !TOKEN) { console.error('FIVESTARFLOW_URL and FIVESTARFLOW_TOKEN are required'); process.exit(2); }
  const startedAt = new Date().toISOString();
  let report;
  try {
    const r = await JOBS[job]();
    report = { status: r.status, summary: `[${job}] ${r.summary}`, agent: r.agent, result: { summary: `[${job}] ${r.summary}`, items_found: r.items_found || 0, requires_attention: r.requires_attention || 0, actions_taken: r.actions_taken || [] } };
  } catch (e) {
    report = { status: 'failed', summary: `[${job}] failed`, error: `${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`, agent: job === 'sms-triage' ? 'communication' : 'operations' };
  }
  console.log(JSON.stringify(report));
  await api('POST', '/runs', { slug: SLUG, trigger: 'schedule', startedAt, finishedAt: new Date().toISOString(), ...report }, report.agent)
    .catch((e) => console.error('could not report run:', e.message));
  process.exit(report.status === 'failed' ? 1 : 0);
})();
