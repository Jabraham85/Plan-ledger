#!/usr/bin/env node
// run.mjs — can the brain revise itself? Design + hypotheses: PREREG.md.
//
//   SNAPSHOT=<frozen code dir> node bench/revision/run.mjs run      # 3 reps (cached per rep)
//   node bench/revision/run.mjs report                               # → results/REPORT.md
//
// Every rep is written to results/rep<N>.json and never re-run (no double spend).
// The model's full prompt + answer for every re-evaluation is kept in the rep file.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/db.mjs';
import { reevaluate } from '../../scripts/reevaluate.mjs';
import { makeAgent as realAgent } from '../../scripts/brain-llm.mjs';
const makeAgent = (o) => (process.env.BENCH_FAKE ? async () => ({ is_error: false, result: 'RESOLVE: {"verdict":"confirmed","reason":"fake"}', cost: 0, turns: 1 }) : realAgent(o));

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = !!process.env.BENCH_FAKE; // plumbing dry run: a scripted model, separate results
// BENCH_TAG=v2 (PREREG A1): the minimal-change prompt, on code + dev + held-out stories.
const TAG = process.env.BENCH_TAG || '';
const RES = join(HERE, FAKE ? 'results-fake' : TAG ? `results-${TAG}` : 'results');
const WORK = join(HERE, 'work');
const SC = JSON.parse(readFileSync(join(HERE, 'scenarios.json'), 'utf8'));
const REPS = 3, CAP = 5, MODEL = 'deepseek-v4-pro';
mkdirSync(RES, { recursive: true });
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const spentSoFar = () => [1, 2, 3].map((r) => join(RES, `rep${r}.json`)).filter(existsSync).reduce((s, f) => s + readJson(f).cost, 0);

// Wrap a model call so every prompt/answer is recorded, and the cap is enforced.
function recorder(call, log, state) {
  return async (prompt) => {
    if (state.base + state.cost > CAP) throw new Error(`CAP $${CAP} reached`);
    const r = await call(prompt);
    state.cost += r.cost || 0;
    log.push({ prompt, result: r.result, cost: r.cost, turns: r.turns, peak: r.peak, is_error: r.is_error, subtype: r.subtype });
    return r;
  };
}

// Where did a finding end up? Follow superseded_by to the current version.
function finalState(s, id) {
  let f = s.getFinding(id);
  for (let hops = 0; f.status === 'superseded' && f.superseded_by && hops < 20; hops++) f = s.getFinding(f.superseded_by);
  return { status: f.status, id: f.id, claim: f.claim, revised: f.id !== id };
}

function absorbAll(s, items, opts = {}) {
  const ids = {};
  for (const it of items) {
    const r = s.absorbFindings([{ subject: it.subject, claim: it.claim, slot: it.slot, evidence: it.evidence,
      depends_on: (it.depends_on || []).map((f) => ids[f]) }], opts).results[0];
    if (!['created'].includes(r.outcome)) throw new Error(`setup: ${it.fid} → ${r.outcome}`);
    ids[it.fid] = r.id;
  }
  return ids;
}

