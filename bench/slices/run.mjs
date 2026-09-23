#!/usr/bin/env node
// slices/run.mjs — how much of what a task needs actually reaches its brief?
// Offline, zero model calls. Brain = the 144 real Part A findings (strict_full).
// Tasks = the 12 H3b v2 questions, 5 needed facts each (60 facts).
//
// A finding COVERS a needed fact when its claim (or subject) matches the fact's
// context pattern AND states the fact's value as a number token. The CEILING is
// what the whole brain covers; each strategy is scored against it.
//
//   node bench/slices/run.mjs            → prints the table, writes bench/slices/REPORT.md
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, claimTokens } from '../../src/db.mjs';
import { pickBrief } from '../../scripts/runner-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const agents = JSON.parse(readFileSync(join(HERE, '../findings-real/results-deepseek/a/findings.json'), 'utf8'));
const QS = JSON.parse(readFileSync(join(HERE, '../findings-real/questions-h3b.json'), 'utf8')).questions;

// The 26 facts the H3b v2 questions were built from (same letters as their generator).
const FACT = {
  A: { v: ['4319'], ctx: /port/i }, B: { v: ['4399'], ctx: /port|boot/i }, C: { v: ['350'], ctx: /cop(y|ies)|retr|sleep/i },
  D: { v: ['20'], ctx: /poll|boot|api\/plans/i }, E: { v: ['3000'], ctx: /busy/i }, F: { v: ['4', '4194304'], ctx: /journal/i },
  G: { v: ['4'], ctx: /user.?version|schema/i }, H: { v: ['10'], ctx: /getstep|attempts/i }, I: { v: ['5'], ctx: /getlessons|lessons/i },
  J: { v: ['8'], ctx: /recall/i }, K: { v: ['20'], ctx: /queryfindings/i }, L: { v: ['0.7'], ctx: /threshold|near/i },
  M: { v: ['20'], ctx: /findings_max|findings/i }, N: { v: ['10', '600000'], ctx: /verify|timeout/i }, O: { v: ['500'], ctx: /verify|tail|output/i },
  P: { v: ['2'], ctx: /max.?attempts/i }, Q: { v: ['30'], ctx: /retry.?minutes/i }, R: { v: ['48'], ctx: /max.?retries/i },
  S: { v: ['2'], ctx: /buffer/i }, T: { v: ['12'], ctx: /reset|sanity|cap/i }, U: { v: ['112'], ctx: /pe32|data.?dir/i },
  V: { v: ['96'], ctx: /pe32|data.?dir/i }, W: { v: ['64'], ctx: /checksum/i }, X: { v: ['4'], ctx: /director/i },
  Y: { v: ['2', '3'], ctx: /tokeni[sz]e/i }, Z: { v: ['600000', '10'], ctx: /verify|timeout/i },
};
const SETS = ['AEPMU', 'BGQOV', 'CHRNW', 'DISTX', 'JKMPA', 'FEBQO', 'YJIMR', 'GWTZA', 'VHSDR', 'LKPUC', 'XOJQB', 'GITEW'];
const nums = (s) => new Set(String(s).match(/\d+(?:\.\d+)?/g) || []);
const covers = (f, key) => { const t = `${f.subject} ${f.claim}`; const n = nums(f.claim); return FACT[key].ctx.test(t) && FACT[key].v.some((v) => n.has(v)); };

const brain = new Store(':memory:');
const plan = brain.createPlan({ title: 'brain' });
for (const a of agents) if (a.findings.length) brain.absorbFindings(a.findings.map(({ id, ...f }) => f), { plan_id: plan.id, source: a.agent });
const all = brain.queryFindings({ plan_id: plan.id, limit: 200 });
const parts = (q) => q.q.split('\n').filter((l) => /^\(\d\)/.test(l)).map((l) => l.replace(/^\(\d\)\s*/, ''));

