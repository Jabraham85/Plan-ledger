// smoke.mjs — exercises the Store loop end to end against an in-memory DB.
// Run: node test/smoke.mjs
import { Store, defaultDbPath } from '../src/db.mjs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const s = new Store(':memory:');
let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log('  ok  ' + label); pass++; };

// schema versioning: a fresh DB is stamped at the current user_version
check('fresh DB stamped at USER_VERSION', Store.USER_VERSION >= 1 && s.db.prepare('PRAGMA user_version').get().user_version === Store.USER_VERSION);

// create + surface index
const plan = s.createPlan({ title: 'Add dash dialogue to Unreal NPC', keywords: ['unreal', 'npc', 'dialogue'], summary: 'Wire a branching dialogue.' });
check('createPlan returns step index', Array.isArray(plan.steps) && plan.steps.length === 0);

const idx = s.listPlans();
check('listPlans is surface only (no context field)', idx.length === 1 && idx[0].context === undefined && idx[0].keywords.includes('unreal'));
check('listPlans query matches keyword', s.listPlans({ query: 'dialogue' }).length === 1);
check('listPlans query filters out misses', s.listPlans({ query: 'zzz' }).length === 0);

// steps
const a = s.addStep(plan.id, { title: 'Create Dialogue data asset', context: 'Make a DataTable row.', tools: ['unreal-mcp'], acceptance_criteria: 'Asset exists.' });
const b = s.addStep(plan.id, { title: 'Bind dialogue to NPC', context: 'Attach component.', tools: ['unreal-mcp'] });
check('addStep auto-orders idx', a.idx === 1 && b.idx === 2);

const opened = s.openPlan(plan.id);
check('openPlan returns step index without bodies', opened.steps.length === 2 && opened.steps[0].context === undefined);

const full = s.getStep(a.id);
check('getStep returns full context + empty attempts log', full.context === 'Make a DataTable row.' && full.attempts.length === 0);

// next_step picks lowest unfinished
const n1 = s.nextStep(plan.id);
check('nextStep returns step 1 first', n1.id === a.id);

// failure log: a failed attempt is preserved, step stays retryable
s.recordAttempt(a.id, { what_tried: 'Used CreateAsset with wrong factory', result: 'factory not found', verdict: 'fail' });
const afterFail = s.getStep(a.id);
check('failed attempt logged', afterFail.attempts.length === 1 && afterFail.attempts[0].verdict === 'fail');
check('failed step marked failed (retryable, not done)', afterFail.status === 'failed');
check('nextStep still returns step 1 after fail', s.nextStep(plan.id).id === a.id);

// pass advances
s.recordAttempt(a.id, { what_tried: 'Used DataTable factory', result: 'asset created', verdict: 'pass' });
check('passed step marked done', s.getStep(a.id).status === 'done');
check('nextStep advances to step 2', s.nextStep(plan.id).id === b.id);
check('both attempts retained in log', s.getStep(a.id).attempts.length === 2);

// attempt provenance: role / review_rounds / executor stored and returned
s.recordAttempt(b.id, { what_tried: 'dispatched to implementer', result: 'accepted after review', verdict: 'fail',
  role: 'implementer', review_rounds: 2, executor: 'runner-mcp' });
const provAtt = s.getStep(b.id).attempts.at(-1);
check('attempt stores role/review_rounds/executor', provAtt.role === 'implementer' && provAtt.review_rounds === 2 && provAtt.executor === 'runner-mcp');
check('attempt provenance defaults are empty/zero', s.getStep(a.id).attempts[0].role === '' && s.getStep(a.id).attempts[0].review_rounds === 0 && s.getStep(a.id).attempts[0].executor === '');

// carry-forward across the reset
s.writeCarryForward(b.id, 'Dialogue asset path: /Game/NPC/DT_Dialogue');
s.writeCarryForward(b.id, 'Row name to use: greet_01');
const bb = s.getStep(b.id);
check('carry_forward appends', bb.carry_forward.includes('DT_Dialogue') && bb.carry_forward.includes('greet_01'));

// links — pathway back to what a step builds on
const link = s.link(b.id, { to_step_id: a.id, relation: 'builds_on', note: 'needs the asset from step 1' });
check('link created', link.relation === 'builds_on');
check('getStep surfaces outbound links', s.getStep(b.id).links.length === 1);

// finish the plan
s.recordAttempt(b.id, { what_tried: 'Bound component', verdict: 'pass' });
check('nextStep null when plan complete', s.nextStep(plan.id) === null);

s.setPlanStatus(plan.id, 'done');
check('plan status set', s.listPlans()[0].done === 2 && s.listPlans({ status: 'done' }).length === 1);

// guardrails
assert.throws(() => s.getStep(9999), /no step/);
assert.throws(() => s.recordAttempt(a.id, { what_tried: '', verdict: 'fail' }), /required/);
assert.throws(() => s.recordAttempt(a.id, { what_tried: 'x', verdict: 'bogus' }), /verdict/);
check('guardrails throw on bad input', true);

// cross-plan lessons: a failure in plan X must surface when starting a similar step in plan Y
const planX = s.createPlan({ title: 'Build installer', keywords: ['installer'] });
const sx = s.addStep(planX.id, { title: 'Sign the Windows executable', tools: ['signtool'] });
s.recordAttempt(sx.id, { what_tried: 'Used signtool remove to strip the Authenticode signature from the exe', result: 'signtool remove syntax rejected; signature not stripped', verdict: 'fail' });

