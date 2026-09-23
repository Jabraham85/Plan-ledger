// findings.mjs — the brain's write-back channel (plan #134): absorbFindings,
// retractFinding, queryFindings, getFinding, claim canonicalization, v4/v5 migrations.
// Run: node test/findings.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, claimTokens, normSubject } from '../src/db.mjs';

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log('  ok  ' + label); pass++; };
const one = (s, f, opts) => s.absorbFindings([f], opts).results[0];

// ---- canonicalization ------------------------------------------------------
{
  const a = claimTokens('compact_at defaults to 0.25');
  const b = claimTokens('compact_at defaults to 0.7');
  check('numbers survive canonicalization (0.25 vs 0.7 differ)', a.numbers.has('0.25') && b.numbers.has('0.7') && a.canon !== b.canon);
  check('numbers are excluded from the similarity set', !a.content.has('0.25') && a.content.has('compact_at'));
  check('"not" is kept as polarity (the ledger tokenize() drops it)', claimTokens('cache is not enabled').negative === true);
  check('"disabled" canonicalizes to "not enabled"', claimTokens('the cache is disabled').canon === claimTokens('The cache is NOT enabled.').canon);
  check("contractions: \"isn't\" is a negation", claimTokens("the cache isn't enabled").negative === true);
  check('double negation cancels', claimTokens('the cache is not disabled').negative === false);
  check('normSubject: slashes, ./ prefix, case', normSubject('.\\SRC\\db.mjs') === 'src/db.mjs');
}

// ---- absorb: outcomes ------------------------------------------------------
const s = new Store(':memory:');
const plan = s.createPlan({ title: 'brain host', keywords: ['brain'] });
const step = s.addStep(plan.id, { title: 'learn things' });
check('fresh DB stamped at the current USER_VERSION (>= 14 with the brain)', s.db.prepare('PRAGMA user_version').get().user_version === Store.USER_VERSION && Store.USER_VERSION >= 14);

{
  const r = one(s, { kind: 'fact', subject: 'src/db.mjs#recall', claim: 'recall merges plans, steps and attempts into one ranking',
    evidence: ['src/db.mjs:958'] }, { step_id: step.id, source: 'test' });
  check('new finding → created', r.outcome === 'created' && r.id > 0);
  const f = s.getFinding(r.id);
  check('provenance: plan/step/project/source recorded', f.plan_id === plan.id && f.step_id === step.id && f.project_id === 1 && f.source === 'test');

  const d = one(s, { kind: 'fact', subject: 'SRC\\db.mjs#recall', claim: 'Recall merges plans steps and attempts into one ranking.',
    evidence: ['src/db.mjs:960'] });
  check('case/punctuation/path variant → duplicate of the same row', d.outcome === 'duplicate' && d.id === r.id);
  const merged = s.getFinding(r.id);
  check('duplicate merges evidence + bumps seen_count', merged.seen_count === 2 && merged.evidence.length === 2);

  const p = one(s, { kind: 'fact', subject: 'src/db.mjs#recall', claim: 'recall merges plans, steps and attempts into one combined ranking' });
  check('additive paraphrase → near_duplicate (merged, no new row)', p.outcome === 'near_duplicate' && p.id === r.id && p.similarity >= 0.7);
  const syn = one(s, { kind: 'fact', subject: 'src/db.mjs#recall', claim: 'recall merges plans, steps and attempts into a single ranking' });
  check('synonym SWAP (one→single) is not merged under the default route — the known cost of the substitution guard',
    syn.outcome === 'created');
  s.retractFinding(syn.id, 'test cleanup: synonym paraphrase of an existing finding');

  const other = one(s, { kind: 'fact', subject: 'src/db.mjs#getlessons', claim: 'recall merges plans, steps and attempts into one ranking' });
  check('same sentence, different subject → separate finding (no wrong merge)', other.outcome === 'created' && other.id !== r.id);
}

// ---- guards: numbers + polarity become conflicts, never merges -------------
{
  const a = one(s, { subject: 'config.yaml#context', claim: 'context compaction starts at 0.25 of the budget' });
  const b = one(s, { subject: 'config.yaml#context', claim: 'context compaction starts at 0.7 of the budget' });
  check('different number, same wording → conflict (both kept)', a.outcome === 'created' && b.outcome === 'conflict' && b.conflicts_with[0] === a.id);
  check('conflict is cross-linked on both rows, both still active',
    s.getFinding(a.id).conflicts_with.includes(b.id) && s.getFinding(a.id).status === 'active' && s.getFinding(b.id).status === 'active');

  const c = one(s, { subject: 'harness/cache', claim: 'the KV cache reuse is enabled for sliding layers' });
  const e = one(s, { subject: 'harness/cache', claim: 'the KV cache reuse is not enabled for sliding layers' });
  check('opposite polarity → conflict', c.outcome === 'created' && e.outcome === 'conflict');
  const f = one(s, { subject: 'harness/cache', claim: 'The KV cache reuse is disabled for sliding layers.' });
  check('"disabled" == "not enabled" → exact duplicate of the negative claim', f.outcome === 'duplicate' && f.id === e.id);

  const u = new Store(':memory:');
  one(u, { subject: 'config.yaml#context', claim: 'context compaction starts at 0.25 of the budget' });
  const wrong = one(u, { subject: 'config.yaml#context', claim: 'context compaction starts at 0.7 of the budget' }, { route: 'near' });
  check('UNGUARDED route (near) wrongly merges 0.25 into 0.7 — why the guard exists', wrong.outcome === 'near_duplicate');
  const ex = one(u, { subject: 'config.yaml#context', claim: 'context compaction starts at 0.7 of the budget' }, { route: 'exact' });
  check('exact route never near-merges', ex.outcome === 'created');
  u.close();
}

