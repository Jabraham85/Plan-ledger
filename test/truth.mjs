// truth.mjs — truth maintenance (schema v5): dependencies, staleness, the suspect
// cascade and its brake, the high-impact ("she's a frog") sweep, resolution.
// Run: node test/truth.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCOPE_CLAIM } from '../src/db.mjs';
import { parseResolve, buildReachPrompt, parseReach, buildReevalPrompt, evidenceSnippets, buildAuditPrompt, parseAudit } from '../scripts/runner-lib.mjs';
import { reevaluate, reach, audit } from '../scripts/reevaluate.mjs';
import { learnSteps } from '../scripts/learn.mjs';

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log('  ok  ' + label); pass++; };
const one = (s, f, opts) => s.absorbFindings([f], opts).results[0];
const status = (s, id) => s.getFinding(id).status;

// ---- files: inferred links, staleness, confirmation ---------------------------
{
  const root = join(tmpdir(), `pl-truth-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'runner.mjs'), 'const maxRetries = 48;\n');
  writeFileSync(join(root, 'notes.md'), 'unrelated\n');
  const s = new Store(':memory:');

  const a = one(s, { subject: 'scripts/runner.mjs#maxRetries', claim: 'maxRetries defaults to 48' }, { root });
  const b = one(s, { subject: 'retry policy', claim: 'the retry cap is set in the runner', evidence: ['scripts/runner.mjs:1'] }, { root });
  const c = one(s, { subject: 'docs', claim: 'notes exist', files: ['notes.md'] }, { root });
  const n = one(s, { subject: 'scripts/runner.mjs#x', claim: 'no root given, so no file link' });
  const fdeps = (id) => s.getFinding(id).depends_on.filter((d) => d.type === 'file');
  check('subject path → inferred file link', fdeps(a.id).length === 1 && fdeps(a.id)[0].inferred && fdeps(a.id)[0].ref.endsWith('scripts/runner.mjs'));
  check('evidence "path:line" → inferred file link', fdeps(b.id).length === 1);
  check('explicit files[] → explicit file link', fdeps(c.id).length === 1 && !fdeps(c.id)[0].inferred);
  check('no root → relative paths are not linked', fdeps(n.id).length === 0);

  let r = s.checkStale();
  check('unchanged files → nothing suspect', r.suspected.length === 0 && r.files_checked === 2);
  writeFileSync(join(root, 'scripts', 'runner.mjs'), 'const maxRetries = 24;\n');
  r = s.checkStale();
  check('changed file → every finding built on it turns suspect', r.suspected.sort().join() === [a.id, b.id].sort().join() && r.changed_files.length === 1);
  check('unrelated file → still active', status(s, c.id) === 'active');
  check('checkStale is idempotent (already suspect → not re-flagged)', s.checkStale().suspected.length === 0);

  const live = s.queryFindings({ status: 'live', query: 'maxRetries' });
  check("status 'live' returns suspect findings, marked", live.some((f) => f.id === a.id && f.status === 'suspect'));
  check("default status 'active' hides suspect findings", !s.queryFindings({ query: 'maxRetries' }).some((f) => f.id === a.id));
  check("recall surfaces a suspect finding with status 'suspect'", s.recall('maxRetries defaults').hits.some((h) => h.type === 'finding' && h.id === a.id && h.status === 'suspect'));

  const q = s.suspectQueue();
  const qa = q.find((x) => x.id === a.id);
  check('suspectQueue says WHY: the changed file', qa && qa.causes.some((c2) => c2.file?.endsWith('scripts/runner.mjs') && /changed/.test(c2.detail)));

  const rev = s.resolveFinding(a.id, { verdict: 'revised', claim: 'maxRetries defaults to 24', reason: 'file now says 24' });
  check('revised → new active finding replaces the suspect one', rev.replaced === a.id && rev.finding.status === 'active' &&
    status(s, a.id) === 'superseded' && s.getFinding(a.id).superseded_by === rev.finding.id);
  check('the revision inherits the file link, re-anchored (not stale)', fdeps(rev.finding.id).length === 1 && s.checkStale().suspected.length === 0);
  const conf = s.resolveFinding(b.id, { verdict: 'confirmed', reason: 'still set in the runner' });
  check('confirmed → back to active, re-anchored', conf.finding.status === 'active' && s.checkStale().suspected.length === 0);
  check('history records suspect → confirmed', s.getFinding(b.id).history.map((h) => h.event).join() === 'suspect,confirmed');

  rmSync(join(root, 'notes.md'));
  r = s.checkStale();
  check('a deleted source file → suspect ("missing")', r.suspected.includes(c.id) && s.suspectQueue().find((x) => x.id === c.id).causes[0].detail.includes('missing'));
  check('resolving a superseded finding is refused', (() => { try { s.resolveFinding(a.id, { verdict: 'confirmed' }); return false; } catch { return true; } })());
  s.close();
  rmSync(root, { recursive: true, force: true });
}

// ---- finding chains: the cascade and its brake --------------------------------
{
  const s = new Store(':memory:');
  const A = one(s, { subject: 'runner#retry', slot: 'max', claim: 'the runner retries 48 times' });
  const B = one(s, { subject: 'runner#retry-window', claim: 'retrying can take up to 24 hours', depends_on: [A.id] });
  const C = one(s, { subject: 'ops', claim: 'a stuck run needs checking once a day', depends_on: [B.id] });
  const D = one(s, { subject: 'ops', claim: 'the board runs on port 4319' });
  check('explicit depends_on recorded', s.getFinding(B.id).depends_on.some((d) => d.type === 'finding' && d.ref === A.id && !d.inferred));
  check('dependents listed on the parent', s.getFinding(A.id).dependents.includes(B.id));

  const A2 = one(s, { subject: 'runner#retry', slot: 'max', claim: 'the runner retries 12 times' });
  check('a slot correction supersedes and reports what turned suspect', A2.outcome === 'superseded' && A2.suspected?.includes(B.id));
  check('ONE hop: the direct dependent is suspect', status(s, B.id) === 'suspect');
  check('BRAKE: the grand-dependent is untouched until its parent changes', status(s, C.id) === 'active');
  check('unrelated finding untouched', status(s, D.id) === 'active');
  check('suspectQueue shows the old and the NEW value of the cause',
    s.suspectQueue().find((x) => x.id === B.id).causes.some((c) => c.finding?.id === A.id && c.finding.now?.id === A2.id));

  const r = s.resolveFinding(B.id, { verdict: 'revised', claim: 'retrying can take up to 6 hours' });
  check('revising B cascades one more hop, to C', r.suspected.includes(C.id) && status(s, C.id) === 'suspect');
  check('the revision depends on the CURRENT parent (re-pointed to A2)', s.getFinding(r.finding.id).depends_on.some((d) => d.ref === A2.id));
  const rc = s.resolveFinding(C.id, { verdict: 'confirmed', reason: 'still daily is fine' });
  check('confirming C stops the cascade (nothing further flagged)', rc.suspected.length === 0 && status(s, C.id) === 'active');
  check('confirmed C now depends on the revised B', s.getFinding(C.id).depends_on.some((d) => d.ref === r.finding.id));

  const u = s.resolveFinding(C.id, { verdict: 'unsure', reason: 'cannot tell' });
  check('unsure on an active finding logs, changes nothing', u.finding.status === 'active' && s.getFinding(C.id).history.at(-1).event === 'unsure');

  // a user EDIT of a live finding is a revision: its dependents are re-opened
  const E = one(s, { subject: 'ops', claim: 'alerts go to the ops channel', depends_on: [D.id] });
  const ed = s.resolveFinding(D.id, { verdict: 'revised', claim: 'the board runs on port 4320', reason: 'user edit' });
  check('editing a live finding re-opens what was built on it', ed.suspected.includes(E.id));

  // retraction cascades too
  const F = one(s, { subject: 'x', claim: 'feature flag alpha is on' });
  const G = one(s, { subject: 'y', claim: 'alpha users see the new menu', depends_on: [F.id] });
  const rt = s.retractFinding(F.id, 'the flag never existed');
  check('retract → dependents suspect', rt.suspected.includes(G.id) && status(s, G.id) === 'suspect');
  const rr = one(s, { subject: 'y', claim: 'Alpha users see the new menu.' });
  check('an exact re-report of a suspect finding confirms it', rr.outcome === 'confirmed' && rr.id === G.id && status(s, G.id) === 'active');
  check('confirming drops the link to a retracted parent', !s.getFinding(G.id).depends_on.some((d) => d.ref === F.id));
  check('depends_on ignores unknown ids and self', one(s, { subject: 'z', claim: 'orphan claim here', depends_on: [99999] }).outcome === 'created');
  s.close();
}

// ---- briefed → inferred links ----------------------------------------------------
{
  const s = new Store(':memory:');
  const k1 = one(s, { subject: 'src/db.mjs#recall', claim: 'recall ranks plans steps and attempts together' });
  const k2 = one(s, { subject: 'web/app.mjs', claim: 'the board listens on port 4319' });
  const n = one(s, { subject: 'src/db.mjs#recall', claim: 'recall caps results at eight by default' }, { briefed: [k1.id, k2.id] });
  const d = s.getFinding(n.id).depends_on.filter((x) => x.type === 'finding');
  check('briefed finding on the same subject → inferred link', d.some((x) => x.ref === k1.id && x.inferred));
  check('briefed finding with nothing in common → no link', !d.some((x) => x.ref === k2.id));
  s.close();
}

// ---- the frog rule --------------------------------------------------------------
{
  const s = new Store(':memory:');
  const f1 = one(s, { subject: 'princess', claim: 'she wore a blue silk dress to the ball' });
  const f2 = one(s, { subject: 'princess#family', claim: 'her father is the king of the river realm' });
  const f3 = one(s, { subject: 'ball', claim: 'the princess danced with the prince until midnight' });
  const f4 = one(s, { subject: 'castle', claim: 'the castle has four towers' });
  const low = one(s, { subject: 'princess', claim: 'she likes lilies' });
  check('a NORMAL new fact about her re-opens nothing', !low.suspected && status(s, f1.id) === 'active');
  const frog = one(s, { subject: 'princess', claim: 'she is actually a frog', impact: 'high' });
  check('high impact: same subject → suspect', status(s, f1.id) === 'suspect' && status(s, low.id) === 'suspect');
  check('high impact: sub-aspect (princess#family) → suspect', status(s, f2.id) === 'suspect');
  check('high impact: another subject whose claim names her → suspect', status(s, f3.id) === 'suspect');
  check('high impact: unrelated fact stays active', status(s, f4.id) === 'active');
  check('the frog fact itself stays active and lists what it re-opened', status(s, frog.id) === 'active' && frog.suspected.length === 4);
  check('the cause is the frog fact', s.suspectQueue().every((x) => x.causes.some((c) => c.finding?.id === frog.id)));
  check('bad impact value is rejected', one(s, { subject: 'x', claim: 'y is z', impact: 'huge' }).outcome === 'rejected');
  s.close();
}

// ---- RESOLVE contract parsing --------------------------------------------------------
{
  const ok = parseResolve('I checked the file.\nRESOLVE: {"verdict":"revised","claim":"maxRetries defaults to 24","reason":"line 96"}');
  check('parseResolve: a revised verdict with its claim', ok.verdict === 'revised' && ok.claim === 'maxRetries defaults to 24' && ok.reason === 'line 96');
  check('parseResolve: glued mid-line + braces inside strings', parseResolve('done.RESOLVE: {"verdict":"confirmed","reason":"see {x}"} trailing').verdict === 'confirmed');
  check('parseResolve: the LAST marker wins', parseResolve('RESOLVE: {"verdict":"unsure"}\nRESOLVE: {"verdict":"retracted","reason":"r"}').verdict === 'retracted');
  check('parseResolve: revised without a claim is an error', !!parseResolve('RESOLVE: {"verdict":"revised"}').error);
  check('parseResolve: unknown verdict / no marker / bad JSON are errors', ['RESOLVE: {"verdict":"maybe"}', 'no marker', 'RESOLVE: {"verdict":'].every((t) => parseResolve(t).error));
  check('parseResolve: a claim on a non-revised verdict is dropped', parseResolve('RESOLVE: {"verdict":"confirmed","claim":"x"}').claim === '');
}

// ---- reevaluate(): the loop, with a scripted model -------------------------------------
{
  const root = join(tmpdir(), `pl-truth-re-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'cfg.js'), 'retries = 48\n');
  const s = new Store(':memory:');
  const A = one(s, { subject: 'cfg.js#retries', claim: 'retries is 48' }, { root });
  const B = one(s, { subject: 'cfg.js#window', claim: 'the retry window is 24 hours', depends_on: [A.id] }, { root });
  const C = one(s, { subject: 'ops', claim: 'on-call checks the queue daily', depends_on: [B.id] });
  writeFileSync(join(root, 'cfg.js'), 'retries = 24\n');
  check('setup: both file-linked findings suspect, C not', s.checkStale().suspected.length === 2 && status(s, C.id) === 'active');

  const prompts = [];
  const script = { [A.id]: '{"verdict":"revised","claim":"retries is 24","reason":"cfg.js:1"}',
    [B.id]: '{"verdict":"revised","claim":"the retry window is 12 hours","reason":"24 x 30min"}',
    [C.id]: '{"verdict":"confirmed","reason":"still daily"}' };
  const call = async (prompt) => {
    prompts.push(prompt);
    const id = Number(/FACT #(\d+)/.exec(prompt)[1]);
    return { is_error: false, result: `checked.\nRESOLVE: ${script[id]}`, cost: 0.001, turns: 2 };
  };
  const r = await reevaluate(s, { call, tools: true });
  check('the loop settles the whole chain: A revised, B revised, C confirmed', r.results.map((x) => `${x.id}:${x.verdict}`).join() ===
    `${A.id}:revised,${B.id}:revised,${C.id}:confirmed`);
  check('B WAITED for A: its prompt shows the NEW value "retries is 24"', prompts[1].includes(`FACT #${B.id}`) && prompts[1].includes('NOW says: "retries is 24"'));
  check('C was re-opened by B\'s revision and judged with B\'s new value', prompts[2].includes('the retry window is 12 hours'));
  check('nothing left suspect; brain holds the revised values',
    r.left.length === 0 && s.queryFindings({ status: 'live', query: 'retry window' }).some((f) => f.claim === 'the retry window is 12 hours'));
  check('cost is summed', Math.abs(r.cost - 0.003) < 1e-9);

  // an unparseable answer leaves the finding suspect, logged, and is not retried forever
  const D = one(s, { subject: 'cfg.js#mode', claim: 'mode is fast' }, { root });
  writeFileSync(join(root, 'cfg.js'), 'retries = 24\nmode = slow\n');
  s.checkStale();
  const bad = await reevaluate(s, { call: async () => ({ is_error: false, result: 'no idea', cost: 0 }) });
  check('unparseable answer → unsure, stays suspect, one attempt only', bad.results.length >= 1 && bad.results.every((x) => x.verdict === 'unsure') &&
    status(s, D.id) === 'suspect' && s.getFinding(D.id).history.at(-1).detail.includes('no RESOLVE marker'));
  const dry = await reevaluate(s, { dryRun: true, call: async () => { throw new Error('must not be called'); } });
  check('dry run builds prompts, calls nothing, changes nothing', dry.results.every((x) => x.dry_run) && status(s, D.id) === 'suspect');
  s.close();
  rmSync(root, { recursive: true, force: true });
}