const planY = s.createPlan({ title: 'Ship binary', keywords: ['binary'] });
const sy = s.addStep(planY.id, { title: 'Strip Authenticode signature from executable', tools: ['signtool'] });
const lessons = s.getLessons({ step_id: sy.id, limit: 5 });
check('cross-plan lesson surfaced from another plan', lessons.length >= 1 && lessons[0].plan_id === planX.id && /signtool/i.test(lessons[0].what_tried));
check('lessons exclude the querying step\'s own attempts', lessons.every((l) => l.step_id !== sy.id));
check('next_step embeds matching lessons', Array.isArray(s.nextStep(planY.id).lessons) && s.nextStep(planY.id).lessons.length >= 1);
check('unrelated terms surface no lessons', s.getLessons({ terms: 'banana xylophone quokka', limit: 5 }).length === 0);

// templates: define a skeleton, instantiate it onto a plan, round-trip
const tpl = s.createTemplate({ name: 'Code feature', description: 'Standard feature flow', keywords: ['feature'], steps: [
  { title: 'Design', context: 'Sketch the approach.', acceptance_criteria: 'Approach agreed.' },
  { title: 'Implement', context: 'Write the code.', tools: ['editor'], acceptance_criteria: 'Compiles.' },
  { title: 'Test', context: 'Add tests.', acceptance_criteria: 'Tests pass.' },
]});
check('createTemplate with inline steps', tpl.steps.length === 3 && tpl.name === 'Code feature');
check('listTemplates surfaces it with step count', s.listTemplates().some((t) => t.name === 'Code feature' && t.steps === 3));
check('resolve template by id or name', s.getTemplate(tpl.id).name === 'Code feature' && s.getTemplate('Code feature').steps.length === 3);
const tp = s.createPlan({ title: 'New feature plan', keywords: [] });
const inst = s.instantiateTemplate('Code feature', tp.id);
check('instantiateTemplate clones steps in order', inst.steps.length === 3 && inst.steps[0].title === 'Design' && inst.steps[2].title === 'Test');
const saved = s.saveAsTemplate(tp.id, 'Saved from plan');
check('saveAsTemplate captures a plan\'s steps', saved.steps.length === 3 && saved.steps[1].title === 'Implement');

// createTemplate is atomic: a bad inline step must not leave a half-created template
assert.throws(() => s.createTemplate({ name: 'Half template', steps: [{ title: 'ok' }, {}] }), /title is required/);
check('failed createTemplate leaves no template behind', !s.listTemplates().some((t) => t.name === 'Half template'));

// projects: isolation (the "don't mix across projects unless explicit" rule)
check('default project exists (migration)', s.listProjects().some((p) => p.id === 1) && s.currentProjectId() === 1);
const projB = s.createProject({ name: 'Project B' });
s.setCurrentProject(projB.id);
const planB = s.createPlan({ title: 'B-only plan', keywords: ['bbbword'] });
check('new plan lands in current project', planB.project_id === projB.id);
check('listPlans scopes to current project', s.listPlans().some((p) => p.id === planB.id) && !s.listPlans().some((p) => p.id === plan.id));
check('listPlans all:true crosses projects', s.listPlans({ all: true }).some((p) => p.id === plan.id) && s.listPlans({ all: true }).some((p) => p.id === planB.id));
// project-scoped refs
s.createRef({ kind: 'rule', name: 'B rule', body: 'only in B' });
check('ref defaults to current project', s.listRefs().some((r) => r.name === 'B rule' && r.scope === 'project'));
s.setCurrentProject(1);
check('other project\'s refs not visible here', !s.listRefs().some((r) => r.name === 'B rule'));
check('recall scoped to current project', s.recall('bbbword').hits.length === 0);
check('recall all:true crosses projects', s.recall('bbbword', 8, true).hits.length >= 1);

// file references: cited (surface) then expanded (content) on demand
const selfPath = fileURLToPath(import.meta.url);
const fr = s.addFileRef({ step_id: a.id, path: selfPath, role: 'primary', note: 'this test file' });
check('addFileRef attaches with role', fr.role === 'primary' && fr.step_id === a.id);
const gs = s.getStep(a.id);
check('file ref surfaces in getStep WITHOUT content', gs.file_refs.some((f) => f.id === fr.id) && !('content' in gs.file_refs.find((f) => f.id === fr.id)));
const exp = s.readFileRef(fr.id);
check('readFileRef expands content on demand', exp.exists === true && exp.content.includes('addFileRef'));
check('readFileRef on missing file → exists:false', s.readFileRef(s.addFileRef({ step_id: a.id, path: 'no/such/file.xyz' }).id).exists === false);
s.removeFileRef(fr.id);
check('removeFileRef', !s.getStep(a.id).file_refs.some((f) => f.id === fr.id));

// suggest file refs from the code graph's import edges
const gp = s.createPlan({ title: 'graph plan' });
s.importGraph(gp.id, {
  nodes: [{ id: 'a.mjs', source_file: 'a.mjs' }, { id: 'b.mjs', source_file: 'b.mjs' }, { id: 'c.mjs', source_file: 'c.mjs' }],
  links: [{ source: 'a.mjs', target: 'b.mjs', relation: 'imports_from' }, { source: 'c.mjs', target: 'a.mjs', relation: 'imports_from' }],
});
const sug = s.suggestFileRefs(gp.id, '/root/a.mjs');
check('suggest: dependency (a imports b)', sug.suggestions.some((x) => x.path === '/root/b.mjs' && x.role === 'dependency'));
check('suggest: dependent (c imports a)', sug.suggestions.some((x) => x.path === '/root/c.mjs' && x.role === 'related'));
check('suggest: paths use the primary\'s absolute root', sug.matched === 'a.mjs');

