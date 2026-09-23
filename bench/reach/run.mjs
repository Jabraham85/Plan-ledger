#!/usr/bin/env node
// run.mjs — model-assisted reach. Design + hypotheses: PREREG.md.
//   node bench/reach/run.mjs run      # 3 reps, cached per rep in results/
//   node bench/reach/run.mjs report
//   BENCH_FAKE=1 …                    # plumbing check: a model that reaches nothing
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/db.mjs';
import { reevaluate } from '../../scripts/reevaluate.mjs';
import { makeAgent } from '../../scripts/brain-llm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = !!process.env.BENCH_FAKE;
// BENCH_TAG=v2 (PREREG A1): v1's held-out set becomes dev; heldout2 is confirmatory.
const TAG = process.env.BENCH_TAG || '';
const RES = join(HERE, FAKE ? `results-fake${TAG}` : TAG ? `results-${TAG}` : 'results');
const REPS = 3, CAP = 3, MODEL = 'deepseek-v4-pro';
mkdirSync(RES, { recursive: true });
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const SJ = readJson(join(HERE, 'scenarios.json'));
const tagged = (xs, set) => (xs || []).map((x) => ({ ...x, set }));
const HELD = TAG.startsWith('v3') ? [...tagged(SJ.heldout, 'dev'), ...tagged(SJ.heldout2, 'dev'), ...tagged(SJ.heldout3, 'heldout')]
  : TAG === 'v2' ? [...tagged(SJ.heldout, 'dev'), ...tagged(SJ.heldout2, 'heldout')]
  : tagged(SJ.heldout, 'heldout');
// development: the two revision stories whose misses motivated this (s1f pronoun, s2d consequence)
const REV = readJson(join(HERE, '../revision/scenarios.json')).stories;
const DEV = REV.filter((s) => ['frog', 'heist'].includes(s.sid)).map((s) => ({ ...s, set: 'dev',
  facts: s.facts.map((f) => ({ ...f, label: ['s1f', 's2d'].includes(f.fid) ? 'hidden' : f.label })) }));
const SCEN = [...DEV, ...HELD];

const fake = async (p) => ({ is_error: false, cost: 0, result: p.includes('REACH:') ? 'REACH: []' : 'RESOLVE: {"verdict":"confirmed"}' });

async function runRep(rep) {
  const out = join(RES, `rep${rep}.json`);
  if (existsSync(out)) { console.log(`rep ${rep}: cached`); return; }
  const agent = FAKE ? fake : makeAgent({ root: null, model: MODEL });
  let cost = 0;
  const res = { rep, model: MODEL, scenarios: [] };
  for (const sc of SCEN) {
    if (cost > CAP) throw new Error('CAP reached');
    const s = new Store(':memory:');
    const ids = {};
    for (const f of sc.facts) ids[f.fid] = s.absorbFindings([{ subject: f.subject, claim: f.claim }]).results[0].id;
    const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    const tw = s.absorbFindings([sc.twist]).results[0];
    const calls = [];
    const call = async (p) => { const r = await agent(p); cost += r.cost || 0; calls.push({ prompt: p, result: r.result, cost: r.cost, peak: r.peak }); return r; };
    const r = await reevaluate(s, { call, log: (m) => console.log(`  [r${rep} ${sc.sid}] ${m}`) });
    const final = {};
    for (const [fid, id] of Object.entries(ids)) {
      let f = s.getFinding(id);
      while (f.status === 'superseded' && f.superseded_by) f = s.getFinding(f.superseded_by);
      final[fid] = { status: f.status, revised: f.id !== id, claim: f.claim };
    }
    res.scenarios.push({ sid: sc.sid, set: sc.set, swept: (tw.suspected || []).map((i) => byId[i]),
      reach: r.reach.map((x) => ({ ...x, picked: (x.picked || []).map((i) => byId[i] ?? i), opened: (x.opened || []).map((i) => byId[i] ?? i) })),
      final, calls });
    s.close();
  }
  res.cost = cost;
  writeFileSync(out, JSON.stringify(res, null, 2));
  console.log(`rep ${rep}: done $${cost.toFixed(4)}`);
}