// ---- reach: the frog rule's second half (indirect references) --------------------------
{
  const s = new Store(':memory:');
  const hair = one(s, { subject: 'princess', claim: 'the princess has long golden hair' });
  const kiss = one(s, { subject: 'ball', claim: 'the prince kissed her hand when they first met' });
  const dance = one(s, { subject: 'ball', claim: 'the princess danced until midnight' });
  const towers = one(s, { subject: 'castle', claim: 'the castle has four towers' });
  const frog = one(s, { subject: 'princess', claim: 'the princess is actually a frog', impact: 'high' });
  check('sweep flagged only the facts that NAME her', frog.suspected.sort().join() === [hair.id, dance.id].sort().join());
  check('pendingReach lists the high-impact fact', s.pendingReach().map((f) => f.id).join() === String(frog.id));
  const cands = s.reachCandidates(frog.id);
  check('reach candidates exclude already-flagged facts and the fact itself',
    cands.every((c) => ![hair.id, dance.id, frog.id].includes(c.id)) && cands.some((c) => c.id === kiss.id));
  check('neighbours first: the ball fact (same subject as a flagged fact) outranks the castle', cands[0].id === kiss.id);
  const known = s.reachKnown(frog.id);
  check('reachKnown = the facts the sweep flagged by name', known.map((k) => k.id).sort().join() === [hair.id, dance.id].sort().join());
  const p = buildReachPrompt(s.getFinding(frog.id), cands, known);
  check('reach prompt shows the new fact, what was known, and every candidate with its #id', p.includes('actually a frog') &&
    p.includes('long golden hair') && p.includes(`#${kiss.id} [ball]`) && p.includes(`#${towers.id}`));
  check('parseReach: ids outside the candidates are ignored', JSON.stringify(parseReach(`x\nREACH: [${kiss.id}, 999]`, cands.map((c) => c.id))) ===
    JSON.stringify({ ids: [kiss.id], why: {}, ignored: [999] }));
  const pw = parseReach(`REACH: [{"id": ${kiss.id}, "why": "'her' is the princess"}, {"id": 998, "why": "x"}]`, cands.map((c) => c.id));
  const hashIds = parseReach(`REACH: [{"id": "#${kiss.id}", "why": "her"}, "#${towers.id}"]`, cands.map((c) => c.id));
  check('parseReach: ids written as "#12" (echoing the prompt) are accepted — the bench/reach v3 run-1 bug',
    hashIds.ids.sort().join() === [kiss.id, towers.id].sort().join() && hashIds.why[kiss.id] === 'her');
  check('parseReach: object form keeps the link per id', pw.ids.join() === String(kiss.id) && pw.why[kiss.id] === "'her' is the princess" && pw.ignored.join() === '998');
  check('parseReach: no marker is an error; empty list is fine', !!parseReach('nothing').error && parseReach('REACH: []').ids.length === 0);

  // a failed reach call re-opens nothing and stays pending
  const failed = await reach(s, { call: async () => ({ is_error: false, result: 'hmm', cost: 0.001 }) });
  check('unparseable reach → nothing re-opened, still pending', failed.results[0].error && status(s, kiss.id) === 'active' && s.pendingReach().length === 1);

  const prompts = [];
  const call = async (prompt) => {
    prompts.push(prompt);
    if (prompt.includes('REACH:')) return { is_error: false, result: `REACH: [{"id": ${kiss.id}, "why": "'her' is the princess"}]`, cost: 0.001 };
    const id = Number(/FACT #(\d+)/.exec(prompt)[1]);
    const v = id === kiss.id ? '{"verdict":"retracted","reason":"a frog has no hand to kiss"}' : '{"verdict":"confirmed"}';
    return { is_error: false, result: `RESOLVE: ${v}`, cost: 0.001 };
  };
  const r = await reevaluate(s, { call });
  check('reevaluate runs reach first: the pronoun fact is re-opened by the model', r.reach[0].opened.join() === String(kiss.id));
  check('…then settled in the normal rounds, told WHY (the high-impact fact)',
    status(s, kiss.id) === 'retracted' && prompts.some((q) => q.includes(`FACT #${kiss.id}`) && q.includes('actually a frog')));
  check('…and told the LINK reach found ("her" is the princess)', prompts.some((q) => q.includes(`FACT #${kiss.id}`) && q.includes("refers to \"princess\" indirectly: 'her' is the princess")));
  check('the castle was not touched; reach is not asked twice', status(s, towers.id) === 'active' && s.pendingReach().length === 0 &&
    s.getFinding(frog.id).history.some((h) => h.event === 'reached'));
  check('useReach:false skips it', (await reevaluate(s, { call, useReach: false })).reach.length === 0);
  s.close();
}

// ---- F2: absence / uniqueness / recency claims rest on their directory listing ----------
{
  check('SCOPE_CLAIM: universal / absence / recency wording is recognised',
    ['the only materials.json is the inventory catalog', 'the ADR directory ends at ADR008', 'the last perf capture was T030',
      'no visual material file exists', 'the fact is not emitted anywhere in the codebase', 'all validators emit a report'].every((c) => SCOPE_CLAIM.test(c)));
  check('SCOPE_CLAIM: ordinary claims are not', !['maxRetries defaults to 48', 'recall ranks plans and steps', 'the port is 4319'].some((c) => SCOPE_CLAIM.test(c)));
  const root = join(tmpdir(), `pl-truth-dir-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(root, 'docs', 'decisions', 'ADR008-saves.md'), '# ADR008\n');
  const s = new Store(':memory:');
  const scope = one(s, { subject: 'docs/decisions', claim: 'the ADR directory ends at ADR008', evidence: ['docs/decisions/ADR008-saves.md:1'] }, { root });
  const plain = one(s, { subject: 'docs/decisions/ADR008-saves.md', claim: 'ADR008 records save transactions' }, { root });
  const dirs = s.getFinding(scope.id).depends_on.filter((d) => d.type === 'dir').map((d) => d.ref);
  check('a scope claim depends on its folder and parent (not the root)', dirs.length === 2 && dirs.some((d) => d.endsWith('docs/decisions')) && dirs.some((d) => d.endsWith('/docs')));
  check('an ordinary claim gets no directory dependency', !s.getFinding(plain.id).depends_on.some((d) => d.type === 'dir'));
  check('nothing changed → nothing suspect', s.checkStale().suspected.length === 0);
  writeFileSync(join(root, 'docs', 'decisions', 'ADR009-lumen.md'), '# ADR009\n');
  const st = s.checkStale();
  check('a NEW file in the folder re-opens the scope claim only', st.suspected.join() === String(scope.id) && status(s, plain.id) === 'active');
  const item = s.suspectQueue({ id: scope.id })[0];
  check('re-evaluation is told a file was added in that directory', buildReevalPrompt(item, { tools: true }).includes('ADDED or REMOVED in a directory'));
  s.resolveFinding(scope.id, { verdict: 'revised', claim: 'the ADR directory ends at ADR009' });
  check('the revision re-anchors the listing (not stale again)', s.checkStale().suspected.length === 0);
  s.close();
  rmSync(root, { recursive: true, force: true });
}

// ---- F3: cited lines shown as they read NOW, clause-by-clause instruction -------------
{
  const files = { 'src/a.cpp': 'l1\nl2\nconst int MaxRetries = 24;\nl4\nl5\nl6\nl7\nl8' };
  const snip = evidenceSnippets(['src/a.cpp:3', 'gone.cpp:5', 'not a path', 'src/a.cpp:7-8'], (p) => files[p] ?? null, { around: 1 });
  check('evidenceSnippets: numbered lines around the cited line', snip[0].ref === 'src/a.cpp:3' && snip[0].text === '2\tl2\n3\tconst int MaxRetries = 24;\n4\tl4');
  check('evidenceSnippets: a vanished file says so; non-paths are skipped; ranges work',
    snip[1].text.includes('no longer exists') && snip.length === 3 && snip[2].text.startsWith('6\tl6') && snip[2].text.endsWith('8\tl8'));
  const p = buildReevalPrompt({ id: 1, subject: 's', claim: 'MaxRetries is 48', evidence: ['src/a.cpp:3'], causes: [{ file: 'src/a.cpp', detail: 'source file changed' }] },
    { tools: true, snippets: snip.slice(0, 1) });
  check('code prompt shows the lines NOW and demands a clause-by-clause check',
    p.includes('The cited lines as they are NOW') && p.includes('const int MaxRetries = 24') && p.includes('Check EACH part'));
  check('story prompt (no tools) is unchanged: no clause/search instruction', !buildReevalPrompt({ id: 1, claim: 'x', causes: [] }).includes('EACH part'));
}

// ---- the read side: next_step carries the brain's brief; project root links files --------
{
  const root = join(tmpdir(), `pl-truth-brief-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'Source'), { recursive: true });
  writeFileSync(join(root, 'Source', 'Save.cpp'), 'int SchemaVersion = 11;\n');
  const s = new Store(':memory:');
  const plan = s.createPlan({ title: 'M7' });
  const step = s.addStep(plan.id, { title: 'Bump the save schema for Z02', context: 'Add zone Z02 state to the save payload and migrate old saves.' });
  check('no findings → next_step brain is empty (and cheap)', s.nextStep(plan.id).brain.length === 0);
  check('setProjectRoot refuses a missing directory', (() => { try { s.setProjectRoot(1, join(root, 'nope')); return false; } catch { return true; } })());
  s.setProjectRoot(1, root);
  const f = one(s, { subject: 'Source/Save.cpp', claim: 'the save schema version is 11 and migrations run on load', evidence: ['Source/Save.cpp:1'] }, { plan_id: plan.id });
  one(s, { subject: 'web/theme', claim: 'the board uses a dark theme by default' }, { plan_id: plan.id });
  check('absorb without root links files via the project root', s.getFinding(f.id).depends_on.some((d) => d.type === 'file' && d.ref.endsWith('Source/Save.cpp')));
  let ns = s.nextStep(plan.id);
  check('next_step embeds the relevant finding as `brain` (not the unrelated one)', ns.brain.length >= 1 && ns.brain[0].id === f.id && !ns.brain.some((b) => /dark theme/.test(b.claim)));
  check('ready_steps embeds it too', s.readySteps(plan.id)[0].brain.some((b) => b.id === f.id));
  writeFileSync(join(root, 'Source', 'Save.cpp'), 'int SchemaVersion = 12;\n');
  ns = s.nextStep(plan.id);
  check('next_step re-checks sources first: the changed fact arrives SUSPECT', ns.brain.find((b) => b.id === f.id)?.status === 'suspect');
  check('stepBrief never throws (unknown step → [])', Array.isArray(s.stepBrief(99999)) && s.stepBrief(99999).length === 0);
  s.close();
  rmSync(root, { recursive: true, force: true });
}