// explicit-idx insert: shifts existing steps instead of duplicating the slot
const ip = s.createPlan({ title: 'insert-at-idx plan' });
const i1 = s.addStep(ip.id, { title: 'first' });
const i2 = s.addStep(ip.id, { title: 'second' });
const i0 = s.addStep(ip.id, { title: 'now first', idx: 1 });
const ipSteps = s.openPlan(ip.id).steps;
check('insert at idx 1 shifts the others', ipSteps.map((x) => x.title).join(',') === 'now first,first,second'
  && ipSteps.map((x) => x.idx).join(',') === '1,2,3' && i0.idx === 1 && i1.id !== i2.id);
assert.throws(() => s.addStep(ip.id, { title: 'bad slot', idx: 0 }), /bad idx/);
assert.throws(() => s.addStep(ip.id, { title: 'bad slot', idx: -3 }), /bad idx/);
check('addStep rejects idx < 1', true);

// updateStep idx acts as a MOVE (contiguous 1..N invariant), not a raw column
// write — moving step 3 to idx 1 slides the others down, and out-of-range idx
// is rejected before it can corrupt ordering. Backed by a UNIQUE(plan_id, idx)
// migration in _migrate; a raw column write would collide with the index.
const mv = s.createPlan({ title: 'move-idx plan' });
const mvA = s.addStep(mv.id, { title: 'A' });
const mvB = s.addStep(mv.id, { title: 'B' });
const mvC = s.addStep(mv.id, { title: 'C' });
s.updateStep(mvC.id, { idx: 1 }); // C should slide to the front
const moved = s.openPlan(mv.id).steps;
check('updateStep(idx=1) moves step forward and renumbers siblings',
  moved.map((x) => x.title).join(',') === 'C,A,B' && moved.map((x) => x.idx).join(',') === '1,2,3');
s.updateStep(mvA.id, { idx: 3 }); // A should slide to the end
const moved2 = s.openPlan(mv.id).steps;
check('updateStep(idx=N) moves step backward and renumbers siblings',
  moved2.map((x) => x.title).join(',') === 'C,B,A' && moved2.map((x) => x.idx).join(',') === '1,2,3');
