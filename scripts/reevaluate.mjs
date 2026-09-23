#!/usr/bin/env node
// reevaluate.mjs — the brain's re-evaluation worker (truth maintenance, schema v5).
//
// Takes the SUSPECT findings (something they were built on changed), asks a model
// to re-check each one — with read-only tools over the source when there is a
// root, or from the text alone (stories, notes) — and settles it through
// Store.resolveFinding: confirmed | revised | retracted | unsure. A revision or
// retraction re-opens ITS dependents, which are then re-evaluated in a later
// round, until nothing is left or --max-rounds is hit.
//
//   node scripts/reevaluate.mjs [--root DIR] [--no-tools] [--plan N] [--all]
//                               [--max-rounds 6] [--dry-run] [--model deepseek-v4-pro] [--audit]
//   --audit     first look for facts that contradict each other (then settle them)
//   --dry-run   print each prompt; call no model, change nothing
//
// Order matters: a finding whose cause is itself still suspect waits for a later
// round, so it is judged against the cause's FINAL value, not a stale one.
import { Store, defaultDbPath } from '../src/db.mjs';
import { buildReevalPrompt, parseResolve, buildReachPrompt, parseReach, evidenceSnippets, buildAuditPrompt, parseAudit } from './runner-lib.mjs';
import { makeAgent } from './brain-llm.mjs';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Reach: for each high-impact fact not yet checked, one model call picks the OTHER
// facts it affects indirectly ("she", "the town doctor"); those turn suspect and
// are then settled by the normal rounds. An unparseable answer re-opens nothing
// and leaves the fact unmarked, so it is asked again next run.
export async function reach(store, { call, plan_id = null, all = false, dryRun = false, log = () => {} } = {}) {
  const out = [];
  let cost = 0;
  for (const f of store.pendingReach({ plan_id, all })) {
    const cands = store.reachCandidates(f.id);
    if (!cands.length) { if (!dryRun) store.applyReach(f.id, [], 'no other facts to check'); continue; }
    const prompt = buildReachPrompt(f, cands, store.reachKnown(f.id));
    if (dryRun) { log(`\n--- reach #${f.id} ---\n${prompt}`); out.push({ id: f.id, dry_run: true }); continue; }
    const r = await call(prompt);
    cost += r.cost || 0;
    const p = r.is_error ? { error: `model call failed: ${r.subtype}` } : parseReach(r.result, cands.map((c) => c.id));
    if (p.error) { log(`  ? reach #${f.id}: ${p.error}`); out.push({ id: f.id, error: p.error, cost: r.cost || 0 }); continue; }
    const opened = store.applyReach(f.id, p.ids, '', p.why);
    log(`  ↯ reach #${f.id} "${f.claim}" → re-opened ${opened.length ? opened.map((i) => `#${i}`).join(', ') : 'nothing'}`);
    out.push({ id: f.id, picked: p.ids, opened, cost: r.cost || 0 });
  }
  return { results: out, cost };
}

// Consistency audit: one text-only call per group of live facts about the same file
// (or subject) names contradicting pairs; each pair is cross-linked as a conflict and
// both sides turn suspect with the other as cause. Settle them with reevaluate().
export async function audit(store, { call, plan_id = null, all = false, dryRun = false, log = () => {} } = {}) {
  const P = plan_id != null ? store.db.prepare('SELECT project_id FROM plans WHERE id = ?').get(plan_id)?.project_id : null;
  const groups = store.auditGroups({ project_id: P, all });
  const out = [];
  let cost = 0;
  for (const g of groups) {
    const prompt = buildAuditPrompt(g);
    if (dryRun) { log(`\n--- audit ${g.key} ---\n${prompt}`); out.push({ key: g.key, dry_run: true }); continue; }
    const r = await call(prompt);
    cost += r.cost || 0;
    const p = r.is_error ? { error: `model call failed: ${r.subtype}` } : parseAudit(r.result, g.findings.map((x) => x.id), Object.fromEntries(g.findings.map((x) => [x.id, x.claim])));
    if (p.error) { log(`  ? audit ${g.key}: ${p.error}`); out.push({ key: g.key, error: p.error }); continue; }
    for (const pr of p.pairs) {
      const m = store.markContradiction(pr.a, pr.b, pr.why);
      log(`  ⚔ #${pr.a} vs #${pr.b}: ${pr.why}`);
      out.push({ key: g.key, ...pr, suspected: m.suspected });
    }
  }
  return { groups: groups.length, pairs: out.filter((x) => x.a), results: out, cost };
}

export async function reevaluate(store, { call, tools = false, maxRounds = 6, limit = 200, plan_id = null, all = false,
  dryRun = false, useReach = true, root = null, log = () => {} } = {}) {
  // root: the source tree, so a code fact's cited lines can be shown as they read NOW (F3)
  const readAt = (p) => { const a = join(root, p); return existsSync(a) ? readFileSync(a, 'utf8') : null; };
  const tried = new Set(), results = [];
  let cost = 0, rounds = 0;
  const reached = useReach ? await reach(store, { call, plan_id, all, dryRun, log }) : { results: [], cost: 0 };
  cost += reached.cost;
  let stalled = false; // a round with no progress means a cycle: stop waiting next round
  for (; rounds < maxRounds; rounds++) {
    const queue = store.suspectQueue({ limit, plan_id, all }).filter((q) => !tried.has(q.id));
    if (!queue.length) break;
    const last = rounds === maxRounds - 1 || stalled;
    let progressed = false;
    for (const q of queue) {
      const item = store.suspectQueue({ id: q.id })[0];
      if (!item) continue; // settled meanwhile (e.g. confirmed by a re-report)
      // wait while anything it rests on (a cause, or a dependency) is itself still unsettled —
      // a contradiction partner is not something it rests on (two partners would wait forever)
      const rests = [...item.causes.filter((c) => !/^contradicts /.test(c.detail || '')).map((c) => c.finding?.id),
        ...store.getFinding(item.id).depends_on.filter((d) => d.type === 'finding').map((d) => d.ref)];
      const waits = rests.some((fid) => fid != null && !tried.has(fid) && store.getFinding(fid).status === 'suspect');
      if (waits && !last) continue;
      tried.add(item.id);
      progressed = true;
      const prompt = buildReevalPrompt(item, { tools, snippets: tools && root ? evidenceSnippets(item.evidence, readAt) : [] });
      if (dryRun) { log(`\n--- #${item.id} ---\n${prompt}`); results.push({ id: item.id, dry_run: true }); continue; }
      const r = await call(prompt);
      cost += r.cost || 0;
      const p = r.is_error ? { error: `model call failed: ${r.subtype}` } : parseResolve(r.result);
      const rec = { id: item.id, claim: item.claim, cost: r.cost || 0, turns: r.turns || 0 };
      if (p.error) {
        store.resolveFinding(item.id, { verdict: 'unsure', reason: `re-evaluation failed: ${p.error}`.slice(0, 500) });
        results.push({ ...rec, verdict: 'unsure', error: p.error });
        log(`  ? #${item.id} unsure (${p.error})`);
        continue;
      }
      const out = store.resolveFinding(item.id, { verdict: p.verdict, claim: p.claim, reason: p.reason, source: 'reevaluate' });
      results.push({ ...rec, verdict: p.verdict, new_claim: p.claim || undefined, new_id: out.replaced ? out.finding.id : undefined,
        reason: p.reason, reopened: out.suspected });
      log(`  ${{ confirmed: '✓', revised: '✎', retracted: '✗', unsure: '?' }[p.verdict]} #${item.id} ${p.verdict}` +
        `${p.claim ? ` → "${p.claim}"` : ''}${out.suspected.length ? `  (re-opened ${out.suspected.map((i) => `#${i}`).join(', ')})` : ''}`);
    }
    if (!progressed) { if (stalled) break; stalled = true; rounds--; continue; } // one forced pass, then give up
    stalled = false;
  }
  return { rounds, cost, results, reach: reached.results, left: store.suspectQueue({ limit, plan_id, all }).map((q) => q.id) };
}

// ---- CLI -----------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const store = new Store(defaultDbPath());
  const root = flag('--no-tools') ? null : val('--root', null);
  const st = store.checkStale({ all: flag('--all') });
  console.log(`checked ${st.files_checked} source file(s); ${st.suspected.length} finding(s) newly suspect`);
  const call = makeAgent({ root, model: val('--model', 'deepseek-v4-pro') });
  if (flag('--audit')) { // text-only contradiction search first; settling below reads the source
    const a = await audit(store, { call: makeAgent({ root: null, model: val('--model', 'deepseek-v4-pro') }), all: flag('--all'),
      plan_id: val('--plan', null) != null ? Number(val('--plan')) : null, dryRun: flag('--dry-run'), log: (m) => console.log(m) });
    console.log(`audit: ${a.groups} group(s), ${a.pairs.length} contradiction(s) found — ${a.cost.toFixed(4)}`);
  }
  const r = await reevaluate(store, { call, tools: !!root, root, maxRounds: Number(val('--max-rounds', 6)), dryRun: flag('--dry-run'),
    plan_id: val('--plan', null) != null ? Number(val('--plan')) : null, all: flag('--all'), log: (s) => console.log(s) });
  const n = (v) => r.results.filter((x) => x.verdict === v).length;
  console.log(`\n${r.results.length} re-evaluated in ${r.rounds} round(s): ${n('confirmed')} confirmed, ${n('revised')} revised, ` +
    `${n('retracted')} retracted, ${n('unsure')} unsure — $${r.cost.toFixed(4)}. Still suspect: ${r.left.length}.`);
  store.close();
}