// ---- learn.mjs: learn → verify on ingest → absorb only verified facts -----------------
{
  const root = join(tmpdir(), `pl-truth-learn-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'cfg.cpp'), 'int Port = 4319;\nint Retries = 48;\nint Mode = 1;\n');
  const s = new Store(':memory:');
  const plan = s.createPlan({ title: 'M7' });
  const st = s.addStep(plan.id, { title: 'Wire the retry policy', context: 'Uses the port and retry config.' });
  const call = async (prompt) => {
    if (prompt.includes('You are about to start this step')) return { is_error: false, cost: 0.01, result:
      'FINDINGS: [{"subject":"src/cfg.cpp#Port","claim":"the port is 4319","evidence":"src/cfg.cpp:1"},' +
      '{"subject":"src/cfg.cpp#Retries","claim":"retries default to 50","evidence":"src/cfg.cpp:2"},' +
      '{"subject":"src/cfg.cpp#Mode","claim":"mode is the only config value","evidence":"src/cfg.cpp:3"}]\nVERDICT: pass — looked' };
    const claim = /FACT #\d+ \(subject: [^)]*\): "([^"]*)"/.exec(prompt)[1];
    check(`verifier sees the cited line NOW for "${claim}"`, prompt.includes('The cited lines as they are NOW'));
    const v = claim.includes('4319') ? '{"verdict":"confirmed"}' : claim.includes('50') ? '{"verdict":"revised","claim":"retries default to 48"}' : '{"verdict":"retracted","reason":"three values"}';
    return { is_error: false, cost: 0.001, result: `RESOLVE: ${v}` };
  };
  const r = await learnSteps(s, [s.getStep(st.id)], { root, call });
  const live = s.queryFindings({ plan_id: plan.id, status: 'live', limit: 20 });
  check('only verified facts are absorbed: confirmed + revised kept, retracted dropped',
    live.length === 2 && live.some((f) => f.claim === 'the port is 4319') && live.some((f) => f.claim === 'retries default to 48') && !live.some((f) => /only config/.test(f.claim)));
  check('provenance = the step; source marks it verified; linked to its file',
    live.every((f) => f.step_id === st.id && f.source === `learn:${st.id}+verified` && s.getFinding(f.id).depends_on.some((d) => d.type === 'file')));
  check('the report counts verdicts and cost', r.steps[0].verdicts.confirmed === 1 && r.steps[0].verdicts.revised === 1 && r.steps[0].verdicts.retracted === 1 && r.cost > 0.01);
  const dry = await learnSteps(s, [s.getStep(st.id)], { root, call, dryRun: true });
  check('dry run absorbs nothing but reports what it would', dry.steps[0].kept === 2 && dry.steps[0].facts.length === 2 &&
    s.queryFindings({ plan_id: plan.id, status: 'live', limit: 20 }).length === 2);
  // a LATER step: its learner is briefed with what the brain knows (#ids) and can build on it
  const retries = live.find((f) => /48/.test(f.claim));
  const st2 = s.addStep(plan.id, { title: 'Retries backoff', context: 'Add backoff between the retries.' });
  let learnSeen = '';
  const call2 = async (prompt) => {
    if (prompt.includes('You are about to start this step')) {
      learnSeen = prompt;
      return { is_error: false, cost: 0.01, result:
        `FINDINGS: [{"subject":"src/cfg.cpp#Backoff","claim":"there is no backoff between the 48 retries","evidence":"src/cfg.cpp:2","depends_on":["#${retries.id}", 999]}]\nVERDICT: pass — looked` };
    }
    return { is_error: false, cost: 0.001, result: 'RESOLVE: {"verdict":"confirmed"}' };
  };
  const r2 = await learnSteps(s, [s.getStep(st2.id)], { root, call: call2 });
  const built = s.queryFindings({ plan_id: plan.id, status: 'live', limit: 20 }).find((f) => /backoff/.test(f.claim));
  check('learner is briefed with known facts by #id and asked for depends_on', learnSeen.includes(`#${retries.id} `) && learnSeen.includes('"depends_on"'));
  check('its depends_on survives verification: the new fact is BUILT ON the known one (an invented #999 is dropped)',
    !!built && s.getFinding(built.id).depends_on.some((d) => d.type === 'finding' && Number(d.ref) === retries.id) &&
    !s.getFinding(built.id).depends_on.some((d) => d.type === 'finding' && Number(d.ref) === 999) && r2.steps[0].linked === 1);
  s.resolveFinding(retries.id, { verdict: 'revised', claim: 'retries default to 5', reason: 'changed' });
  check('so revising the known fact re-opens the one built on it', s.getFinding(built.id).status === 'suspect');
  s.close();
  rmSync(root, { recursive: true, force: true });
}

// ---- consistency audit: facts that contradict each other ---------------------------------
{
  const root = join(tmpdir(), `pl-truth-audit-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'Tools'), { recursive: true });
  writeFileSync(join(root, 'Tools', 'runner.ps1'), 'param([string]$Map = "Z01")\n');
  const s = new Store(':memory:');
  const hard = one(s, { subject: 'Tools/runner.ps1', claim: 'the scenario runner is hard-wired to the Z01 map', evidence: ['Tools/runner.ps1:1'] }, { root });
  const param = one(s, { subject: 'Tools/runner.ps1#Map', claim: 'the scenario runner takes a -Map parameter defaulting to Z01', evidence: ['Tools/runner.ps1:1'] }, { root });
  const other = one(s, { subject: 'Tools/other.ps1', claim: 'the other tool prints a summary line' });
  check('dedup alone does NOT notice the contradiction (both active)', status(s, hard.id) === 'active' && status(s, param.id) === 'active');
  const groups = s.auditGroups();
  check('auditGroups: the two facts on the same file form one group; a lone fact forms none',
    groups.length === 1 && groups[0].findings.map((f) => f.id).sort().join() === [hard.id, param.id].sort().join());
  const p = buildAuditPrompt(groups[0]);
  check('audit prompt lists each fact with its #id and asks for CONTRADICTIONS', p.includes(`#${hard.id}`) && p.includes('CONTRADICTIONS:'));
  check('parseAudit: pairs with "#id" forms, dedups (a,b)=(b,a), drops unknown ids and self-pairs',
    JSON.stringify(parseAudit(`x\nCONTRADICTIONS: [{"a":"#${hard.id}","b":${param.id},"why":"fixed vs param"},{"a":${param.id},"b":${hard.id}},{"a":999,"b":${hard.id}},{"a":${hard.id},"b":${hard.id}}]`,
      [hard.id, param.id]).pairs) === JSON.stringify([{ a: hard.id, b: param.id, why: 'fixed vs param' }]));
  const cl = { [hard.id]: s.getFinding(hard.id).claim, [param.id]: s.getFinding(param.id).claim };
  const qa = parseAudit(`CONTRADICTIONS: [{"a":${hard.id},"b":${param.id},"a_says":"hard-wired to the Z01 map","b_says":"takes a -Map parameter"}]`, null, cl);
  const qb = parseAudit(`CONTRADICTIONS: [{"a":${hard.id},"b":${param.id},"a_says":"only supports Z01","b_says":"takes a -Map parameter"}]`, null, cl);
  check('parseAudit: a pair whose quote is really in each fact is kept; a misquoted pair is dropped',
    qa.pairs.length === 1 && qb.pairs.length === 0 && qb.dropped === 1);
  check('audit prompt asks for the "could both hold" test and exact quotes', p.includes('picture ONE codebase') && p.includes('a_says'));
  check('parseAudit: no marker is an error; empty list fine',!!parseAudit('none').error && parseAudit('CONTRADICTIONS: []').pairs.length === 0);

  const prompts = [];
  const call = async (prompt) => {
    prompts.push(prompt);
    if (prompt.includes('CONTRADICTIONS:')) return { is_error: false, cost: 0.001, result: `CONTRADICTIONS: [{"a": ${hard.id}, "b": ${param.id}, "why": "hard-wired vs a -Map parameter"}]` };
    const id = Number(/FACT #(\d+)/.exec(prompt)[1]);
    return { is_error: false, cost: 0.001, result: id === hard.id ? 'RESOLVE: {"verdict":"retracted","reason":"runner.ps1:1 declares -Map"}' : 'RESOLVE: {"verdict":"confirmed"}' };
  };
  const a = await audit(s, { call });
  check('audit marks the pair: both suspect, cross-linked conflicts, the unrelated fact untouched',
    a.pairs.length === 1 && status(s, hard.id) === 'suspect' && status(s, param.id) === 'suspect' &&
    s.getFinding(hard.id).conflicts_with.includes(param.id) && s.getFinding(param.id).conflicts_with.includes(hard.id) && status(s, other.id) === 'active');
  const r = await reevaluate(s, { call, tools: true, root });
  check('re-evaluation is told which fact contradicts it', prompts.some((q) => q.includes(`FACT #${hard.id}`) && q.includes('CONTRADICTS this one') && q.includes('hard-wired vs a -Map parameter')));
  check('settled: the wrong fact retracted, the right one confirmed', status(s, hard.id) === 'retracted' && status(s, param.id) === 'active' && r.left.length === 0);
  check('the settled conflict stops flagging the survivor (conflicts only count live facts)',
    s.getFinding(param.id).conflicts_with.length === 0 && s.queryFindings({ status: 'live', query: 'scenario runner' }).every((f) => f.conflicts_with.length === 0));
  // a FALSE alarm: the audit pairs two facts that agree; both come back confirmed → unlinked
  const fa = one(s, { subject: 'maps#only', claim: 'Z01 is the only zone recipe' });
  const fb = one(s, { subject: 'maps#z02', claim: 'Z02 has no recipe yet' });
  s.markContradiction(fa.id, fb.id, 'only Z01 vs Z02 none');
  s.resolveFinding(fa.id, { verdict: 'confirmed', reason: 'checked' });
  check('false alarm: while one side is still being checked, the link stays', s.getFinding(fa.id).conflicts_with.includes(fb.id));
  s.resolveFinding(fb.id, { verdict: 'confirmed', reason: 'checked' });
  check('false alarm: once BOTH sides are confirmed the pair is unlinked (no lasting CONFLICT), with a "consistent" event',
    s.getFinding(fa.id).conflicts_with.length === 0 && s.getFinding(fb.id).conflicts_with.length === 0 &&
    s.getFinding(fb.id).history.some((h) => h.event === 'consistent' && h.cause_finding_id === fa.id));
  check('markContradiction refuses a self-pair',(() => { try { s.markContradiction(param.id, param.id); return false; } catch { return true; } })());
  // a dependency CYCLE (each rests on the other) must still settle — no mutual waiting
  const x = one(s, { subject: 'cycle#x', claim: 'x mirrors y' });
  const y = one(s, { subject: 'cycle#y', claim: 'y mirrors x', depends_on: [x.id] });
  s.db.prepare("INSERT INTO finding_deps (finding_id, dep_type, dep_ref, dep_hash, inferred, created_at) VALUES (?, 'finding', ?, '', 0, 't')").run(x.id, String(y.id));
  s.markForVerification([x.id, y.id]);
  const cyc = await reevaluate(s, { call: async () => ({ is_error: false, cost: 0, result: 'RESOLVE: {"verdict":"confirmed"}' }) });
  check('a dependency cycle is settled (forced pass), nothing left suspect', cyc.left.length === 0 && status(s, x.id) === 'active' && status(s, y.id) === 'active');
  s.close();
  rmSync(root, { recursive: true, force: true });
}

// ---- file links use the path as the filesystem spells it (case-insensitive FS) ---------
if (process.platform === 'win32') {
  const root = join(tmpdir(), `pl-truth-case-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'DesignData'), { recursive: true });
  writeFileSync(join(root, 'DesignData', 'Dressing.json'), '{}\n');
  const s = new Store(':memory:');
  // subjects are lowercased for dedup; the evidence keeps the real case
  const f = one(s, { subject: 'DesignData/Dressing.json', claim: 'the dressing file lists ceilings', evidence: ['DesignData/Dressing.json:1'] }, { root });
  const links = s.getFinding(f.id).depends_on.filter((d) => d.type === 'file');
  check('a file named by a lowercased subject AND by evidence is linked ONCE, in its real case (was linked twice)',
    links.length === 1 && links[0].ref.endsWith('/DesignData/Dressing.json'));
  s.close();
  rmSync(root, { recursive: true, force: true });
}

// ---- v4 → v5 migration keeps findings ----------------------------------------------
{
  const path = join(tmpdir(), `pl-truth-mig-${process.pid}.db`);
  for (const ext of ['', '-wal', '-shm']) rmSync(path + ext, { force: true });
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE findings (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, plan_id INTEGER, step_id INTEGER,
    kind TEXT NOT NULL DEFAULT 'fact', subject TEXT NOT NULL DEFAULT '', slot TEXT NOT NULL DEFAULT '', claim TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT '', claim_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    superseded_by INTEGER, conflicts_with TEXT NOT NULL DEFAULT '[]', seen_count INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO findings (project_id, claim, claim_hash, created_at, updated_at) VALUES (1, 'old v4 fact', 'h', 't', 't');
    PRAGMA user_version = 4;`);
  raw.close();
  const s = new Store(path);
  check('a brain-branch v4 DB migrates to the current version', s.db.prepare('PRAGMA user_version').get().user_version === Store.USER_VERSION);
  const f = s.getFinding(1);
  check('v4 findings survive as active, impact normal, no deps', f.claim === 'old v4 fact' && f.status === 'active' && f.impact === 'normal' && f.depends_on.length === 0);
  check('deps + events tables exist', ['finding_deps', 'finding_events'].every((t) => s.db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(t)));
  s.close();
  for (const ext of ['', '-wal', '-shm']) rmSync(path + ext, { force: true });
}

console.log(`\n${pass} truth-maintenance checks passed.`);
