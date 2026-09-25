#!/usr/bin/env node
// learn.mjs — prime the brain for upcoming steps: a read-only agent investigates
// the code each step will touch, every fact it reports is independently VERIFIED
// against the source (F4: the clause-by-clause re-evaluator), and only verified
// facts (confirmed, or revised to what the code says) are absorbed — each with its
// step as provenance and linked to its files so it goes stale when the code changes.
//
//   node scripts/learn.mjs --steps 670,671 [--root DIR] [--no-verify] [--dry-run]
//   node scripts/learn.mjs --plan 130            # every pending/in-progress step
//   --root      the source tree (default: the project's set_project_root)
//   --dry-run   learn + verify, print what would be absorbed, write nothing
//   --max-usd   stop starting new steps past this spend (default 5)
//   --force     re-learn steps that already have learned facts (default: skip them)
//
// Measured (real-project study): learners alone 87–95% true; verification is Round 3.
import { Store, defaultDbPath } from '../src/db.mjs';
import { FINDINGS_INSTRUCTIONS, parseFindings, formatFindingLines } from './runner-lib.mjs';
import { reevaluate } from './reevaluate.mjs';
import { makeAgent } from './brain-llm.mjs';
import { fileURLToPath } from 'node:url';

// brief: live facts the brain already holds for this step (Store.stepBrief). Shown with
// their #ids so a new fact can say what it is built on (depends_on) — without it every
// learned fact stood alone and nothing was ever re-checked when another fact changed.
export const learnPrompt = (st, brief = []) => [
  `You are about to start this step in the project in the current directory:`,
  ``, `STEP: ${st.title}`, st.context || '', st.acceptance_criteria ? `Acceptance: ${st.acceptance_criteria}` : '', ``,
  `Do NOT implement it. Investigate the EXISTING code, data and tools this step will build on or change, and record what`,
  `someone doing this step must know: where things live, how the relevant systems work, constraints, conventions, pitfalls.`,
  `Read the source — never guess. Use repo-relative paths in evidence, as path:line.`,
  ...formatFindingLines(brief),
  ...(brief.length ? [`Do not repeat those. When a new finding builds on one of them (it extends it, relies on it, or would be`,
    `wrong if it were wrong), add "depends_on":[#id numbers] to that finding.`] : []),
  ...FINDINGS_INSTRUCTIONS,
  `Report between 3 and 10 findings. Each must be something you verified in the code, with evidence.`,
  `The FINAL LINE of your output MUST be exactly:`,
  `VERDICT: pass — <one-line summary of what you investigated>`,
].join('\n');

