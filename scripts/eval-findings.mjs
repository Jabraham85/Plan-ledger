#!/usr/bin/env node
// eval-findings.mjs — route benchmark for Store.absorbFindings (plan #134 step 3).
//
// Deterministic, offline, zero model calls. Streams synthetic agent reports with
// KNOWN ground truth (which fact + which version each report expresses) through
// every dedup route and threshold, and scores the end state.
//
// Honesty caveat: the fixture and the dedup were written by the same agent, so
// the cases are deliberately adversarial rather than flattering: near-identical
// DISTINCT facts on one subject, value updates with and without slots, polarity
// flips, and STALE reporters that re-send an old value after it changed.
//
//   node scripts/eval-findings.mjs            # table over 5 seeds
//   node scripts/eval-findings.mjs --detail   # + per-fact failures for the pick
import { Store, FINDING_ROUTES } from '../src/db.mjs';

const SEEDS = [1, 2, 3, 4, 5];
const THRESHOLDS = (process.env.EVAL_THRESHOLDS || '0.6,0.7,0.8,0.9').split(',').map(Number);
const detail = process.argv.includes('--detail');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// {V} = the fact's value for the current version. `query` = words a later reader
// would search with (shared across versions).
const FACTS = [
  { fid: 'recall-scope', subject: 'src/db.mjs#recall', tmpl: 'recall searches only the current project unless all is true',
    light: ['recall only searches the current project unless all is true', 'recall searches just the current project unless all is set'],
    heavy: ['without the all flag recall never looks outside the active project'], query: 'recall current project all' },
  { fid: 'recall-active', subject: 'src/db.mjs#recall', tmpl: 'recall returns only active findings and never superseded ones',
    light: ['recall only returns active findings, never superseded ones'],
    heavy: ['superseded findings are filtered out before recall ranks anything'], query: 'recall active superseded findings' },
  { fid: 'runner-attempts', subject: 'scripts/runner.mjs', slot: 'max_attempts', values: ['2', '3'],
    tmpl: 'the runner retries a step {V} times before pausing',
    light: ['the runner retries each step {V} times before pausing for a human'],
    heavy: ['after {V} tries on one step the orchestrator stops and waits'], query: 'runner retries step pausing' },
  { fid: 'runner-retry-minutes', subject: 'scripts/runner.mjs', slot: 'retry_minutes', values: ['30'],
    tmpl: 'the runner waits {V} minutes before retrying after a usage limit',
    light: ['after a usage limit the runner waits {V} minutes before retrying'], heavy: [], query: 'usage limit retrying minutes' },
  { fid: 'board-port', subject: 'web/board.mjs', slot: 'port', values: ['4319', '4320'],
    tmpl: 'the board serves on port {V}', light: ['the board serves http on port {V}'],
    heavy: ['open localhost:{V} to reach the board'], query: 'board serves port' },
  { fid: 'exe-signature', subject: 'scripts/build-exe.mjs', tmpl: 'the build strips the node signature before injecting the blob',
    light: ['the build strips the node signature before it injects the blob'],
    heavy: ['postject only works after the authenticode certificate is removed'], query: 'build strips signature blob' },
  { fid: 'wal', subject: 'src/db.mjs#constructor', slot: 'journal_mode', values: ['enabled', 'disabled'],
    tmpl: 'write-ahead logging is {V} for the database', light: ['write-ahead logging is {V} on the database'],
    heavy: [], query: 'write-ahead logging database' },
  { fid: 'busy-timeout', subject: 'src/db.mjs#constructor', slot: 'busy_timeout', values: ['3000', '5000'],
    tmpl: 'the database busy timeout is {V} milliseconds', light: ['the busy timeout of the database is {V} milliseconds'],
    heavy: ['concurrent writers wait {V} ms for the lock'], query: 'database busy timeout' },
  { fid: 'journal-limit', subject: 'src/db.mjs#constructor', slot: 'journal_size_limit', values: ['4194304', '8388608'],
    tmpl: 'the wal journal size limit is {V} bytes', light: ['the journal size limit for the wal is {V} bytes'],
    heavy: [], query: 'journal size limit bytes' },
  // ADVERSARIAL: genuinely DISTINCT facts on one subject that differ by one word.
  { fid: 'getstep-attempts', subject: 'src/db.mjs#getstep', tmpl: 'getstep returns the attempts for the step newest first',
    light: ['getstep returns the step attempts newest first'], heavy: [], query: 'getstep attempts newest' },
  { fid: 'getstep-links', subject: 'src/db.mjs#getstep', tmpl: 'getstep returns the links for the step newest first',
    light: ['getstep returns the step links newest first'], heavy: [], query: 'getstep links newest' },
  { fid: 'workplan-step', subject: 'scripts/runner.mjs#workplan', tmpl: 'the runner re-reads step status from the database after every agent exits',
    light: ['after every agent exits the runner re-reads step status from the database'], heavy: [], query: 're-reads step status' },
  { fid: 'workplan-plan', subject: 'scripts/runner.mjs#workplan', tmpl: 'the runner re-reads plan status from the database after every agent exits',
    light: ['after every agent exits the runner re-reads plan status from the database'], heavy: [], query: 're-reads plan status' },
  { fid: 'lessons-scope', subject: 'src/db.mjs#getlessons', tmpl: "getlessons excludes the querying step's own attempts",
    light: ["getlessons leaves out the querying step's own attempts"],
    heavy: ['a step never sees its own failures in its lessons'], query: 'getlessons querying own attempts' },
  { fid: 'tokenize-short', subject: 'src/db.mjs#tokenize', tmpl: 'tokenize drops words of two characters or fewer',
    light: ['tokenize discards words of two characters or fewer'], heavy: ['short tokens never reach the ranker'],
    query: 'tokenize words characters' },
  { fid: 'verdict-default', subject: 'scripts/runner-lib.mjs#parseverdict', tmpl: 'parseverdict returns fail when no verdict marker is found',
    light: ['parseverdict falls back to fail when no verdict marker is found'],
    heavy: ['a missing marker counts as a failed step'], query: 'parseverdict verdict marker' },
  { fid: 'verify-gate', subject: 'scripts/runner-lib.mjs#applyverifygate', tmpl: 'a claimed pass becomes fail when the verify command exits non-zero',
    light: ['a claimed pass is downgraded to fail when the verify command exits non-zero'],
    heavy: ['failing verification overrides the agent verdict'], query: 'claimed pass verify command' },
  { fid: 'inject-mcp', subject: 'scripts/runner.mjs#runinjected', slot: 'mcp', values: ['do not load', 'load'],
    tmpl: 'inject mode agents {V} mcp servers', light: ['agents in inject mode {V} any mcp servers'], heavy: [],
    query: 'inject mode agents mcp servers' },
  { fid: 'rag-lexical', subject: 'docs/rag.md', tmpl: 'rag retrieval is lexical with no embeddings at query time',
    light: ['rag retrieval is purely lexical with no embeddings at query time'],
    heavy: ['search never calls a model, it only scores words'], query: 'rag lexical embeddings' },
  { fid: 'extractor', subject: 'src/extract.mjs', tmpl: 'the native extractor uses regex instead of tree-sitter',
    light: ['the native extractor relies on regex instead of tree-sitter'],
    heavy: ['code graphs are built without any parser dependency'], query: 'native extractor regex tree-sitter' },
  { fid: 'live-poll', subject: 'web/board.mjs#live', slot: 'poll_interval', values: ['1.5', '2'],
    tmpl: 'live mode polls activity every {V} seconds', light: ['in live mode the board polls activity every {V} seconds'],
    heavy: [], query: 'live mode polls activity' },
];
const fill = (t, v) => (v == null ? t : t.replaceAll('{V}', v));