// ---- substitution guard: distinct facts that swap one word never merge -----
{
  const u = new Store(':memory:');
  const a = one(u, { subject: 'runner#workplan', claim: 'the runner re-reads step status from the database after every agent exits' });
  const b = one(u, { subject: 'runner#workplan', claim: 'the runner re-reads plan status from the database after every agent exits' });
  check('one-word swap (step→plan, 0.82 similar) → separate facts under the default route', a.outcome === 'created' && b.outcome === 'created');
  const g = new Store(':memory:');
  one(g, { subject: 'runner#workplan', claim: 'the runner re-reads step status from the database after every agent exits' });
  check('…whereas the guarded route (no substitution guard) wrongly merges them',
    one(g, { subject: 'runner#workplan', claim: 'the runner re-reads plan status from the database after every agent exits' }, { route: 'guarded' }).outcome === 'near_duplicate');
  u.close(); g.close();
}

// ---- revert guard: a stale report cannot overwrite the current value --------
{
  const u = new Store(':memory:');
  const v1 = one(u, { subject: 'web/board.mjs', slot: 'port', claim: 'the board serves on port 4319' });
  const v2 = one(u, { subject: 'web/board.mjs', slot: 'port', claim: 'the board serves on port 4320' });
  const stale = one(u, { subject: 'web/board.mjs', slot: 'port', claim: 'The board serves on port 4319.' });
  check('slot update supersedes the old port', v2.outcome === 'superseded' && v2.superseded[0] === v1.id);
  check('a stale re-report of the old port → conflict, not a supersede', stale.outcome === 'conflict' && /stale/.test(stale.reason));
  check('the current value (4320) stays active, flagged for review',
    u.getFinding(v2.id).status === 'active' && u.getFinding(v2.id).conflicts_with.includes(stale.id));
  const f = new Store(':memory:');
  one(f, { subject: 'web/board.mjs', slot: 'port', claim: 'the board serves on port 4319' });
  const cur = one(f, { subject: 'web/board.mjs', slot: 'port', claim: 'the board serves on port 4320' });
  one(f, { subject: 'web/board.mjs', slot: 'port', claim: 'the board serves on port 4319' }, { route: 'full' });
  check('…whereas the full route (no revert guard) lets the stale value win', f.getFinding(cur.id).status === 'superseded');
  u.close(); f.close();
}

// ---- supersede: slot, explicit, invalid ------------------------------------
{
  const v1 = one(s, { kind: 'fact', subject: 'gemma/config.yaml', slot: 'compact_at', claim: 'compact_at is 0.7' });
  const v2 = one(s, { kind: 'fact', subject: 'gemma/config.yaml', slot: 'compact_at', claim: 'compact_at is 0.25' });
  check('same subject+slot, new value → superseded (newest wins)', v2.outcome === 'superseded' && v2.superseded[0] === v1.id);
  const old = s.getFinding(v1.id), cur = s.getFinding(v2.id);
  check('history kept: old row superseded, points at the new one', old.status === 'superseded' && old.superseded_by === v2.id && cur.supersedes.includes(v1.id));
  const noSlot = one(s, { subject: 'gemma/config.yaml', slot: 'compact_at', claim: 'compact_at is 0.25' });
  check('re-reporting the current slot value → duplicate, not a self-supersede', noSlot.outcome === 'duplicate' && noSlot.id === v2.id);
  const guardedOnly = new Store(':memory:');
  one(guardedOnly, { subject: 'x', slot: 'mode', claim: 'mode is fast' });
  check('slot supersede is off in the guarded route', one(guardedOnly, { subject: 'x', slot: 'mode', claim: 'mode is careful' }, { route: 'guarded' }).outcome === 'created');
  guardedOnly.close();

  const wrongFact = one(s, { subject: 'runner', claim: 'the runner spawns agents in parallel' });
  const fix = one(s, { subject: 'runner', claim: 'the runner spawns one agent at a time', supersedes: wrongFact.id });
  check('explicit supersedes id → superseded', fix.outcome === 'superseded' && s.getFinding(wrongFact.id).superseded_by === fix.id);
  const again = one(s, { subject: 'runner', claim: 'runner step order is lowest workable step first', supersedes: wrongFact.id });
  check('superseding an already-superseded finding → created + warning (fact not lost)', again.outcome === 'created' && /already superseded/.test(again.warnings?.[0] || ''));
  const bogus = one(s, { subject: 'runner', claim: 'runner records verdicts', supersedes: 999999 });
  check('superseding a missing id → created + warning', bogus.outcome === 'created' && /no such finding/.test(bogus.warnings?.[0] || ''));
}