// Diversity: walk a longer ranked list, skip a finding that restates one already
// picked (same subject and similar wording) — the brain stores ~2 rows per fact.
const jac = (a, b) => { let i = 0; for (const t of a) if (b.has(t)) i++; return i / (a.size + b.size - i || 1); };
function diverse(ranked, k) {
  const out = [];
  for (const f of ranked) {
    const c = claimTokens(f.claim).content;
    if (out.some((o) => o.subject === f.subject && jac(c, claimTokens(o.claim).content) >= 0.35)) continue;
    out.push(f);
    if (out.length === k) break;
  }
  return out;
}
const q = (query, limit) => brain.queryFindings({ plan_id: plan.id, query, limit });
const union = (lists) => { const seen = new Set(), out = []; for (const l of lists) for (const f of l) if (!seen.has(f.id)) { seen.add(f.id); out.push(f); } return out; };

const STRATS = {
  'S0 whole task, top 5 (today)': (t) => q(t.q, 5),
  'S1 whole task, top 10': (t) => q(t.q, 10),
  'S2 whole task, top 5, diverse': (t) => diverse(q(t.q, 40), 5),
  'S3 per part, top 1 each (5 lines)': (t) => union(parts(t).map((p) => q(p, 1))),
  'S4 per part, top 1 diverse (5 lines)': (t) => union(parts(t).map((p) => diverse(q(p, 10), 1))),
  'S5 per part, top 2 each (≤10 lines)': (t) => union(parts(t).map((p) => q(p, 2))),
  // the function the runner actually ships (splits the raw text itself)
  'SHIPPED pickBrief (runner-lib, 5 lines)': (t) => pickBrief((text, k) => q(text, k), t.q, { limit: 5 }),
};

const out = [], log = (s = '') => { out.push(s); console.log(s); };
let ceilN = 0;
const ceilByQ = {};
QS.forEach((t, i) => { ceilByQ[t.id] = [...SETS[i]].filter((k) => all.some((f) => covers(f, k))); ceilN += ceilByQ[t.id].length; });
log('# Slice coverage — how much of what a task needs reaches its brief?');
log(`\nOffline, zero model calls. Brain: ${all.length} live findings (144 real Part A reports, strict_full). ` +
  `Tasks: ${QS.length} H3b questions × 5 needed facts = ${QS.length * 5}. The brain holds ${ceilN}/${QS.length * 5} of them (the ceiling).\n`);
log('| strategy | needed facts in the brief | of the ceiling | mean brief lines | mean brief chars |');
log('|---|---|---|---|---|');
const res = {};
for (const [name, fn] of Object.entries(STRATS)) {
  let hit = 0, lines = 0, chars = 0;
  QS.forEach((t, i) => {
    const b = fn(t);
    lines += b.length; chars += b.reduce((s, f) => s + f.subject.length + f.claim.length + 12, 0);
    hit += [...SETS[i]].filter((k) => b.some((f) => covers(f, k))).length;
  });
  res[name] = hit;
  log(`| ${name} | ${hit}/${QS.length * 5} (${Math.round((100 * hit) / (QS.length * 5))}%) | ${Math.round((100 * hit) / ceilN)}% | ${(lines / QS.length).toFixed(1)} | ${Math.round(chars / QS.length)} |`);
}
log(`\nNeeded facts the brain does not hold at all: ${QS.length * 5 - ceilN} (${[...new Set(QS.flatMap((t, i) => [...SETS[i]].filter((k) => !ceilByQ[t.id].includes(k))))].sort().join(', ')}) — no retrieval can fix those.`);
log('\n**Caveats (exploratory, not pre-registered).**');
log('- The strategies were fixed before the first run. The shipped `pickBrief` is S3 turned into code, written *after* seeing S3 win.');
log('- These tasks are explicitly multi-part. Real steps are looser prose, so expect a smaller gain there.');
log('- "Covers" is a pattern-plus-value match, not a judge.');
log('- The 16 needed facts the brain never held are a *learning* gap (Part A never investigated them), not a retrieval gap.');
writeFileSync(join(HERE, 'REPORT.md'), out.join('\n') + '\n');
brain.close();