assert.throws(() => s.updateStep(mvA.id, { idx: 0 }), /bad idx/);
assert.throws(() => s.updateStep(mvA.id, { idx: 99 }), /must be <=/);
check('updateStep(idx) rejects out-of-range moves', true);
// UNIQUE index prevents two steps in the same plan from sharing an idx even
// via a direct raw write attempt. Confirming the index exists is the cheapest
// proof that migration ran.
check('UNIQUE(plan_id, idx) index installed by v4 migration',
  s.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='uq_steps_plan_idx'").get() != null);

// An upstream-v3 DB with duplicate (plan_id, idx) rows must be repaired by the v4
// migration in a single pass before the UNIQUE index goes down — otherwise the
// index creation would fail on the seeded corruption.
{
  const legacy = new Store(':memory:');
  legacy.db.exec('DROP INDEX IF EXISTS uq_steps_plan_idx');
  legacy.db.exec('PRAGMA user_version = 3');
  legacy.db.prepare("INSERT INTO plans (title, keywords, summary, status, created_at, updated_at, project_id) VALUES ('L', '[]', '', 'draft', ?, ?, 1)").run('t','t');
  const pid = legacy.db.prepare('SELECT last_insert_rowid() id').get().id;
  const ins = legacy.db.prepare("INSERT INTO steps (plan_id, idx, title, status, context, tools, role, acceptance_criteria, carry_forward, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  ins.run(pid, 1, 'a', 'pending', '', '[]', '', '', '', 't', 't');
  ins.run(pid, 1, 'b', 'pending', '', '[]', '', '', '', 't', 't'); // duplicate idx on purpose
  ins.run(pid, 5, 'c', 'pending', '', '[]', '', '', '', 't', 't'); // and a gap
  legacy._migrate(); // repair-then-index; must not throw
  const repaired = legacy.db.prepare('SELECT idx FROM steps WHERE plan_id=? ORDER BY idx').all(pid).map((r) => r.idx);
  check('v4 migration upgrades v3 and renumbers duplicate/gapped idx contiguously', repaired.join(',') === '1,2,3');
  legacy.db.exec('DROP INDEX uq_steps_plan_idx; PRAGMA user_version = 4');
  legacy._migrate();
  check('v4 self-heals a stamped DB whose unique index is missing',
    legacy.db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='index' AND name='uq_steps_plan_idx'").get()?.ok === 1);
  legacy.close();
}

// nextStep atomic claim: pending → in_progress in one transaction (used by the
// runner and any concurrent dispatcher so two workers can't take the same step).
const cp = s.createPlan({ title: 'claim plan' });
const cpA = s.addStep(cp.id, { title: 'claim-A' });
s.addStep(cp.id, { title: 'claim-B' });
const claimed = s.nextStep(cp.id, { claim: true, executor: 'test-runner' });
check('nextStep({claim}) returns the workable step already flipped to in_progress',
  claimed.id === cpA.id && claimed.status === 'in_progress' && claimed.claimed === true && claimed.claimed_by === 'test-runner');
// Second claim in the same "tick" must skip the in_progress step and hand out the next.
const claimed2 = s.nextStep(cp.id, { claim: true });
check('nextStep({claim}) skips already-claimed steps and advances',
  claimed2.id !== cpA.id && claimed2.status === 'in_progress');
const activeOnly = s.nextStep(cp.id, { claim: true });
check('nextStep({claim}) does not false-complete while every remaining step is in_progress',
  activeOnly.all_in_progress === true && activeOnly.active_steps.length === 2);
// Peek mode (no claim) is unchanged: does NOT skip in_progress, does NOT flip status.
const peek = s.nextStep(cp.id);
check('nextStep() peek mode preserves idempotent behavior',
  peek.id === cpA.id && peek.status === 'in_progress' && peek.claimed === undefined);
// claimStep helper: same CAS semantics for a specific id.
const cs = s.createPlan({ title: 'cas plan' });
const csA = s.addStep(cs.id, { title: 'cas-A' });
const casClaim1 = s.claimStep(csA.id, { executor: 'A' });
const casClaim2 = s.claimStep(csA.id, { executor: 'B' }); // must lose the race
check('claimStep CAS: first caller wins, second gets current_status',
  casClaim1.claimed === true && casClaim1.claimed_by === 'A'
    && casClaim2.claimed === false && casClaim2.current_status === 'in_progress');

// importGraph atomicity: a failed re-import must not wipe the existing graph
const ag = s.createPlan({ title: 'atomic graph plan' });
s.importGraph(ag.id, { nodes: [{ id: 'n1' }, { id: 'n2' }], links: [{ source: 'n1', target: 'n2' }] });
check('graph imported (2 nodes, 1 edge)', s.graphStats(ag.id).nodes === 2 && s.graphStats(ag.id).edges === 1);
assert.throws(() => s.importGraph(ag.id, {
  nodes: [{ id: 'x1' }, { id: 'x2' }],
  links: [{ source: 'x1', target: 'x2', relation: { bad: 'object' } }], // unbindable → INSERT throws mid-import
}));
const agAfter = s.graphStats(ag.id);
check('failed re-import rolls back — old graph intact', agAfter.nodes === 2 && agAfter.edges === 1);

// blocked steps: next_step skips them instead of wedging; all-blocked ≠ complete
const planZ = s.createPlan({ title: 'Blocked handling', keywords: ['blocked'] });
const z1 = s.addStep(planZ.id, { title: 'Needs a human decision' });
const z2 = s.addStep(planZ.id, { title: 'Independent follow-up' });
s.setStepStatus(z1.id, 'blocked');
const zn = s.nextStep(planZ.id);
check('nextStep skips blocked step to next workable', zn.id === z2.id);
check('nextStep surfaces the skipped blocked step', zn.skipped_blocked_steps.some((b) => b.id === z1.id));
s.setStepStatus(z2.id, 'blocked');
const zb = s.nextStep(planZ.id);
check('all remaining blocked → all_blocked (not null/complete)', zb.all_blocked === true && zb.blocked_steps.length === 2);
check('plan status accepts blocked', s.setPlanStatus(planZ.id, 'blocked').status === 'blocked');

// dependency-aware nextStep: builds_on/blocks to a not-done step defers the candidate
const dp = s.createPlan({ title: 'dependency plan' });
const d1 = s.addStep(dp.id, { title: 'needs the signature work first' });
const d2 = s.addStep(dp.id, { title: 'independent dep-plan work' });
s.link(d1.id, { to_step_id: sy.id, relation: 'builds_on' }); // sy (other plan) is still pending
const dn = s.nextStep(dp.id);
check('nextStep defers a step whose builds_on dep is not done', dn.id === d2.id);
check('deferred step reported with reason dependency', dn.skipped_blocked_steps.some((b) => b.id === d1.id && b.reason === 'dependency' && b.waiting_on_step_ids.includes(sy.id)));
s.link(d2.id, { to_step_id: sy.id, relation: 'references' }); // references is NOT a dependency
check('references link does not defer', s.nextStep(dp.id).id === d2.id);
s.setStepStatus(d2.id, 'done');
const dAll = s.nextStep(dp.id);
check('all remaining dependency-waiting → all_blocked with reason', dAll.all_blocked === true && dAll.blocked_steps.some((b) => b.id === d1.id && b.reason === 'dependency'));
s.recordAttempt(sy.id, { what_tried: 'finished the dependency', verdict: 'pass' });
check('dep done → deferred step becomes workable', s.nextStep(dp.id).id === d1.id);

// readySteps: the concurrently-launchable frontier — must agree with nextStep on
// what is workable. A 3-step plan; step3 builds_on step2 must be EXCLUDED until
// step2 is done, then INCLUDED.
const rp = s.createPlan({ title: 'ready steps plan' });
const r1 = s.addStep(rp.id, { title: 'ready step one' });
const r2 = s.addStep(rp.id, { title: 'ready step two' });
const r3 = s.addStep(rp.id, { title: 'ready step three (depends on two)' });
s.link(r3.id, { to_step_id: r2.id, relation: 'builds_on' });
const readyBefore = s.readySteps(rp.id);
console.log('  readySteps before step2 done:', readyBefore.map((x) => x.id));
check('readySteps excludes step3 while its builds_on dep is unmet', !readyBefore.some((x) => x.id === r3.id));
check('readySteps includes independent steps 1 and 2', readyBefore.some((x) => x.id === r1.id) && readyBefore.some((x) => x.id === r2.id));
check('readySteps returns full step payload (context field present)', readyBefore[0].context !== undefined);
s.recordAttempt(r2.id, { what_tried: 'finished step two', verdict: 'pass' });
const readyAfter = s.readySteps(rp.id);
console.log('  readySteps after step2 done:', readyAfter.map((x) => x.id));
check('readySteps includes step3 once its dep is done', readyAfter.some((x) => x.id === r3.id));
check('readySteps excludes done step2 itself (only retryable work)', !readyAfter.some((x) => x.id === r2.id));
// nextStep and readySteps must agree: nextStep's pick is always IN readySteps (when not all_blocked)
const nsPick = s.nextStep(rp.id);
check('nextStep and readySteps agree on workability', readyAfter.some((x) => x.id === nsPick.id));
s.recordAttempt(r1.id, { what_tried: 'first attempt failed', verdict: 'fail' });
check('readySteps includes failed retryable steps just like nextStep',
  s.readySteps(rp.id).some((x) => x.id === r1.id && x.status === 'failed'));

// readySteps({claim:true}) closes the parallel-frontier race: all returned
// independent steps are in_progress before the orchestrator fans them out, and
// a second caller sees an empty frontier rather than duplicating the work.
const rcp = s.createPlan({ title: 'claimed frontier plan' });
const rc1 = s.addStep(rcp.id, { title: 'frontier one' });
const rc2 = s.addStep(rcp.id, { title: 'frontier two' });
const claimedFrontier = s.readySteps(rcp.id, { claim: true, executor: 'cursor-test' });
check('readySteps({claim}) atomically claims the whole frontier',
  claimedFrontier.length === 2
    && claimedFrontier.every((x) => x.status === 'in_progress' && x.claimed && x.claimed_by === 'cursor-test'));
check('readySteps({claim}) prevents a second dispatcher seeing the same frontier',
  s.readySteps(rcp.id, { claim: true, executor: 'second' }).length === 0);
check('claimed frontier persisted in_progress status',
  s.getStep(rc1.id).status === 'in_progress' && s.getStep(rc2.id).status === 'in_progress');

// layman box: round-trips via BOTH record_attempt(layman=...) and set_layman
const lp = s.createPlan({ title: 'layman plan' });
const lstep = s.addStep(lp.id, { title: 'layman step' });
check('layman defaults to empty string', s.getStep(lstep.id).layman === '');
s.setLayman(lstep.id, 'In plain terms: we wired up the button.');
check('set_layman round-trips via getStep', s.getStep(lstep.id).layman === 'In plain terms: we wired up the button.');
s.recordAttempt(lstep.id, { what_tried: 'wired the button handler', verdict: 'pass', layman: 'Made the button actually do something when clicked.' });
check('record_attempt(layman=...) round-trips via getStep', s.getStep(lstep.id).layman === 'Made the button actually do something when clicked.');
check('record_attempt without layman leaves it unchanged', (() => {
  const before = s.getStep(lstep.id).layman;
  s.recordAttempt(lstep.id, { what_tried: 'a follow-up try', verdict: 'fail' });
  return s.getStep(lstep.id).layman === before;
})());

// notes: append-only review/feedback thread, ordered
const np2 = s.createPlan({ title: 'notes plan' });
const nstep = s.addStep(np2.id, { title: 'notes step' });
check('notes empty by default', s.getStep(nstep.id).notes.length === 0);
s.addNote(nstep.id, { author: 'reviewer', body: 'This looks off, please check the edge case.' });
s.addNote(nstep.id, { author: 'implementer', body: 'Fixed, see attempt 2.' });
const withNotes = s.getStep(nstep.id);
check('add_note appends twice, both present', withNotes.notes.length === 2);
check('notes returned in order (oldest first)', withNotes.notes[0].body.includes('edge case') && withNotes.notes[1].body.includes('Fixed'));
check('notes carry author', withNotes.notes[0].author === 'reviewer' && withNotes.notes[1].author === 'implementer');
assert.throws(() => s.addNote(nstep.id, { author: 'x', body: '' }), /required/);
check('addNote rejects empty body', true);

// attempts cap: getStep returns only the LAST 10 attempts + attempts_total
const capPlan = s.createPlan({ title: 'attempt cap plan' });
const capStep = s.addStep(capPlan.id, { title: 'noisy step' });
for (let i = 1; i <= 12; i++) s.recordAttempt(capStep.id, { what_tried: `try ${i}`, verdict: 'fail' });
const capped = s.getStep(capStep.id);
check('getStep caps attempts at last 10', capped.attempts.length === 10 && capped.attempts_total === 12);
check('capped attempts are the newest, oldest→newest order', capped.attempts[0].what_tried === 'try 3' && capped.attempts.at(-1).what_tried === 'try 12');

// nextPlan: no project_id defaults to the CURRENT project (regression: NULL used to
// bind into "project_id IS NULL OR project_id=?" and match nothing → "fully worked")
const np = s.nextPlan();
check('nextPlan() defaults to the current project', np != null && np.id === planX.id && np.project_id === 1);
check('nextPlan(project) scopes to that project only', s.nextPlan(projB.id) === null); // B's only plan has no workable step

// migration: a pre-provenance DB (attempts without role/review_rounds/executor) gains the columns
{
  const { DatabaseSync } = await import('node:sqlite');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { rmSync } = await import('node:fs');
  const migPath = join(tmpdir(), `plan-ledger-mig-${process.pid}.db`);
  const raw = new DatabaseSync(migPath);
  raw.exec(`CREATE TABLE attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, step_id INTEGER NOT NULL,
    what_tried TEXT NOT NULL, result TEXT NOT NULL DEFAULT '',
    verdict TEXT NOT NULL DEFAULT 'fail', created_at TEXT NOT NULL);`);
  // old-shape steps table: no layman column, predates the layman box
  raw.exec(`CREATE TABLE steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, idx INTEGER NOT NULL,
    title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', context TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '[]', acceptance_criteria TEXT NOT NULL DEFAULT '',
    carry_forward TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  raw.close();
  const ms = new Store(migPath); // ctor migrates
  const cols = ms.db.prepare('PRAGMA table_info(attempts)').all().map((c) => c.name);
  check('migration adds attempt provenance columns', cols.includes('role') && cols.includes('review_rounds') && cols.includes('executor'));
  const stepCols = ms.db.prepare('PRAGMA table_info(steps)').all().map((c) => c.name);
  check('migration adds steps.layman column to an old-shape DB', stepCols.includes('layman'));
  const tableNames = ms.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  check('migration creates the notes table on an old-shape DB', tableNames.includes('notes'));
  check('migration stamps PRAGMA user_version', ms.db.prepare('PRAGMA user_version').get().user_version === Store.USER_VERSION);
  ms.close();
  for (const suf of ['', '-wal', '-shm']) rmSync(migPath + suf, { force: true });
}

// WAL hygiene: after heavy writes + close, the -wal file must be truncated (or gone)
{
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { rmSync, existsSync, statSync } = await import('node:fs');
  const walPath = join(tmpdir(), `plan-ledger-wal-${process.pid}.db`);
  const ws = new Store(walPath);
  const wp = ws.createPlan({ title: 'wal stress plan' });
  const wstep = ws.addStep(wp.id, { title: 'wal step' });
  for (let i = 0; i < 1000; i++) ws.recordAttempt(wstep.id, { what_tried: `attempt ${i} ${'x'.repeat(200)}`, result: 'y'.repeat(200), verdict: 'fail' });
  ws.close();
  const walFile = walPath + '-wal';
  const walSize = existsSync(walFile) ? statSync(walFile).size : 0;
  check('close() truncates the WAL (<100KB or absent)', walSize < 100 * 1024);
  check('close() is idempotent', (ws.close(), true));
  for (const suf of ['', '-wal', '-shm']) rmSync(walPath + suf, { force: true });
}

// defaultDbPath characterization: homedir convention (SEA-safe, no import.meta),
// $PLAN_LEDGER_DB overrides — the ONE path every entry point resolves.
{
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const saved = process.env.PLAN_LEDGER_DB;
  delete process.env.PLAN_LEDGER_DB;
  check('defaultDbPath follows the homedir install convention',
    defaultDbPath() === join(homedir(), 'Documents', 'plan-ledger', 'data', 'plan-ledger.db'));
  process.env.PLAN_LEDGER_DB = join('X:', 'custom', 'pl.db');
  check('defaultDbPath honors $PLAN_LEDGER_DB', defaultDbPath() === join('X:', 'custom', 'pl.db'));
  if (saved === undefined) delete process.env.PLAN_LEDGER_DB; else process.env.PLAN_LEDGER_DB = saved;
}

// role map resolver: precedence, entry shorthands, charter chains, degradation
// (docs/ROLE_MAP_DESIGN.md). All fixtures in a temp dir; PLAN_LEDGER_ROLES keeps
// the user's real ~/.claude/plan-roles.json out of every case. HOME/USERPROFILE
// are redirected at the fixture root so `homedir()`-relative charters (~/…) live
// entirely in the temp tree — no assumption that the machine has any Claude Code
// charters installed.
{
  const { resolveRole, loadRoleMap } = await import('../src/roles.mjs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const root = join(tmpdir(), `plan-ledger-roles-${process.pid}`);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(root, 'charters'), { recursive: true });
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agents', 'implementer.md'), '# implementer charter (fixture)');
  const savedRoles = process.env.PLAN_LEDGER_ROLES;
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const { homedir } = await import('node:os');

  const userMap = join(root, 'user-roles.json');
  writeFileSync(userMap, JSON.stringify({
    roles: { probe: 'user-agent', researcher: 'general-purpose', 'off-role': false, modelled: { model: 'haiku' } },
    projects: { Proj: { roles: { probe: 'user-project-agent' } } },
  }));
  writeFileSync(join(repo, '.plan-roles.json'), JSON.stringify({
    roles: { probe: { agent: 'repo-agent', charter: '../charters/probe.md' } },
  }));
  writeFileSync(join(root, 'charters', 'probe.md'), '# probe charter (fixture)');
  writeFileSync(join(repo, '.claude', 'agents', 'repolocal.md'), '# repo-local charter (fixture)');
  process.env.PLAN_LEDGER_ROLES = userMap; // env override replaces the user file — itself under test here

  // precedence: repo .plan-roles.json > user projects.<name>.roles > user roles
  const r1 = resolveRole('probe', { cwd: repo, projectName: 'Proj' });
  check('role map: repo layer beats user layers', r1.mode === 'dispatch' && r1.agent === 'repo-agent' && r1.source === 'project-file');
  check('role map: relative charter resolves against the declaring file\'s dir', r1.charter === join(root, 'charters', 'probe.md'));
  const r2 = resolveRole('probe', { cwd: null, projectName: 'Proj' });
  check('role map: user-project layer beats user-global', r2.agent === 'user-project-agent' && r2.source === 'user-project');
  const r3 = resolveRole('probe', { cwd: null, projectName: null });
  check('role map: user-global layer + string shorthand → {agent}', r3.agent === 'user-agent' && r3.source === 'user');
  check('role map: roster role remapped to a built-in agent', resolveRole('researcher', {}).agent === 'general-purpose');
  check('role map: model field surfaces on the resolution', resolveRole('modelled', {}).model === 'haiku');

  // degradation: disabled / unknown / untagged → orchestrator decides
  check('role map: false shorthand disables → orchestrator', resolveRole('off-role', {}).mode === 'orchestrator' && resolveRole('off-role', {}).reason === 'disabled');
  check('role map: unknown role (no entry, no charter) → orchestrator', resolveRole('zzz-nope-xyz', {}).reason === 'unknown');
  check('role map: empty role → untagged', resolveRole('', {}).reason === 'untagged');

  // default charter chain: repo .claude/agents/<role>.md shadows ~/.claude/agents/<role>.md
  const rl = resolveRole('repolocal', { cwd: repo });
  check('role map: repo .claude/agents charter makes an unmapped role dispatchable', rl.mode === 'dispatch' && rl.charter === join(repo, '.claude', 'agents', 'repolocal.md') && rl.source === 'default');

  // tilde expansion + declared-but-missing charter falls back to the default chain
  writeFileSync(userMap, JSON.stringify({ roles: {
    tilded: { charter: '~/.claude/agents/implementer.md' },
    implementer: { charter: join(root, 'no-such-charter.md') },
  } }));
  check('role map: ~ charter expands to the home dir', resolveRole('tilded', {}).charter === join(homedir(), '.claude', 'agents', 'implementer.md'));
  check('role map: missing declared charter falls back to the default chain', resolveRole('implementer', {}).charter === join(homedir(), '.claude', 'agents', 'implementer.md'));

  // zero config (env points at a nonexistent file) → today's behavior, bit for bit
  process.env.PLAN_LEDGER_ROLES = join(root, 'no-such-map.json');
  const rd = resolveRole('implementer', { cwd: null, projectName: null });
  check('role map: zero config → default roster (agent = role, ~ charter)', rd.mode === 'dispatch' && rd.agent === 'implementer' && rd.charter === join(homedir(), '.claude', 'agents', 'implementer.md') && rd.source === 'default');

  // malformed JSON: warn once (stderr), skip the layer, never crash dispatch
  const badMap = join(root, 'bad.json');
  writeFileSync(badMap, '{ this is not json !');
  process.env.PLAN_LEDGER_ROLES = badMap;
  let warned = 0; const origWarn = console.warn; console.warn = () => { warned++; };
  const rb = resolveRole('implementer', {});
  console.warn = origWarn;
  check('role map: malformed JSON warns once + falls back to defaults', warned === 1 && rb.mode === 'dispatch' && rb.agent === 'implementer' && rb.source === 'default');
  check('loadRoleMap: missing file → {} silently', Object.keys(loadRoleMap(join(root, 'nope.json'))).length === 0);

  if (savedRoles === undefined) delete process.env.PLAN_LEDGER_ROLES; else process.env.PLAN_LEDGER_ROLES = savedRoles;
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  rmSync(root, { recursive: true, force: true });
}

// projectNameForPlan: the JOIN that keys the role map's user-file projects layer
check('projectNameForPlan resolves the owning project\'s name', s.projectNameForPlan(plan.id) === 'General' && s.projectNameForPlan(planB.id) === 'Project B');
check('projectNameForPlan → null for a missing plan', s.projectNameForPlan(999999) === null);

// ---- Transparent execution roster (v5) -----------------------------------
// Activation-time snapshot, audited reassignment, drift detection, redo preservation,
// and actual-execution provenance on attempts. These are the invariants the board UI
// and the runner both rely on — they must hold at the store level regardless of MCP.
{
  const rs = new Store(':memory:');
  const rp = rs.createPlan({ title: 'roster plan', keywords: ['roster'] });
  const rst = rs.addStep(rp.id, { title: 'roster step', context: 'ctx-initial', role: 'debugger' });
  // Draft plans defer snapshotting until they go active. Adding a step to a draft
  // plan must NOT create a step_assignments row yet.
  check('draft plan: addStep does not snapshot', rs.getStep(rst.id).assignments.length === 0);
  const draftRoster = rs.getPlanRoster(rp.id);
  check('draft roster: snapshotted flag is false, no initial/planned', draftRoster.snapshotted === false && draftRoster.steps[0].initial === null && draftRoster.steps[0].planned === null);

  // Activation snapshots every unsnapshotted step exactly once.
  rs.setPlanStatus(rp.id, 'active');
  const afterActive = rs.getStep(rst.id);
  check('activation snapshots the step', afterActive.assignments.length === 1
    && afterActive.assignments[0].role === 'debugger'
    && afterActive.assignments[0].revision === 1
    && afterActive.assignments[0].reason === ''
    && afterActive.assignments[0].assigned_by === 'plan-activation');
  // Re-activating an already-active plan is a no-op for snapshots (idempotent).
  rs.setPlanStatus(rp.id, 'active');
  check('re-activation does not double-snapshot', rs.getStep(rst.id).assignments.length === 1);

  // A step added to an already-active plan snapshots immediately.
  const rst2 = rs.addStep(rp.id, { title: 'follow-up on active plan', role: 'debugger' });
  check('addStep on an active plan snapshots immediately', rs.getStep(rst2.id).assignments.length === 1
    && rs.getStep(rst2.id).assignments[0].assigned_by === 'add-step');

  // Post-initial reassignment: role change without a reason is refused.
  assert.throws(() => rs.updateStep(rst.id, { role: 'implementer' }), /reason/i);
  check('updateStep refuses a role change without a reason after snapshot', true);
  // With a reason, updateStep appends a revision; explicit assignStep also appends.
  rs.updateStep(rst.id, { role: 'implementer', reason: 'smoke: promote', assigned_by: 'smoke' });
  rs.assignStep(rst.id, { role: 'implementer', reason: 'smoke: keep implementer, edit intent', assigned_by: 'reviewer' });
  const revised = rs.getStep(rst.id);
  check('assignments append with reason + assigned_by',
    revised.assignments.length === 3
      && revised.assignments[1].reason === 'smoke: promote' && revised.assignments[1].assigned_by === 'smoke'
      && revised.assignments[2].reason === 'smoke: keep implementer, edit intent'
      && revised.assignments[2].assigned_by === 'reviewer');
  assert.throws(() => rs.assignStep(rst.id, { role: 'debugger' }), /reason/i);
  check('assignStep refuses without a reason', true);

  // Context-drift detection: editing context after the snapshot flags it.
  rs.updateStep(rst.id, { context: 'ctx-edited-later' });
  const drifted = rs.getPlanRoster(rp.id).steps.find((row) => row.step_id === rst.id);
  check('roster drift: context_changed is set when the body diverges from the snapshot',
    drifted.drift.context_changed === true);

  // Actual-execution provenance: recordAttempt stores agent/model/model_source/session_ref.
  rs.recordAttempt(rst.id, { what_tried: 'smoke provenance', verdict: 'pass',
    agent: 'general-purpose', model: 'claude-sonnet-4-5', model_source: 'runner-cli', session_ref: 'sess-42' });
  const attProv = rs.getStep(rst.id).attempts.at(-1);
  check('recordAttempt persists agent/model/model_source/session_ref',
    attProv.agent === 'general-purpose' && attProv.model === 'claude-sonnet-4-5'
      && attProv.model_source === 'runner-cli' && attProv.session_ref === 'sess-42');
  const rosterAfterAttempt = rs.getPlanRoster(rp.id).steps.find((row) => row.step_id === rst.id);
  check('roster aggregates actual execution provenance from the latest attempt',
    rosterAfterAttempt.actual?.model === 'claude-sonnet-4-5' && rosterAfterAttempt.actual?.model_source === 'runner-cli');

  // Redo preserves attempts + all assignment revisions and appends a note.
  rs.redoStep(rst.id, { reason: 'smoke: retry with different approach', assigned_by: 'user' });
  const redone = rs.getStep(rst.id);
  check('redoStep: back to pending, attempts and assignments preserved, note appended',
    redone.status === 'pending'
      && redone.attempts.length === 1
      && redone.assignments.length === 3
      && redone.notes.some((n) => n.body.includes('[redo]') && /different approach/.test(n.body)));
  assert.throws(() => rs.redoStep(rst.id), /reason/i);
  check('redoStep refuses without a reason', true);
  rs.close();
}

// v5 migration coverage: an old-shape DB stamped at v4 must gain the new columns +
// the step_assignments table without losing any data.
{
  const { DatabaseSync } = await import('node:sqlite');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { rmSync } = await import('node:fs');
  const migPath = join(tmpdir(), `plan-ledger-v5-mig-${process.pid}.db`);
  const raw = new DatabaseSync(migPath);
  // Seed a fully-populated v4-shape schema: attempts without the new provenance columns,
  // and NO step_assignments table at all.
  raw.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT );
    CREATE TABLE plans (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, title TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE steps (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, idx INTEGER NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', context TEXT NOT NULL DEFAULT '',
      tools TEXT NOT NULL DEFAULT '[]', role TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '', carry_forward TEXT NOT NULL DEFAULT '',
      layman TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, step_id INTEGER NOT NULL,
      what_tried TEXT NOT NULL, result TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL DEFAULT 'fail',
      role TEXT NOT NULL DEFAULT '', review_rounds INTEGER NOT NULL DEFAULT 0,
      executor TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    PRAGMA user_version = 4;`);
  raw.prepare("INSERT INTO projects (id, name, description, status, created_at, updated_at) VALUES (1, 'General', '', 'active', 't', 't')").run();
  raw.prepare("INSERT INTO plans (project_id, title, status, created_at, updated_at) VALUES (1, 'legacy plan', 'active', 't', 't')").run();
  raw.prepare("INSERT INTO steps (plan_id, idx, title, role, created_at, updated_at) VALUES (1, 1, 'legacy step', 'implementer', 't', 't')").run();
  raw.prepare("INSERT INTO attempts (step_id, what_tried, verdict, created_at) VALUES (1, 'legacy attempt', 'fail', 't')").run();
  raw.close();

  const ms = new Store(migPath);
  const attCols = ms.db.prepare('PRAGMA table_info(attempts)').all().map((c) => c.name);
  check('v5 migration adds attempts.agent/model/model_source/session_ref',
    attCols.includes('agent') && attCols.includes('model') && attCols.includes('model_source') && attCols.includes('session_ref'));
  const tables = ms.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  check('v5 migration creates step_assignments', tables.includes('step_assignments'));
  // v6: the prior-plan discovery provenance table is created on an old-shape DB by the
  // schema's CREATE TABLE IF NOT EXISTS, and the stamp advances to the current version.
  check('v6 migration creates plan_consultations', tables.includes('plan_consultations'));
  check('migration stamps PRAGMA user_version to the current USER_VERSION (>= 6)',
    ms.db.prepare('PRAGMA user_version').get().user_version === Store.USER_VERSION && Store.USER_VERSION >= 6);
  // Legacy row survives with sane defaults (blank actual-execution provenance = "unknown").
  const legacyStep = ms.getStep(1);
  check('legacy attempt is preserved with blank provenance defaults',
    legacyStep.attempts.length === 1
      && legacyStep.attempts[0].agent === '' && legacyStep.attempts[0].model === ''
      && legacyStep.attempts[0].model_source === '' && legacyStep.attempts[0].session_ref === '');
  // A step that pre-existed the snapshot mechanism has NO assignment history yet;
  // re-activating (or first-time activating) is the trigger. The plan was already
  // 'active' in the seeded DB, so the migration itself does not snapshot — but
  // snapshotStepAssignment (or a downstream setPlanStatus toggle) will pick it up.
  ms.snapshotStepAssignment(1, { assigned_by: 'migration-backfill' });
  check('snapshotStepAssignment freezes a pre-existing step on demand',
    ms.getStep(1).assignments.length === 1 && ms.getStep(1).assignments[0].role === 'implementer');
  ms.close();
  for (const suf of ['', '-wal', '-shm']) rmSync(migPath + suf, { force: true });
}

console.log(`\n${pass} checks passed.`);
s.close();