// One fact's report sequence, in arrival order: each version's base, repeats
// (with path/case variants), light + heavy paraphrases; for changed values,
// sometimes a STALE re-report of the old value after the change.
function schedule(f, r) {
  const out = [];
  const values = f.values ?? [null];
  const slotMode = !f.slot ? 'none' : (() => { const x = r(); return x < 0.5 ? 'always' : x < 0.75 ? 'never' : 'mixed'; })();
  const useSlot = () => slotMode === 'always' || (slotMode === 'mixed' && r() < 0.5);
  const subj = () => { const x = r(); return x < 0.6 ? f.subject : x < 0.8 ? f.subject.replace(/\//g, '\\') : './' + f.subject.toUpperCase(); };
  const emit = (tmpl, ver, variant) => {
    let claim = fill(tmpl, values[ver]);
    if (variant === 'repeat' && r() < 0.5) claim = claim[0].toUpperCase() + claim.slice(1) + '.';
    out.push({ fid: f.fid, ver, variant, finding: { kind: 'fact', subject: subj(), claim, ...(useSlot() ? { slot: f.slot } : {}) } });
  };
  values.forEach((_, ver) => {
    emit(f.tmpl, ver, 'base');
    const reps = 1 + Math.floor(r() * 2);
    for (let i = 0; i < reps; i++) emit(f.tmpl, ver, 'repeat');
    for (const l of f.light) if (r() < 0.8) emit(l, ver, 'light');
    for (const h of f.heavy) if (r() < 0.5) emit(h, ver, 'heavy');
  });
  if (values.length > 1 && r() < 0.35) emit(f.tmpl, 0, 'stale');
  return { slotMode, reports: out };
}

// Interleave facts randomly while preserving each fact's own order.
function stream(seed) {
  const r = mulberry32(seed);
  const queues = FACTS.map((f) => schedule(f, r).reports);
  const out = [];
  while (queues.some((q) => q.length)) {
    const live = queues.filter((q) => q.length);
    out.push(live[Math.floor(r() * live.length)].shift());
  }
  return out;
}

function run(route, threshold, seed) {
  const s = new Store(':memory:');
  const plan = s.createPlan({ title: 'bench' });
  const reports = stream(seed);
  const truthOf = new Map(); // finding id -> { fid, ver } of the report that CREATED it
  const m = { reports: reports.length, wrongCross: 0, wrongValue: 0, missedDup: 0, byOutcome: {}, failures: [] };
  const key = (t) => `${t.fid}@${t.ver}`;
  for (const rep of reports) {
    const activeSame = [...truthOf.entries()].some(([id, t]) => key(t) === key(rep) && s.getFinding(id).status === 'active');
    const res = s.absorbFindings([rep.finding], { plan_id: plan.id, route, threshold }).results[0];
    m.byOutcome[res.outcome] = (m.byOutcome[res.outcome] || 0) + 1;
    if (res.outcome === 'duplicate' || res.outcome === 'near_duplicate') {
      const t = truthOf.get(res.id);
      if (t.fid !== rep.fid) { m.wrongCross++; m.failures.push(`MERGED ${rep.fid}@${rep.ver} [${rep.variant}] INTO ${t.fid}@${t.ver}`); }
      else if (t.ver !== rep.ver) { m.wrongValue++; m.failures.push(`VALUE LOST ${rep.fid}: v${rep.ver} [${rep.variant}] merged into v${t.ver}`); }
    } else if (res.outcome !== 'rejected') {
      truthOf.set(res.id, { fid: rep.fid, ver: rep.ver });
      if (activeSame) m.missedDup++;
    }
  }
  // End state, judged against the TRUE latest version (a stale reporter is wrong).
  const latest = new Map(FACTS.map((f) => [f.fid, (f.values?.length ?? 1) - 1]));
  const active = s.queryFindings({ plan_id: plan.id, limit: 200 });
  m.activeRows = active.length;
  m.correctCurrent = 0; m.staleSilent = 0; m.flagged = active.filter((f) => f.conflicts_with.length).length;
  for (const f of FACTS) {
    const rows = active.filter((a) => truthOf.get(a.id)?.fid === f.fid);
    if (rows.some((a) => truthOf.get(a.id).ver === latest.get(f.fid))) m.correctCurrent++;
    else m.failures.push(`NO CURRENT VALUE for ${f.fid} (latest v${latest.get(f.fid)} not active)`);
    for (const a of rows) if (truthOf.get(a.id).ver < latest.get(f.fid) && !a.conflicts_with.length) {
      m.staleSilent++; m.failures.push(`STALE ${f.fid}: v${truthOf.get(a.id).ver} active and unflagged`);
    }
  }
  m.recall3 = 0;
  for (const f of FACTS) {
    const hits = s.queryFindings({ plan_id: plan.id, query: f.query, limit: 3 });
    if (hits.some((h) => truthOf.get(h.id)?.fid === f.fid && truthOf.get(h.id).ver === latest.get(f.fid))) m.recall3++;
  }
  s.close();
  return m;
}

const configs = [{ route: 'exact', threshold: 0.7 }];
for (const route of ['near', 'guarded', 'full', 'strict', 'strict_full']) for (const t of THRESHOLDS) configs.push({ route, threshold: t });

const N = FACTS.length * SEEDS.length;
const rows = configs.map((c) => {
  const agg = { ...c, reports: 0, wrongCross: 0, wrongValue: 0, missedDup: 0, activeRows: 0, correctCurrent: 0, staleSilent: 0, flagged: 0, recall3: 0, failures: [] };
  for (const seed of SEEDS) {
    const m = run(c.route, c.threshold, seed);
    for (const k of ['reports', 'wrongCross', 'wrongValue', 'missedDup', 'activeRows', 'correctCurrent', 'staleSilent', 'flagged', 'recall3']) agg[k] += m[k];
    agg.failures.push(...m.failures.map((x) => `seed ${seed}: ${x}`));
  }
  agg.wrong = agg.wrongCross + agg.wrongValue;
  agg.excess = agg.activeRows - N;
  return agg;
});

const pct = (a, b) => `${Math.round((100 * a) / b)}%`;
console.log(`findings route benchmark — ${FACTS.length} facts x ${SEEDS.length} seeds = ${N} fact-runs, ${rows[0].reports} reports, zero model calls\n`);
console.log('route    thr  | WRONG merges (cross/value) | stale silent | current value | excess rows | flagged | recall@3');
console.log('-------------+----------------------------+--------------+---------------+-------------+---------+---------');
for (const r of rows) {
  console.log(`${r.route.padEnd(8)} ${r.route === 'exact' ? ' -  ' : r.threshold.toFixed(1) + ' '} | ` +
    `${String(r.wrong).padStart(4)} (${String(r.wrongCross).padStart(3)} / ${String(r.wrongValue).padStart(3)})         | ` +
    `${String(r.staleSilent).padStart(12)} | ${pct(r.correctCurrent, N).padStart(13)} | ${String(r.excess).padStart(11)} | ` +
    `${String(r.flagged).padStart(7)} | ${pct(r.recall3, N).padStart(8)}`);
}

// Pick: fewest wrong merges (information destroyed), then most facts whose
// CURRENT value is still active (a stale report overwriting the truth hides it
// from recall entirely — found in the first run), then fewest silent stale
// values (outdated truth shown unflagged), then least bloat, then best recall.
// Correctness strictly before tidiness.
const ranked = [...rows].sort((a, b) => a.wrong - b.wrong || b.correctCurrent - a.correctCurrent ||
  a.staleSilent - b.staleSilent || a.excess - b.excess || b.recall3 - a.recall3);
const pick = ranked[0];
console.log(`\nPICK: ${pick.route}${pick.route === 'exact' ? '' : ' @ ' + pick.threshold} — ` +
  `${pick.wrong} wrong merges, ${pick.staleSilent} stale-silent, ${pct(pick.correctCurrent, N)} current, ${pick.excess} excess rows, recall@3 ${pct(pick.recall3, N)}`);
if (detail) {
  console.log('\nfailures for the pick:');
  const counts = new Map();
  for (const f of pick.failures) { const k = f.replace(/^seed \d+: /, ''); counts.set(k, (counts.get(k) || 0) + 1); }
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(2)}x  ${k}`);
}
export { FINDING_ROUTES };