function report() {
  const reps = [1, 2, 3].map((r) => join(RES, `rep${r}.json`)).filter(existsSync).map(readJson);
  const out = [], log = (s = '') => { out.push(s); console.log(s); };
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');
  log('# Model-assisted reach — results');
  log(`\n${reps.length} rep(s), ${MODEL}. Spend $${reps.reduce((s, r) => s + r.cost, 0).toFixed(3)}. Hypotheses fixed beforehand in PREREG.md.`);
  const T = () => ({ hid: [0, 0], keep: [0, 0], settled: [0, 0], must: [0, 0], keepChanged: [0, 0] });
  const tally = { dev: T(), heldout: T() };
  for (const sc of SCEN) {
    log(`\n### ${sc.set === 'heldout' ? '[HELD-OUT] ' : '[dev] '}${sc.sid} — "${sc.twist.claim}"\n`);
    log('| fact | label | ' + reps.map((r) => `r${r.rep}`).join(' | ') + ' |\n|---|---|' + reps.map(() => '---').join('|') + '|');
    for (const f of sc.facts) {
      const cells = reps.map((rp) => {
        const x = rp.scenarios.find((y) => y.sid === sc.sid);
        const swept = x.swept.includes(f.fid), reached = x.reach.some((r) => r.opened.includes(f.fid)), fin = x.final[f.fid];
        const t = tally[sc.set];
        if (f.label === 'hidden') { t.hid[1]++; if (reached) t.hid[0]++; t.settled[1]++; if (fin.status === 'retracted' || fin.revised) t.settled[0]++; }
        if (f.label === 'keep') { t.keep[1]++; if (reached) t.keep[0]++; t.keepChanged[1]++; if (fin.status !== 'active' || fin.revised) t.keepChanged[0]++; }
        // A2: only person-bound hidden facts must change; role facts are 'either'
        if (f.label === 'hidden' && f.settle === 'change') { t.must[1]++; if (fin.status === 'retracted' || fin.revised) t.must[0]++; }
        const how = swept ? 'swept' : reached ? 'REACHED' : '—';
        const end = fin.status === 'retracted' ? 'retracted' : fin.revised ? `revised: "${fin.claim.slice(0, 50)}"` : fin.status;
        return `${how} → ${end}`;
      });
      log(`| ${f.fid} "${f.claim}" | ${f.label} | ${cells.join(' | ')} |`);
    }
  }
  const h = tally.heldout, d = tally.dev;
  log('\n| hypothesis | result | rule | verdict |\n|---|---|---|---|');
  log(`| **R9** held-out hidden facts reached | ${h.hid[0]}/${h.hid[1]} (${pct(...h.hid)}) | ≥ 80% | **${h.hid[1] && h.hid[0] / h.hid[1] >= 0.8 ? 'PASS' : 'FAIL'}** |`);
  log(`| **R10** held-out keep facts reached (false alarms) | ${h.keep[0]}/${h.keep[1]} (${pct(...h.keep)}) | ≤ 20% | **${h.keep[1] && h.keep[0] / h.keep[1] <= 0.2 ? 'PASS' : 'FAIL'}** |`);
  log(`| R11 held-out hidden facts settled (revised/retracted) | ${h.settled[0]}/${h.settled[1]} (${pct(...h.settled)}) | descriptive; 0% without reach | — |`);
  log(`| dev: hidden reached / keep reached / settled | ${d.hid[0]}/${d.hid[1]} · ${d.keep[0]}/${d.keep[1]} · ${d.settled[0]}/${d.settled[1]} | descriptive | — |`);
  if (h.must[1]) {
    log(`| **R12** held-out must-change hidden facts revised/retracted | ${h.must[0]}/${h.must[1]} (${pct(...h.must)}) | ≥ 80% | **${h.must[0] / h.must[1] >= 0.8 ? 'PASS' : 'FAIL'}** |`);
    log(`| **R13** held-out keep facts changed | ${h.keepChanged[0]}/${h.keepChanged[1]} (${pct(...h.keepChanged)}) | ≤ 10% | **${h.keepChanged[0] / h.keepChanged[1] <= 0.1 ? 'PASS' : 'FAIL'}** |`);
  }
  writeFileSync(join(RES, 'REPORT.md'), out.join('\n') + '\n');
}

const phase = process.argv[2];
if (phase === 'run') { await Promise.all(Array.from({ length: REPS }, (_, i) => runRep(i + 1))); report(); }
else if (phase === 'report') report();
else { console.error('usage: run.mjs run|report'); process.exit(2); }