async function runRep(rep) {
  const out = join(RES, `rep${rep}.json`);
  if (existsSync(out)) { console.log(`rep ${rep}: cached`); return; }
  const SNAP = resolve(process.env.SNAPSHOT || '');
  if (!process.env.SNAPSHOT || !existsSync(SNAP)) throw new Error('SNAPSHOT must point at the frozen code directory');
  const state = { base: spentSoFar(), cost: 0 };
  const result = { rep, model: MODEL, started: new Date().toISOString(), code: null, stories: [], cost: 0 };

  // ---- Part C: code --------------------------------------------------------------
  {
    const dir = join(WORK, `r${rep}`);
    rmSync(dir, { recursive: true, force: true });
    cpSync(SNAP, dir, { recursive: true });
    const s = new Store(':memory:');
    const ids = absorbAll(s, SC.code.findings, { root: dir });
    const fileLinked = Object.fromEntries(SC.code.findings.map((f) => [f.fid, s.getFinding(ids[f.fid]).depends_on.some((d) => d.type === 'file')]));
    for (const e of SC.code.edits) {
      const p = join(dir, e.file), txt = readFileSync(p, 'utf8');
      const n = txt.split(e.find).length - 1;
      if (n !== 1) throw new Error(`edit ${e.eid}: expected exactly 1 match in ${e.file}, found ${n}`);
      writeFileSync(p, txt.replace(e.find, e.replace));
    }
    const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    const stale = s.checkStale();
    const log = [];
    const r = await reevaluate(s, { call: recorder(makeAgent({ root: dir, model: MODEL }), log, state), tools: true,
      log: (m) => console.log(`  [r${rep} code] ${m}`) });
    result.code = {
      fileLinked,
      flagged_by_stale: stale.suspected.map((i) => byId[i]),
      evaluated: r.results.map((x) => ({ fid: byId[x.id] ?? `#${x.id}`, verdict: x.verdict, new_claim: x.new_claim, reason: x.reason, error: x.error })),
      final: Object.fromEntries(Object.entries(ids).map(([fid, id]) => [fid, finalState(s, id)])),
      left_suspect: r.left.map((i) => byId[i] ?? `#${i}`), rounds: r.rounds, cost: r.cost, calls: log,
    };
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- Part S: stories ----------------------------------------------------------------
  const storySets = storySetsFor(TAG);
  for (const st of storySets) {
    const s = new Store(':memory:');
    const ids = absorbAll(s, st.facts);
    const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    const tw = s.absorbFindings([{ ...st.twist }]).results[0];
    const flagged = (tw.suspected || []).map((i) => byId[i]);
    const log = [];
    const r = await reevaluate(s, { call: recorder(makeAgent({ root: null, model: MODEL }), log, state), tools: false,
      log: (m) => console.log(`  [r${rep} ${st.sid}] ${m}`) });
    result.stories.push({ sid: st.sid, set: st.set, twist_outcome: tw.outcome, flagged,
      evaluated: r.results.map((x) => ({ fid: byId[x.id] ?? `#${x.id}`, verdict: x.verdict, new_claim: x.new_claim, reason: x.reason, error: x.error })),
      final: Object.fromEntries(Object.entries(ids).map(([fid, id]) => [fid, finalState(s, id)])),
      left_suspect: r.left.map((i) => byId[i] ?? `#${i}`), cost: r.cost, calls: log });
    s.close();
  }
  result.cost = state.cost;
  result.finished = new Date().toISOString();
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`rep ${rep}: done, $${state.cost.toFixed(4)}`);
}

// Which stories a run uses, and which set is CONFIRMATORY for it (PREREG A1/A2):
// v1 → dev only; v2 → heldout confirmatory; v3 → heldout becomes dev, heldout2 confirmatory.
function storySetsFor(tag) {
  const tagged = (xs, set) => (xs || []).map((x) => ({ ...x, set }));
  if (tag === 'v2') return [...tagged(SC.stories, 'dev'), ...tagged(SC.heldout, 'heldout')];
  if (tag === 'v3') return [...tagged(SC.stories, 'dev'), ...tagged(SC.heldout, 'dev'), ...tagged(SC.heldout2, 'heldout')];
  return tagged(SC.stories, 'dev');
}

// ---- grading ------------------------------------------------------------------------
function acceptable(item, fin) {
  if (item.label === 'keep') return fin.status === 'active' && !fin.revised;
  if (item.label !== 'change') return null;
  if (fin.status === 'retracted') return item.accept.includes('retracted');
  if (fin.status !== 'active' || !fin.revised || !item.accept.includes('revised')) return false;
  const c = fin.claim.toLowerCase();
  return (item.must || []).every((m) => c.includes(m.toLowerCase())) && !(item.mustNot || []).some((m) => c.includes(m.toLowerCase()));
}

