// graph-routes.mjs — the board's Graph explorer: the node/edge projections
// (brain, plan steps, code map), finding detail, editing a memory over HTTP (with
// truth maintenance), the step brain, and a parse check of the inline board script.
// Boots the real board server on 127.0.0.1 with a temp DB. Run: node test/graph-routes.mjs
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';
import { createBoardServer } from '../web/board.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = join(tmpdir(), `plan-ledger-graph-${process.pid}.db`);
const root = join(tmpdir(), `plan-ledger-graph-src-${process.pid}`);
for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'Source'), { recursive: true });
writeFileSync(join(root, 'Source', 'Save.cpp'), 'int SchemaVersion = 11;\n');

const store = new Store(dbPath);
const server = createBoardServer({ store, html: '<html><body>test</body></html>' });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log('  ok  ' + label); pass++; };
async function req(method, path, body) {
  const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// ---- fixtures: a plan with linked steps, a brain with deps/conflict, a code graph
const plan = store.createPlan({ title: 'M7' });
const other = store.createPlan({ title: 'M8' });
const s1 = store.addStep(plan.id, { title: 'Save schema for Z02', context: 'Bump the save schema and migrate old saves.' });
const s2 = store.addStep(plan.id, { title: 'Z02 graybox', context: 'Build the Z02 map.' });
store.link(s2.id, { to_step_id: s1.id, relation: 'builds_on' });
store.link(s2.id, { to_plan_id: other.id, relation: 'references' });
store.setProjectRoot(1, root);
const one = (f) => store.absorbFindings([f], { step_id: s1.id }).results[0];
const A = one({ subject: 'Source/Save.cpp', slot: 'schema', claim: 'the save schema version is 11', evidence: ['Source/Save.cpp:1'] });
const B = one({ subject: 'saves#migration', claim: 'old saves migrate one version at a time up to 11', depends_on: [A.id] });
const C = one({ subject: 'saves#migration', claim: 'old saves migrate one version at a time up to 12' }); // conflicts with B (number)
store.importGraph(plan.id, { nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, label: `sym${i}`, source_file: 'src/x.mjs' })),
  links: Array.from({ length: 29 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}`, relation: 'calls' })) });

// ---- brain graph
let r = await req('GET', '/api/brain/graph?project=1&status=any');
check('GET /api/brain/graph → 200 with nodes + edges', r.status === 200 && Array.isArray(r.data.nodes) && Array.isArray(r.data.edges));
const g = r.data, ids = new Set(g.nodes.map((n) => n.id));
check('brain nodes: findings, the file they rest on, the step they were learned in',
  ids.has(`f:${A.id}`) && ids.has(`f:${B.id}`) && g.nodes.some((n) => n.type === 'file' && n.path === 'Source/Save.cpp') && ids.has(`s:${s1.id}`));
check('brain edges: depends_on B→A, rests_on A→file, learned_in →step',
  g.edges.some((e) => e.type === 'depends_on' && e.from === `f:${B.id}` && e.to === `f:${A.id}`) &&
  g.edges.some((e) => e.type === 'rests_on' && e.from === `f:${A.id}`) && g.edges.some((e) => e.type === 'learned_in' && e.to === `s:${s1.id}`));
check('a conflicting pair is marked status "conflict" and joined by a conflict edge',
  g.nodes.find((n) => n.id === `f:${C.id}`).status === 'conflict' && g.edges.some((e) => e.type === 'conflict'));
check('file paths are shown relative to the project root', g.root && !g.nodes.find((n) => n.type === 'file').path.includes(':'));

// ---- finding detail + editing a memory (truth maintenance over HTTP)
r = await req('GET', `/api/findings/${A.id}`);
check('GET /api/findings/:id → detail with dependents + history', r.status === 200 && r.data.dependents.includes(B.id) && Array.isArray(r.data.history));
r = await req('POST', `/api/findings/${A.id}/resolve`, { verdict: 'revised', claim: 'the save schema version is 12', reason: 'board test' });
check('POST resolve (revised) → new finding, and what was built on it is re-opened',
  r.status === 200 && r.data.replaced === A.id && r.data.finding.claim.includes('12') && r.data.suspected.includes(B.id));
const brainAfter = (await req('GET', '/api/brain/graph?project=1&status=any')).data;
check('after the edit: old version superseded (with a superseded_by edge), dependent suspect',
  brainAfter.nodes.find((n) => n.id === `f:${A.id}`).status === 'superseded' &&
  brainAfter.edges.some((e) => e.type === 'superseded_by' && e.from === `f:${A.id}`) &&
  brainAfter.nodes.find((n) => n.id === `f:${B.id}`).status === 'suspect');
check('status=live hides history', !(await req('GET', '/api/brain/graph?project=1')).data.nodes.some((n) => n.status === 'superseded'));
r = await req('POST', `/api/findings/${B.id}/resolve`, { verdict: 'bogus' });
check('an invalid verdict → 400 with a message', r.status === 400 && /verdict/.test(r.data.error));

// ---- step brain + stale check
r = await req('GET', `/api/steps/${s1.id}/brain`);
check('GET /api/steps/:id/brain → the step brief (live findings for that step)', r.status === 200 && r.data.length >= 1 && r.data.every((f) => f.claim));
writeFileSync(join(root, 'Source', 'Save.cpp'), 'int SchemaVersion = 13;\n');
r = await req('POST', '/api/brain/check-stale', { project_id: 1 });
check('POST /api/brain/check-stale re-hashes sources (the edited file re-opens its fact)', r.status === 200 && r.data.suspected.length === 1);

// ---- plan step graph + code map
r = await req('GET', `/api/plans/${plan.id}/step-graph`);
check('step graph: both steps, a builds_on edge, a next edge, and the other plan as a node',
  r.status === 200 && r.data.nodes.filter((n) => n.type === 'step').length === 2 &&
  r.data.edges.some((e) => e.type === 'builds_on') && r.data.edges.some((e) => e.type === 'next') && r.data.nodes.some((n) => n.id === `p:${other.id}`));
r = await req('GET', `/api/plans/${plan.id}/code-graph?limit=10`);
check('code map is trimmed to the top-degree nodes, edges only among kept nodes, total reported',
  r.status === 200 && r.data.nodes.length === 10 && r.data.total === 30 &&
  r.data.edges.every((e) => r.data.nodes.some((n) => n.id === e.from) && r.data.nodes.some((n) => n.id === e.to)));
check('unknown plan → 400', (await req('GET', '/api/plans/99999/step-graph')).status === 400);

// ---- the board's inline script parses and wires the explorer
const html = readFileSync(join(here, '..', 'web', 'index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
check('index.html inline script parses', (() => { try { new Function(script); return true; } catch (e) { console.error(e); return false; } })());
check('index.html has the Graph explorer (view, header button, step brain, deep link)',
  html.includes('id="graphView"') && html.includes('id="graphBtn"') && script.includes('function renderStepBrain') && script.includes('function gvDeepLink'));

check('index.html has the navigation aids (overview map, path finder, arrow walk, attention queue, focus depth, key help)',
  html.includes('id="gvMini"') && html.includes('id="gvPathBar"') && html.includes('id="gvKeys"') && html.includes('id="gvDepth"') && html.includes('id="gvAttn"') &&
  ['function gvMini', 'function gvFindPath', 'function gvWalk', 'function gvNextAttention', 'function gvShowPath'].every((f) => script.includes(f)));
// the path finder, run on its own: it prefers "built on / rests on" chains over "learned in the same step" hubs
{
  const src = script.slice(script.indexOf('const GV_PATH_COST'), script.indexOf('const GV_REL'));
  const GV = { adj: new Map(), edgeType: new Map() };
  const link = (a, b, t) => { for (const [x, y] of [[a, b], [b, a]]) { if (!GV.adj.has(x)) GV.adj.set(x, new Set()); GV.adj.get(x).add(y); } GV.edgeType.set(`${a}|${b}`, t); GV.edgeType.set(`${b}|${a}`, '~' + t); };
  link('f:1', 's:9', 'learned_in'); link('f:2', 's:9', 'learned_in'); // 2 hops via a step hub (cost 8)
  link('f:2', 'f:3', 'depends_on'); link('f:3', 'file:x', 'rests_on'); link('f:1', 'file:x', 'rests_on'); // 3 hops of real links (cost 3)
  link('f:7', 'f:8', 'depends_on');
  const findPath = new Function('GV', `${src}; return gvFindPath;`)(GV);
  check('path finder takes the chain of real links over the shared-step shortcut', JSON.stringify(findPath('f:1', 'f:2')) === JSON.stringify(['f:1', 'file:x', 'f:3', 'f:2']));
  check('path finder: unconnected nodes → null', findPath('f:1', 'f:7') === null);
}

// flow around a selection: cyan "comes from" vs orange "affects", walking the whole chain
{
  const src = script.slice(script.indexOf('const GV_SOURCE_IS_FROM'), script.indexOf('function gvFlowKey'));
  const edges = [
    { from: 'f:2', to: 'f:1', type: 'depends_on' }, { from: 'f:3', to: 'f:2', type: 'depends_on' }, // 3 built on 2 built on 1
    { from: 'f:1', to: 'file:a', type: 'rests_on' }, { from: 'f:9', to: 'file:a', type: 'rests_on' },
    { from: 'f:1', to: 's:5', type: 'learned_in' }, { from: 'f:8', to: 's:5', type: 'learned_in' },
    { from: 'f:3', to: 'f:4', type: 'superseded_by' }, { from: 'f:2', to: 'f:7', type: 'conflict' },
  ];
  const GV = { kind: 'brain', edgesOf: new Map() };
  for (const e of edges) for (const x of [e.from, e.to]) { if (!GV.edgesOf.has(x)) GV.edgesOf.set(x, []); GV.edgesOf.get(x).push(e); }
  const flow = new Function('GV', `${src}; return gvFlow;`)(GV);
  const f2 = flow('f:2'), fa = flow('file:a');
  check('flow: comes from = what it is built on, the file and step under that (by hop); a step hub is not walked through',
    f2.up.get('f:1') === 1 && f2.up.get('file:a') === 2 && f2.up.get('s:5') === 2 && !f2.up.has('f:8') && !f2.up.has('f:9'));
  check('flow: affects = what is built on it and onward, incl. the revision that replaced a dependent; conflicts are neither',
    f2.down.get('f:3') === 1 && f2.down.get('f:4') === 2 && !f2.down.has('f:7') && !f2.up.has('f:7'));
  check('flow: a file affects the facts resting on it and what is built on those', fa.down.get('f:1') === 1 && fa.down.get('f:9') === 1 && fa.down.get('f:3') === 3 && fa.up.size === 0);
}

await new Promise((resolve) => server.close(resolve));
store.close();
for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} graph-route checks passed.`);