// steps: full step payloads. Returns per-step results; absorbs into `store` unless dryRun.
export async function learnSteps(store, steps, { root, call, verify = true, dryRun = false, force = false, maxUsd = 5, log = () => {} } = {}) {
  let cost = 0;
  const out = [];
  for (const st of steps) {
    // re-runs are cheap: a step whose facts were already learned is skipped (force to redo)
    if (!force && !dryRun && store.db.prepare("SELECT 1 FROM findings WHERE source LIKE ? AND status IN ('active','suspect') LIMIT 1").get(`learn:${st.id}%`)) {
      log(`  · ${st.id} already learned — skipped`); out.push({ step: st.id, skipped: 'already learned' }); continue;
    }
    if (cost > maxUsd) { log(`  ⛔ spend cap $${maxUsd} reached — step ${st.id} not learned`); out.push({ step: st.id, skipped: 'cap' }); continue; }
    const brief = store.stepBrief(st.id, { limit: 10 });
    const briefIds = new Set(brief.map((f) => f.id));
    const r = await call(learnPrompt(st, brief));
    cost += r.cost || 0;
    const pf = parseFindings(r.result);
    if (!pf.findings.length) { log(`  ✗ ${st.id}: no findings (${r.is_error ? r.subtype : pf.error || 'none reported'})`); out.push({ step: st.id, learned: 0 }); continue; }
    // stage in memory, verify there, then carry only verified claims over. The staging
    // store has none of the live facts, so depends_on is held aside and re-attached on
    // the way out — only ids the learner was actually shown (no invented #ids).
    const stage = new Store(':memory:');
    const sp = stage.createPlan({ title: 'stage' });
    const res = stage.absorbFindings(pf.findings.map(({ depends_on, ...f }) => f), { plan_id: sp.id, source: `learn:${st.id}`, root }).results;
    const dependsOf = new Map();
    res.forEach((x) => {
      if (!x.id) return;
      const d = pf.findings[x.index]?.depends_on;
      const ids = (Array.isArray(d) ? d : d == null ? [] : [d]).map((v) => Number(String(v).replace(/^#/, ''))).filter((v) => briefIds.has(v));
      if (ids.length) dependsOf.set(x.id, [...new Set([...(dependsOf.get(x.id) || []), ...ids])]);
    });
    const staged = res.filter((x) => x.id);
    let verdicts = {};
    if (verify) {
      stage.markForVerification(staged.map((x) => x.id));
      const v = await reevaluate(stage, { call, tools: true, all: true, root, useReach: false });
      cost += v.cost;
      verdicts = Object.fromEntries(v.results.map((x) => [x.id, x.verdict]));
    }
    const keep = [];
    for (const x of staged) {
      let f = stage.getFinding(x.id);
      while (f.status === 'superseded' && f.superseded_by) f = stage.getFinding(f.superseded_by);
      if (f.status !== 'active') continue; // retracted or still unsure → not absorbed
      keep.push({ kind: f.kind, subject: f.subject, slot: f.slot || undefined, claim: f.claim, evidence: f.evidence,
        ...(dependsOf.has(x.id) ? { depends_on: dependsOf.get(x.id) } : {}) });
    }
    stage.close();
    const linked = keep.filter((k) => k.depends_on).length;
    const vc = Object.values(verdicts).reduce((m, v) => ((m[v] = (m[v] || 0) + 1), m), {});
    let absorbed = null;
    // briefed: absorb also links a new fact to a briefed one on the same subject / wording
    if (!dryRun && keep.length) absorbed = store.absorbFindings(keep, { step_id: st.id, source: `learn:${st.id}${verify ? '+verified' : ''}`, root, briefed: [...briefIds] }).counts;
    log(`  ✓ ${st.id} ${st.title.slice(0, 60)} — briefed ${brief.length}, learned ${pf.findings.length}` +
      (verify ? `, verified: ${Object.entries(vc).map(([k, n]) => `${n} ${k}`).join(', ')}` : '') +
      `, ${dryRun ? 'would absorb' : 'absorbed'} ${keep.length} (${linked} built on known facts)${absorbed ? ` (${Object.entries(absorbed).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}`);
    out.push({ step: st.id, briefed: brief.length, learned: pf.findings.length, verdicts: vc, kept: keep.length, linked, absorbed, facts: dryRun ? keep : undefined });
  }
  return { cost, steps: out };
}

// ---- CLI -----------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const store = new Store(defaultDbPath());
  let ids = (val('--steps', '') || '').split(',').map(Number).filter(Boolean);
  if (!ids.length && val('--plan')) ids = store.db.prepare("SELECT id FROM steps WHERE plan_id = ? AND status IN ('pending','in_progress') ORDER BY idx").all(Number(val('--plan'))).map((r) => r.id);
  if (!ids.length) { console.error('usage: learn.mjs (--steps 1,2 | --plan N) [--root DIR] [--no-verify] [--dry-run] [--max-usd 5]'); process.exit(2); }
  const steps = ids.map((id) => store.getStep(id));
  const project = store.db.prepare('SELECT project_id FROM plans WHERE id = ?').get(steps[0].plan_id).project_id ?? 1;
  const root = val('--root', null) ?? store.getProjectRoot(project);
  if (!root) { console.error(`no --root and project ${project} has no root (set_project_root)`); process.exit(2); }
  console.log(`learning ${steps.length} step(s) in ${root}${flag('--dry-run') ? ' (dry run)' : ''}`);
  const call = makeAgent({ root, model: val('--model', 'deepseek-v4-pro'), maxTurns: 30, budget: 0.5 });
  const r = await learnSteps(store, steps, { root, call, verify: !flag('--no-verify'), dryRun: flag('--dry-run'), force: flag('--force'),
    maxUsd: Number(val('--max-usd', 5)), log: (s) => console.log(s) });
  console.log(`\n$${r.cost.toFixed(3)} total`);
  store.close();
}