function report() {
  const reps = [1, 2, 3].map((r) => join(RES, `rep${r}.json`)).filter(existsSync).map(readJson);
  const out = [], log = (s = '') => { out.push(s); console.log(s); };
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : 'n/a');
  const norm = (x) => x.calls.reduce((s, c) => s + (c.peak ? c.cost / 2 : c.cost), 0);
  log('# Can the brain revise itself? — results');
  log(`\nGenerated ${new Date().toISOString()} from ${reps.length} rep(s). Hypotheses fixed beforehand in PREREG.md. Model: ${MODEL}.`);
  log(`Spend: $${reps.reduce((s, r) => s + r.cost, 0).toFixed(3)} actual; $${reps.reduce((s, r) => s + norm(r.code) + r.stories.reduce((a, st) => a + norm(st), 0), 0).toFixed(3)} at off-peak rates.`);

  // Part C
  const F = SC.code.findings, onEdited = new Set(SC.code.edits.map((e) => e.file));
  const fileOf = (f) => (f.evidence?.[0] || '').split(':')[0];
  let r1 = true;
  const r2 = [0, 0], r3 = [0, 0], r4 = [0, 0], r5 = [0, 0];
  const rows = [];
  for (const rp of reps) {
    const c = rp.code, flagged = new Set(c.flagged_by_stale);
    const shouldFlag = F.filter((f) => onEdited.has(fileOf(f))).map((f) => f.fid);
    const okR1 = shouldFlag.every((x) => flagged.has(x)) && [...flagged].every((x) => shouldFlag.includes(x));
    r1 &&= okR1;
    const evaluated = new Set(c.evaluated.map((e) => e.fid));
    for (const f of F) {
      const fin = c.final[f.fid], ok = acceptable(f, fin);
      r5[1]++; if (ok) r5[0]++;
      if (evaluated.has(f.fid) && flagged.has(f.fid)) {
        if (f.label === 'change') { r2[1]++; if (ok) r2[0]++; } else { r3[1]++; if (ok) r3[0]++; }
      }
      if (f.fid === 'F7' || f.fid === 'F18') { r4[1]++; if (evaluated.has(f.fid) && ok) r4[0]++; }
      if (!ok || f.label === 'change') rows.push(`| r${rp.rep} | ${f.fid} | ${f.label} | ${evaluated.has(f.fid) ? c.evaluated.find((e) => e.fid === f.fid).verdict : '—'} | ` +
        `${fin.status}${fin.revised ? ' (revised)' : ''}: ${fin.claim.replace(/\|/g, '/').slice(0, 110)} | ${ok ? '✓' : '✗'} |`);
    }
    if (!okR1) log(`\n⚠ r${rp.rep} R1 mismatch: flagged ${[...flagged].join(',')} vs expected ${shouldFlag.join(',')}`);
  }
  log('\n## Part C — code\n');
  log('| hypothesis | result | rule | verdict |\n|---|---|---|---|');
  log(`| R1 deterministic detection | ${r1 ? 'exact in every rep' : 'mismatch'} | 100% edited-file findings, 0 others | **${r1 ? 'PASS' : 'FAIL'}** |`);
  log(`| R2 changed facts settled right | ${r2[0]}/${r2[1]} (${pct(...r2)}) | ≥ 90% | **${r2[1] && r2[0] / r2[1] >= 0.9 ? 'PASS' : 'FAIL'}** |`);
  log(`| R3 false alarms cleared | ${r3[0]}/${r3[1]} (${pct(...r3)}) | ≥ 90% | **${r3[1] && r3[0] / r3[1] >= 0.9 ? 'PASS' : 'FAIL'}** |`);
  log(`| R4 cascade (F7, F18) | ${r4[0]}/${r4[1]} | ≥ 5/6 | **${r4[0] >= 5 && r4[1] === 6 ? 'PASS' : 'FAIL'}** |`);
  log(`| R5 brain correct afterwards | ${r5[0]}/${r5[1]} (${pct(...r5)}) | ≥ 95% (no-TM baseline 70%) | **${r5[1] && r5[0] / r5[1] >= 0.95 ? 'PASS' : 'FAIL'}** |`);
  log('\nChanged facts and every miss:\n\n| rep | fid | label | model verdict | final state | ok |\n|---|---|---|---|---|---|');
  rows.forEach((r) => log(r));

  // Part S
  log('\n## Part S — stories\n');
  const r6 = [0, 0];
  const score = { dev: { r6: [0, 0], keep: [0, 0], recall: [0, 0] }, heldout: { r6: [0, 0], keep: [0, 0], recall: [0, 0] } };
  const sets = storySetsFor(TAG).filter((st) => reps.some((rp) => rp.stories.some((x) => x.sid === st.sid)));
  for (const st of sets) {
    const sc = score[st.set];
    log(`\n### ${st.set === 'heldout' ? '[HELD-OUT] ' : ''}${st.sid} — twist: "${st.twist.claim}" (impact ${st.twist.impact})\n`);
    log('| fact | label | ' + reps.map((r) => `r${r.rep}`).join(' | ') + ' |');
    log('|---|---|' + reps.map(() => '---').join('|') + '|');
    for (const f of st.facts.filter((x) => x.label !== 'base')) {
      const cells = reps.map((rp) => {
        const sr = rp.stories.find((x) => x.sid === st.sid), fin = sr.final[f.fid];
        const flagged = sr.flagged.includes(f.fid) || sr.evaluated.some((e) => e.fid === f.fid);
        const ok = acceptable(f, fin);
        if (f.label === 'change') { sc.recall[1]++; if (flagged) sc.recall[0]++; }
        if (flagged && ok !== null) { sc.r6[1]++; if (ok) sc.r6[0]++; }
        if (flagged && f.label === 'keep') { sc.keep[1]++; if (ok) sc.keep[0]++; }
        const tag = !flagged ? 'not flagged' : fin.status === 'retracted' ? 'retracted' : fin.revised ? `revised: "${fin.claim.slice(0, 60)}"` : fin.status;
        return `${tag}${ok === null ? '' : ok ? ' ✓' : ' ✗'}`;
      });
      log(`| ${f.fid} "${f.claim}" | ${f.label} | ${cells.join(' | ')} |`);
    }
  }
  log(`\n| hypothesis | result | rule | verdict |\n|---|---|---|---|`);
  const d = score.dev, h = score.heldout, P = (x, t) => (x[1] && x[0] / x[1] >= t ? 'PASS' : 'FAIL');
  log(`| R6 dev stories settled right${TAG ? ' (development data — descriptive)' : ''} | ${d.r6[0]}/${d.r6[1]} (${pct(...d.r6)}) | ≥ 80% | ${TAG ? '—' : `**${P(d.r6, 0.8)}**`} |`);
  log(`| R7 frog-rule / cascade reach, dev (descriptive) | ${d.recall[0]}/${d.recall[1]} change facts flagged (${pct(...d.recall)}) | predicted 6/8 per rep (misses s1f, s2d) | — |`);
  log(`| dev keep facts confirmed unchanged (descriptive) | ${d.keep[0]}/${d.keep[1]} (${pct(...d.keep)}) | — | — |`);
  if (h.r6[1]) {
    log(`| **R6′ HELD-OUT stories settled right** | ${h.r6[0]}/${h.r6[1]} (${pct(...h.r6)}) | ≥ 80% | **${P(h.r6, 0.8)}** |`);
    log(`| **R8 held-out keep facts confirmed unchanged** | ${h.keep[0]}/${h.keep[1]} (${pct(...h.keep)}) | ≥ 90% | **${P(h.keep, 0.9)}** |`);
    log(`| reach, held-out (descriptive) | ${h.recall[0]}/${h.recall[1]} change facts flagged (${pct(...h.recall)}) | — | — |`);
  }
  writeFileSync(join(RES, 'REPORT.md'), out.join('\n') + '\n');
  console.log(`\n→ ${join(RES, 'REPORT.md')}`);
}

const phase = process.argv[2];
if (phase === 'run') { await Promise.all(Array.from({ length: REPS }, (_, i) => runRep(i + 1))); report(); }
else if (phase === 'report') report();
else { console.error('usage: run.mjs run|report'); process.exit(2); }