// ---- validation, batch semantics, dry run -----------------------------------
{
  const bad = s.absorbFindings([null, { claim: '' }, { claim: 'x is y', kind: 'rumour' }, { claim: 'z'.repeat(2001) }, [1], { claim: '...' }]);
  check('rejects: non-object, empty, bad kind, too long, array, no content', bad.counts.rejected === 6);

  const batch = s.absorbFindings([
    { subject: 'board', claim: 'the board polls activity every 1.5 seconds' },
    { subject: 'board', claim: 'The board polls activity every 1.5 seconds.' },
  ]);
  check('in-batch duplicate is caught (sequential in one transaction)', batch.counts.created === 1 && batch.counts.duplicate === 1);

  const before = s.db.prepare('SELECT COUNT(*) n, SUM(seen_count) s FROM findings').get();
  const dry = s.absorbFindings([
    { subject: 'dry', claim: 'this should never be written' },
    { subject: 'board', claim: 'the board polls activity every 1.5 seconds' },
  ], { dry_run: true });
  const after = s.db.prepare('SELECT COUNT(*) n, SUM(seen_count) s FROM findings').get();
  check('dry_run reports outcomes…', dry.dry_run && dry.counts.created === 1 && dry.counts.duplicate === 1);
  check('…and writes nothing (rows and seen_counts unchanged)', before.n === after.n && before.s === after.s);
  check('unknown route rejected', (() => { try { s.absorbFindings([], { route: 'vibes' }); return false; } catch { return true; } })());
  check('bad threshold rejected', (() => { try { s.absorbFindings([], { threshold: 0 }); return false; } catch { return true; } })());
  check('>200 findings rejected', (() => { try { s.absorbFindings(new Array(201).fill({ claim: 'a b' })); return false; } catch { return true; } })());
}

// ---- retract + query --------------------------------------------------------
{
  const f = one(s, { subject: 'exe', claim: 'the exe signs itself during build' });
  check('retract requires a reason', (() => { try { s.retractFinding(f.id, ' '); return false; } catch { return true; } })());
  const r = s.retractFinding(f.id, 'wrong: the build STRIPS the signature');
  check('retract keeps the row with status + reason', r.status === 'retracted' && /STRIPS/.test(r.note));
  check('retracted findings are hidden from the active view', !s.queryFindings({ subject: 'exe' }).some((x) => x.id === f.id));
  check("…but visible with status 'any'", s.queryFindings({ subject: 'exe', status: 'any' }).some((x) => x.id === f.id));

  const byPrefix = s.queryFindings({ subject: 'src/db.mjs' });
  check('subject is a prefix match (src/db.mjs finds #recall and #getlessons)', byPrefix.length === 2 && byPrefix.every((x) => x.subject.startsWith('src/db.mjs')));
  const ranked = s.queryFindings({ query: 'compaction budget' });
  check('query ranks by relevance with a score', ranked.length > 0 && ranked[0].subject === 'config.yaml#context' && typeof ranked[0].score === 'number');
  check("shaped rows (no raw columns like claim_hash leak)", ranked.every((x) => !('claim_hash' in x) && Array.isArray(x.evidence)));
}

// ---- project isolation -------------------------------------------------------
{
  const proj = s.createProject({ name: 'Other' });
  const otherPlan = s.createPlan({ title: 'elsewhere', project_id: proj.id });
  const r = one(s, { subject: 'board', claim: 'the board polls activity every 1.5 seconds' }, { plan_id: otherPlan.id });
  check('same finding in another project → created there, not merged across projects', r.outcome === 'created' && s.getFinding(r.id).project_id === proj.id);
  check('queries default to the current project', !s.queryFindings({ subject: 'board' }).some((x) => x.project_id === proj.id));
  check('all:true spans projects', s.queryFindings({ subject: 'board', all: true }).some((x) => x.project_id === proj.id));
}
s.close();

// ---- migration: an existing v3 DB gains the table, keeps its rows ------------
{
  const path = join(tmpdir(), `pl-findings-mig-${process.pid}.db`);
  for (const ext of ['', '-wal', '-shm']) rmSync(path + ext, { force: true });
  const a = new Store(path);
  const pl = a.createPlan({ title: 'pre-existing' });
  a.addStep(pl.id, { title: 'kept' });
  a.close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE findings; PRAGMA user_version = 3;');
  raw.close();
  const b = new Store(path);
  check('v3 DB migrates to the current version', b.db.prepare('PRAGMA user_version').get().user_version === Store.USER_VERSION);
  check('findings table created on the old DB', b.db.prepare("SELECT name FROM sqlite_master WHERE name='findings'").get() != null);
  check('existing plans/steps untouched by the migration', b.listPlans({ all: true }).some((p) => p.title === 'pre-existing') &&
    b.db.prepare('SELECT COUNT(*) n FROM steps').get().n === 1);
  b.close();
  for (const ext of ['', '-wal', '-shm']) rmSync(path + ext, { force: true });
}

console.log(`\n${pass} findings checks passed.`);
