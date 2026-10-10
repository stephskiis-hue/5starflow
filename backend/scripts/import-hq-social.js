#!/usr/bin/env node
/**
 * One-time import of the old HQ social state into 5StarFlow (HQ is retired as the engine; 5StarFlow is the source of truth).
 *   node backend/scripts/import-hq-social.js [--dry] [--hq "C:\path\to\HQ"]
 * Reads FIVESTARFLOW_URL / FIVESTARFLOW_TOKEN from the environment or ~/.5starflow/env. Safe to re-run: groups upsert by name,
 * memory upserts by key. Phone numbers and customer names are never in HQ files, so nothing private moves.
 *   groups       HQ/social/state.json -> POST /api/ai/social/groups (membership, promo policy, rules, last post, lead count)
 *   brain notes  HQ/social/brain.md "Run notes worth keeping" -> POST /api/ai/memory (scope agent:social)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const hqIdx = args.indexOf('--hq');
const HQ = hqIdx >= 0 ? args[hqIdx + 1] : 'C:\\Users\\steph\\Desktop\\No-Bs Yardwork\\HQ';

function loadEnv() {
  const envFile = path.join(os.homedir(), '.5starflow', 'env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  if (!process.env.FIVESTARFLOW_URL || !process.env.FIVESTARFLOW_TOKEN) throw new Error('FIVESTARFLOW_URL and FIVESTARFLOW_TOKEN are required');
}

const RELEVANCE = { lead: 4, ad: 3, community: 3, buysell: 2 };

/** HQ group -> POST /social/groups body. */
function mapGroup(g) {
  const lastPost = (g.posts || []).map((p) => p.date).filter(Boolean).sort().pop();
  const rules = [g.promoDays && `Promo days: ${g.promoDays}`, g.perWeek && `Max ${g.perWeek} per week`, g.perDay && `Max ${g.perDay} per day`, g.approval && `Approval: ${g.approval}`, g.rulesCheckedOn && `Rules last checked ${g.rulesCheckedOn}`].filter(Boolean).join('. ');
  return {
    name: g.name, platform: 'facebook', url: g.url || undefined,
    membership: g.member ? 'member' : 'unknown',
    promoPolicy: g.promo === true ? 'allowed' : g.promo === false ? 'restricted' : 'unknown',   // unknown = read the rules before the first promo post
    relevance: RELEVANCE[g.category] || 3, audience: g.category || undefined,
    rules: rules || undefined, notes: [g.notes, g.status && g.status !== 'active' ? `HQ status: ${g.status}` : ''].filter(Boolean).join(' | ') || undefined,
    cooldownDays: g.perWeek ? Math.max(1, Math.round(7 / g.perWeek)) : undefined,
    leadsDelta: g.leadsFound || undefined,
    lastPostedAt: lastPost ? `${lastPost}T12:00:00Z` : undefined, postsCount: (g.posts || []).length || undefined,
  };
}

/** Bullets under "## Run notes worth keeping" in brain.md. */
function brainNotes(md) {
  const m = md.match(/## Run notes worth keeping\s*([\s\S]*?)(?:\n## |$)/);
  if (!m) return [];
  return m[1].split(/\r?\n/).filter((l) => l.startsWith('- ')).map((l, i) => ({ scope: 'agent:social', key: `hq-note-${String(i + 1).padStart(2, '0')}`, value: l.slice(2).trim(), confidence: 0.7, source: 'hq-brain-import' }));
}

async function post(p, body) {
  const res = await fetch(process.env.FIVESTARFLOW_URL + p, { method: 'POST', headers: { Authorization: `Bearer ${process.env.FIVESTARFLOW_TOKEN}`, 'X-Agent': 'social', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${p} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(HQ, 'social', 'state.json'), 'utf8'));
  const groups = (state.groups || []).map(mapGroup);
  const notes = brainNotes(fs.readFileSync(path.join(HQ, 'social', 'brain.md'), 'utf8'));
  console.log(`${groups.length} groups, ${notes.length} brain notes${dry ? ' (dry run, nothing sent)' : ''}`);
  if (dry) { console.log(JSON.stringify(groups.slice(0, 2), null, 1)); console.log(JSON.stringify(notes.slice(0, 1), null, 1)); return; }
  loadEnv();
  let ok = 0;
  for (const g of groups) { try { await post('/api/ai/social/groups', g); ok++; } catch (e) { console.log('group failed:', g.name, e.message); } }
  let n = 0;
  for (const m of notes) { try { await post('/api/ai/memory', m); n++; } catch (e) { console.log('note failed:', m.key, e.message); } }
  console.log(`imported ${ok}/${groups.length} groups, ${n}/${notes.length} notes`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { mapGroup, brainNotes };
