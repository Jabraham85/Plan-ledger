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
check('readySteps excludes done step2 itself (only pending)', !readyAfter.some((x) => x.id === r2.id));
// nextStep and readySteps must agree: nextStep's pick is always IN readySteps (when not all_blocked)
const nsPick = s.nextStep(rp.id);
check('nextStep and readySteps agree on workability', readyAfter.some((x) => x.id === nsPick.id));

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
  raw.close();
  const ms = new Store(migPath); // ctor migrates
  const cols = ms.db.prepare('PRAGMA table_info(attempts)').all().map((c) => c.name);
  check('migration adds attempt provenance columns', cols.includes('role') && cols.includes('review_rounds') && cols.includes('executor'));
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
// the user's real ~/.claude/plan-roles.json out of every case.
{
  const { resolveRole, loadRoleMap } = await import('../src/roles.mjs');
  const { tmpdir, homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const root = join(tmpdir(), `plan-ledger-roles-${process.pid}`);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(root, 'charters'), { recursive: true });
  const savedRoles = process.env.PLAN_LEDGER_ROLES;

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
  rmSync(root, { recursive: true, force: true });
}

// projectNameForPlan: the JOIN that keys the role map's user-file projects layer
check('projectNameForPlan resolves the owning project\'s name', s.projectNameForPlan(plan.id) === 'General' && s.projectNameForPlan(planB.id) === 'Project B');
check('projectNameForPlan → null for a missing plan', s.projectNameForPlan(999999) === null);

console.log(`\n${pass} checks passed.`);
s.close();
