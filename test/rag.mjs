// rag.mjs — unit + behavioral tests for the RAG core engine (plan #98, step 511).
// Temp/in-memory DBs ONLY — never data/plan-ledger.db or a real data/rag.db.
// Run: node test/rag.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { chunk, estTokens, CHUNK_DEFAULTS } from '../src/rag/chunker.mjs';
import { RagStore, parseChunkId } from '../src/rag/store.mjs';
import { ingestFs } from '../src/rag/ingest/fs.mjs';
import { ingestGit } from '../src/rag/ingest/git.mjs';
import { ingestWeb, htmlToText, parseRobots, robotsAllows } from '../src/rag/ingest/web.mjs';
import { ingestWiki, wikitextToText } from '../src/rag/ingest/wiki.mjs';
import { registerRagTools } from '../src/rag/tools.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FX = join(__dirname, 'fixtures', 'rag');
let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log('  ok  ' + label); pass++; };
const section = (s) => console.log('\n== ' + s + ' ==');

// A mock MCP server: capture the registered handlers so we can invoke them and
// parse the JSON payload exactly as a real client would receive it.
function harness(store, deps) {
  const handlers = {};
  registerRagTools({ registerTool: (name, cfg, fn) => { handlers[name] = fn; } }, store, deps);
  const unwrap = (res) => (res.isError ? { __error: res.content[0].text } : JSON.parse(res.content[0].text));
  // Thenable-aware: sync tools return the parsed object directly (existing callers
  // unchanged); async ingest (website/wiki) returns a promise the caller awaits.
  return (name, args) => {
    const res = handlers[name](args ?? {});
    return (res && typeof res.then === 'function') ? res.then(unwrap) : unwrap(res);
  };
}

// ---------------------------------------------------------------------------
section('chunker — determinism, bounds, fence atomicity');

const boundaryText = readFileSync(join(FX, 'boundary.md'), 'utf8');
const c1 = chunk(boundaryText, 'markdown');
const c2 = chunk(boundaryText, 'markdown');
check('chunker is deterministic (identical text/heading/lines twice)',
  JSON.stringify(c1) === JSON.stringify(c2));

const { MIN, MAX } = CHUNK_DEFAULTS;
check('every chunk is within MAX estimated tokens', c1.every((c) => c.tokens <= MAX));
check('estTokens is ceil(chars/4)', estTokens('abcd') === 1 && estTokens('abcde') === 2 && estTokens('') === 0);

// Oversized single block hard-splits at line boundaries into MAX-sized pieces.
const bigLines = Array.from({ length: 40 }, (_, i) => `line ${i} ` + 'word '.repeat(40)).join('\n');
const bigChunks = chunk(bigLines, 'text');
check('oversized block hard-splits into >1 chunk, each <= MAX',
  bigChunks.length > 1 && bigChunks.every((c) => c.tokens <= MAX));
check('hard-split never breaks a line (contiguous, non-overlapping line ranges)',
  bigChunks.every((c, i) => i === 0 || c.startLine === bigChunks[i - 1].endLine + 1));

// Fence atomicity: a fenced code block stays one block even with blank lines and
// heading-looking lines inside it.
const fenceDoc = [
  '# Title', '', 'Intro paragraph here that sets things up for the reader.', '',
  '```js', 'function f() {', '', '  // # not a heading, blank line above stays in the fence', '  return 1;', '}', '```', '',
  '## After', '', 'Trailing paragraph after the fence block for good measure.',
].join('\n');
const fenceChunks = chunk(fenceDoc, 'markdown');
const fenceChunk = fenceChunks.find((c) => c.text.includes('```js'));
// Atomicity = the whole fence (open marker → close marker) lives in ONE chunk; a
// naive splitter would break at the internal blank line or the internal '#' line.
check('fenced code block is atomic (open+body+close never split apart)',
  fenceChunk && fenceChunk.text.includes('```js') && fenceChunk.text.includes('function f() {')
  && fenceChunk.text.includes('return 1;') && fenceChunk.text.includes('}\n```'));
check('internal blank line and "# not a heading" line stay inside the fence chunk',
  fenceChunk.text.includes('# not a heading') && /return 1;/.test(fenceChunk.text)
  && fenceChunks.filter((c) => c.text.includes('```js')).length === 1);

check('parseChunkId handles active and version-pinned ids',
  (() => { const a = parseChunkId('frontier-docs-17'), b = parseChunkId('frontier-docs@v2-17');
    return a.codename === 'frontier-docs' && a.version === null && a.seq === 17
      && b.codename === 'frontier-docs' && b.version === 2 && b.seq === 17; })());

// ---------------------------------------------------------------------------
section('store — versioning, stable ids, supersede');

{
  const store = new RagStore(':memory:');
  const root = '/synthetic/ver.md';
  const A = '# Doc\n\nThe alpha paragraph mentions harvester yield tuning in detail here.\n\n## Two\n\nA second section about resource quality tiers and crafting premiums follows.';
  const B = A.replace('alpha', 'beta-rewritten').replace('yield tuning', 'yield rebalancing pass');

  const v1 = store.ingestDocs({ codename: 'ver', type: 'file', root, docs: [{ doc_path: 'ver.md', text: A, kind: 'markdown' }] });
  const hashesV1 = store.activeChunks(['ver']).map((c) => `${c.seq}:${c.hash}`);
  // Re-ingest IDENTICAL content -> new version, but seq->hash mapping is stable.
  const v2 = store.ingestDocs({ codename: 'ver', type: 'file', root, docs: [{ doc_path: 'ver.md', text: A, kind: 'markdown' }] });
  const hashesV2 = store.activeChunks(['ver']).map((c) => `${c.seq}:${c.hash}`);
  check('re-ingest of identical content bumps version', v1.version === 1 && v2.version === 2);
  check('codename-N is stable across re-ingest of identical content (same seq->hash)',
    JSON.stringify(hashesV1) === JSON.stringify(hashesV2));

  // Re-ingest CHANGED content -> old version-pinned id still resolves, superseded.
  store.ingestDocs({ codename: 'ver', type: 'file', root, docs: [{ doc_path: 'ver.md', text: B, kind: 'markdown' }] });
  const cited = store.cite(['ver@v2-1', 'ver-1']);
  check('superseded generation still resolves with superseded:true',
    cited[0].superseded === true && cited[0].version === 2 && cited[0].active_version === 3);
  check('bare codename-N resolves to the active (newest) version', cited[1].superseded === false && cited[1].version === 3);
  check('only one superseded generation retained (N-2 pruned)',
    store.cite(['ver@v1-1'])[0].error !== undefined);
}

// ---------------------------------------------------------------------------
// The behavioral suite, parameterized over BOTH rankers via RAG_RANKER.
function behavioralSuite(rankerEnv) {
  section(`behavioral suite — ranker=${rankerEnv || 'fts5 (default)'}`);
  const prev = process.env.RAG_RANKER;
  if (rankerEnv) process.env.RAG_RANKER = rankerEnv; else delete process.env.RAG_RANKER;
  try {
    const store = new RagStore(':memory:');
    const call = harness(store);

    // ingest via the fs seam (file + folder)
    const ing = call('rag_ingest', { source: join(FX, 'boundary.md'), codename: 'boundary' });
    check(`[${rankerEnv || 'fts'}] rag_ingest file -> chunks + directive`, ing.chunks === 6 && /rag_query/.test(ing.directive));
    const ingC = call('rag_ingest', { source: join(FX, 'corpus'), codename: 'corpus' });
    check(`[${rankerEnv || 'fts'}] rag_ingest folder -> 3 docs`, ingC.docs === 3 && ingC.type === 'folder');

    // rag_query: slim hits + which ranker actually ran
    const q = call('rag_query', { query: 'quantum flux capacitor', codenames: ['boundary'] });
    check(`[${rankerEnv || 'fts'}] ranker reported matches selection`, q.ranker === (rankerEnv === 'js' ? 'js' : 'fts5'));
    check(`[${rankerEnv || 'fts'}] slim hits carry chunk/score/locator/heading/snippet, no full text`,
      q.hits.length >= 1 && q.hits.every((h) => h.chunk && typeof h.score === 'number' && h.locator && h.text === undefined));

    // THE BOUNDARY TEST: expansion stops at the irrelevant neighbors (seq2 and seq6),
    // so the run is EXACTLY the three consecutive relevant sections {3,4,5}.
    const runSeqs = q.expanded[0].seqs;
    check(`[${rankerEnv || 'fts'}] BOUNDARY: expansion run is exactly {3,4,5} — stops at irrelevant neighbors`,
      JSON.stringify(runSeqs) === JSON.stringify([3, 4, 5]));
    check(`[${rankerEnv || 'fts'}] BOUNDARY: irrelevant neighbors seq2 and seq6 are excluded`,
      !runSeqs.includes(2) && !runSeqs.includes(6));
    check(`[${rankerEnv || 'fts'}] expanded run exposes first/last for further walking`,
      q.expanded[0].first === 'boundary-3' && q.expanded[0].last === 'boundary-5' && /boundary-3\.\.boundary-5/.test(q.expanded[0].chunks));

    // token_budget truncation marker
    const qt = call('rag_query', { query: 'quantum flux capacitor', codenames: ['boundary'], token_budget: 120 });
    check(`[${rankerEnv || 'fts'}] token_budget overflow emits truncated + rag_expand next pointer`,
      qt.truncated === true && /rag_expand \{chunk:/.test(qt.next));

    // real line-range locators (folder corpus)
    const guideHit = call('rag_query', { query: 'yield modifier stacks node richness', codenames: ['corpus'] });
    check(`[${rankerEnv || 'fts'}] locators are real path#Lstart-Lend ranges`,
      guideHit.hits.every((h) => /^[\w.]+#L\d+-L\d+$/.test(h.locator)));

    // rag_expand directional walk
    const exN = call('rag_expand', { chunk: 'boundary-3', direction: 'next', count: 2 });
    check(`[${rankerEnv || 'fts'}] rag_expand next walks forward (3 -> 3,4,5)`,
      exN.chunks.map((c) => c.chunk).join(',') === 'boundary-3,boundary-4,boundary-5');
    const exP = call('rag_expand', { chunk: 'boundary-5', direction: 'prev', count: 2 });
    check(`[${rankerEnv || 'fts'}] rag_expand prev walks backward (5 -> 3,4,5)`,
      exP.chunks.map((c) => c.chunk).join(',') === 'boundary-3,boundary-4,boundary-5');

    // rag_cite -> exact path#L locator
    const cite = call('rag_cite', { chunks: ['boundary-3'] });
    check(`[${rankerEnv || 'fts'}] rag_cite translates id -> path#Lstart-Lend`,
      cite.citations[0].locator === 'boundary.md#L17-L22' && cite.citations[0].superseded === false);

    // FTS injection attempt: tokenized + quoted, never throws
    const inj = call('rag_query', { query: 'x" OR NEAR( * -term', codenames: ['boundary'] });
    check(`[${rankerEnv || 'fts'}] FTS injection query returns cleanly (results or empty, never throws)`,
      inj.__error === undefined && Array.isArray(inj.hits));

    // rag_forget removes a codename fully
    const forget = call('rag_forget', { codename: 'boundary' });
    check(`[${rankerEnv || 'fts'}] rag_forget removes every version + chunk`,
      forget.removed_chunks === 6 && forget.removed_versions.length >= 1);
    check(`[${rankerEnv || 'fts'}] forgotten codename is gone from status and unqueryable`,
      call('rag_status', { codename: 'boundary' }).sources.length === 0 &&
      call('rag_query', { query: 'quantum flux capacitor', codenames: ['boundary'] }).hits.length === 0);
    store.close();
  } finally {
    if (prev === undefined) delete process.env.RAG_RANKER; else process.env.RAG_RANKER = prev;
  }
}

behavioralSuite('');    // FTS5 (default)
behavioralSuite('js');  // pure-JS BM25 fallback

// ---------------------------------------------------------------------------
// A local fake fetch: serves a URL->response route table, no live network. Shaped
// like the subset of Response the ingesters touch (status/headers.get/text/json).
function makeRes(status, headers, body) {
  const h = new Map(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    headers: { get: (n) => (h.has(String(n).toLowerCase()) ? h.get(String(n).toLowerCase()) : null) },
    text: async () => body ?? '',
    json: async () => JSON.parse(body),
  };
}
function fakeFetch(routes, calls) {
  return async (url) => {
    if (calls) calls.push(String(url));
    const r = routes[String(url)];
    if (!r) return makeRes(404, { 'content-type': 'text/html' }, 'not found');
    return makeRes(r.status ?? 200, r.headers ?? { 'content-type': 'text/html; charset=utf-8' }, r.body ?? '');
  };
}
const HTML = { 'content-type': 'text/html; charset=utf-8' };
const JSONH = { 'content-type': 'application/json' };

// ---------------------------------------------------------------------------
section('git ingester — temp repo, tracked-only, sha locators, edge aborts');
{
  const repo = mkdtempSync(join(tmpdir(), 'rag-git-fx-'));
  const gc = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  spawnSync('git', ['init', repo], { encoding: 'utf8' });
  writeFileSync(join(repo, 'readme.md'), '# Repo\n\nAlpha content about the harvester yield modifier and node richness tuning lives in this repository for retrieval.\n');
  writeFileSync(join(repo, 'code.mjs'), 'export function f() {\n  return 42;\n}\n');
  writeFileSync(join(repo, 'pic.bin'), Buffer.from([0, 1, 2, 0, 3, 0])); // NUL bytes -> binary skip
  gc('add', '-A');
  gc('commit', '-m', 'initial commit about yield');
  writeFileSync(join(repo, 'readme.md'), '# Repo\n\nAlpha content about the harvester yield modifier and node richness tuning, plus a second paragraph added later on.\n');
  gc('add', '-A');
  gc('commit', '-m', 'second commit richness');

  const res = ingestGit(repo, { include_log: true });
  check('git ingest returns type git + a short sha', res.type === 'git' && /^[0-9a-f]{7,}$/.test(res.sha));
  check('git ingests tracked text files, skips the NUL binary',
    res.docs.some((d) => d.doc_path === 'readme.md') && res.docs.some((d) => d.doc_path === 'code.mjs')
    && res.skipLog.some((s) => s.path === 'pic.bin' && s.reason === 'binary'));
  check('include_log adds a _commits synthetic doc', res.docs.some((d) => d.doc_path === '_commits' && /second commit richness/.test(d.text)));
  check('git locator is path@sha#Lstart-Lend',
    res.makeLocator({ doc_path: 'readme.md' }, { startLine: 1, endLine: 3 }) === `readme.md@${res.sha}#L1-L3`);

  // Round-trip through the tool (git is synchronous): ingest -> query -> cite.
  const store = new RagStore(':memory:');
  const call = harness(store);
  const ing = call('rag_ingest', { source: repo, codename: 'gitfx', type: 'git' });
  check('rag_ingest git -> chunks + directive', ing.chunks >= 1 && /rag_query/.test(ing.directive));
  const q = call('rag_query', { query: 'harvester yield modifier node richness', codenames: ['gitfx'] });
  check('git chunk round-trips to a path@sha#L locator',
    q.hits.length >= 1 && /@[0-9a-f]{7,}#L\d+-L\d+$/.test(q.hits[0].locator));
  const cite = call('rag_cite', { chunks: [q.hits[0].chunk] });
  check('rag_cite git -> path@sha#L locator', /@[0-9a-f]{7,}#L\d+-L\d+$/.test(cite.citations[0].locator));
  store.close();

  // Edge: empty repo (no HEAD) aborts.
  const empty = mkdtempSync(join(tmpdir(), 'rag-git-empty-'));
  spawnSync('git', ['init', empty], { encoding: 'utf8' });
  let e1 = false; try { ingestGit(empty, {}); } catch (e) { e1 = /empty repo/.test(e.message); }
  check('empty repo (no commits) aborts with an empty-repo error', e1);

  // Edge: non-git local path aborts.
  const plain = mkdtempSync(join(tmpdir(), 'rag-git-plain-'));
  let e2 = false; try { ingestGit(plain, {}); } catch (e) { e2 = /not a git repository/.test(e.message); }
  check('non-git local path aborts', e2);

  // Edge: clone failure (offline, bogus file:// URL) aborts with git's stderr.
  let e3 = false; try { ingestGit('file:///no/such/rag/repo.git', {}); } catch (e) { e3 = /clone failed/.test(e.message); }
  check('clone failure (offline file:// URL) aborts', e3);

  rmSync(repo, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('web ingester — extraction, same-origin BFS, robots, caps, redirects');
{
  const readFx = (n) => readFileSync(join(FX, 'site', n), 'utf8');
  const siteRoutes = {
    'http://site.test/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private\n' },
    'http://site.test/': { headers: HTML, body: readFx('index.html') },
    'http://site.test/page-a.html': { headers: HTML, body: readFx('page-a.html') },
    'http://site.test/page-b.html': { headers: HTML, body: readFx('page-b.html') },
    'http://site.test/broken.html': { status: 404, headers: HTML, body: '' },
    'http://site.test/data.json': { headers: JSONH, body: '{"x":1}' },
    'http://site.test/gone.html': { status: 302, headers: { location: 'http://other.test/y' }, body: '' },
  };

  // Extractor unit checks.
  const ext = htmlToText(readFx('index.html'));
  check('extractor drops <script>/<nav>/<style> chrome', !/this script text/.test(ext.text) && !/nav dupe/.test(ext.text) && !/color:red/.test(ext.text));
  check('extractor keeps heading structure (h1 -> #)', /# Overview/.test(ext.text));
  check('extractor renders <li> as "- "', /- Installation and setup/.test(ext.text));
  check('extractor harvests id attr as heading anchor', ext.headingAnchors.Overview === 'overview');
  const extA = htmlToText(readFx('page-a.html'));
  check('extractor renders <pre> as a fenced block', /```[\s\S]*survey --install[\s\S]*```/.test(extA.text));

  // robots longest-match unit.
  const rules = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a/ok\nUser-agent: bot\nDisallow: /\n');
  check('robots parse: non-* group ignored, longest-match Allow overrides Disallow',
    robotsAllows(rules, '/a/x') === false && robotsAllows(rules, '/a/ok/1') === true && robotsAllows(rules, '/b') === true);

  // Full crawl.
  const web = await ingestWeb('http://site.test/', { delay_ms: 0 }, { fetchImpl: fakeFetch(siteRoutes) });
  check('web BFS ingests exactly the 3 same-origin pages',
    web.docs.map((d) => d.doc_path).sort().join(',') === 'http://site.test/,http://site.test/page-a.html,http://site.test/page-b.html');
  check('off-origin link never enqueued (no other.test docs)', web.docs.every((d) => d.doc_path.startsWith('http://site.test')));
  check('robots Disallow /private blocks the secret page', web.skipLog.some((s) => s.reason === 'robots-disallow' && /private/.test(s.path)));
  check('non-200 link skipped as http-404', web.skipLog.some((s) => s.reason === 'http-404'));
  check('non-HTML link skipped as content-type', web.skipLog.some((s) => s.reason === 'content-type'));
  check('off-site redirect skipped as redirected-off-site', web.skipLog.some((s) => s.reason === 'redirected-off-site'));

  // Locator grammar via the store: URL#anchor (id attr, then heading-slug fallback).
  const store = new RagStore(':memory:');
  store.ingestDocs({ codename: 'sitefx', type: web.type, root: web.root, docs: web.docs, skipLog: web.skipLog, makeLocator: web.makeLocator });
  const chunks = store.activeChunks(['sitefx']);
  const inst = chunks.find((c) => c.heading === 'Installation');
  check('website locator is URL#anchor from the id attr', inst && inst.locator === 'http://site.test/page-a.html#installation');
  const yield_ = chunks.find((c) => c.heading === 'Yield Modifier');
  check('website locator falls back to heading slug when no id', yield_ && yield_.locator === 'http://site.test/page-b.html#yield-modifier');
  store.close();

  // Round-trip through the tool with injected fetch.
  const tstore = new RagStore(':memory:');
  const wcall = harness(tstore, { fetchImpl: fakeFetch(siteRoutes) });
  const wing = await wcall('rag_ingest', { source: 'http://site.test/', codename: 'siteweb', options: { delay_ms: 0 } });
  check('rag_ingest website (injected fetch) -> chunks + type website', wing.chunks >= 1 && wing.type === 'website');
  const wq = await wcall('rag_query', { query: 'yield modifier node richness installation survey', codenames: ['siteweb'] });
  check('website chunk round-trips to a url#anchor locator', wq.hits.length >= 1 && /^http:\/\/site\.test\/.*#/.test(wq.hits[0].locator));
  tstore.close();

  // Page cap and depth cap.
  const cap = await ingestWeb('http://site.test/', { delay_ms: 0, max_pages: 1 }, { fetchImpl: fakeFetch(siteRoutes) });
  check('max_pages cap stops the walk and records page-cap-hit', cap.docs.length === 1 && cap.skipLog.some((s) => s.reason === 'page-cap-hit'));
  const d0 = await ingestWeb('http://site.test/', { delay_ms: 0, max_depth: 0 }, { fetchImpl: fakeFetch(siteRoutes) });
  check('max_depth 0 crawls only the root page', d0.docs.length === 1 && d0.docs[0].doc_path === 'http://site.test/');

  // Abort: robots disallows the root.
  const blockAll = {
    'http://x.test/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /\n' },
    'http://x.test/': { headers: HTML, body: '<h1>x</h1><p>body</p>' },
  };
  let ra = false; try { await ingestWeb('http://x.test/', { delay_ms: 0 }, { fetchImpl: fakeFetch(blockAll) }); } catch (e) { ra = /disallows the crawl root/.test(e.message); }
  check('robots Disallow: / aborts the whole crawl', ra);

  // Abort: robots.txt 5xx is treated conservatively.
  const robots5xx = { 'http://y.test/robots.txt': { status: 503, headers: { 'content-type': 'text/plain' }, body: '' } };
  let r5 = false; try { await ingestWeb('http://y.test/', { delay_ms: 0 }, { fetchImpl: fakeFetch(robots5xx) }); } catch (e) { r5 = /refusing to crawl/.test(e.message); }
  check('robots.txt 5xx aborts conservatively', r5);
}

// ---------------------------------------------------------------------------
section('wiki ingester — API detection, wikitext, namespace filter, fallback');
{
  const apiBase = 'http://wiki.test/api.php';
  const siteinfo = JSON.stringify({ query: { general: { sitename: 'FX Wiki' } } });
  const allpages0 = JSON.stringify({ query: { allpages: [{ title: 'Crafting' }, { title: 'Gathering' }] } });
  const crafting = '== Overview ==\nCrafting turns {{tl|ore}} and refined materials into finished goods, and the crafting system reads the resource quality of every input and carries that quality forward into the output item so a crafter who sources better inputs ships strictly better products to the market downstream every time. The overview section is written long enough that it comfortably exceeds the chunker minimum on its own and therefore stays a chunk of its own rather than being merged away, which keeps its heading attached for the section locator that the test asserts against below.\n\n== Resource quality ==\nHigher [[quality]] raises the premium a crafter pays for [[ore|refined ore]], because the quality of the inputs propagates directly into the crafted result and the market rewards the higher tier, which is precisely what closes the gatherer to crafter interdependence loop that the whole player economy is deliberately built around here. This resource quality section is likewise padded past the minimum chunk size so it survives as its own heading-bearing chunk and the Page section locator grammar can be verified end to end without any runt merging interfering.\n';
  const gathering = "== Yield ==\nThe '''yield modifier''' stacks with node richness so a richer node returns proportionally more ore per harvest action, and this compounding is the core of the reward curve the entire gathering session is tuned around for a satisfying and repeatable extraction loop for every player.\n";
  const wikiRoutes = {
    [`${apiBase}?action=query&meta=siteinfo&format=json`]: { headers: JSONH, body: siteinfo },
    [`${apiBase}?action=query&list=allpages&apnamespace=0&aplimit=200&format=json`]: { headers: JSONH, body: allpages0 },
    [`${apiBase}?action=parse&page=Crafting&prop=wikitext&format=json`]: { headers: JSONH, body: JSON.stringify({ parse: { wikitext: { '*': crafting } } }) },
    [`${apiBase}?action=parse&page=Gathering&prop=wikitext&format=json`]: { headers: JSONH, body: JSON.stringify({ parse: { wikitext: { '*': gathering } } }) },
  };

  // wikitext converter unit.
  const wtxt = wikitextToText(crafting);
  check('wikitext: == X == -> ## X, {{templates}} dropped, [[a|b]] -> b',
    /## Overview/.test(wtxt) && !/\{\{/.test(wtxt) && /refined ore/.test(wtxt) && !/\[\[/.test(wtxt));

  // API mode chosen when api.php answers with siteinfo.
  const calls = [];
  const wk = await ingestWiki('http://wiki.test', { namespaces: [0] }, { fetchImpl: fakeFetch(wikiRoutes, calls) });
  check('wiki api.php probe selects API mode (type wiki)', wk.type === 'wiki');
  check('wiki API ingests allpages titles as docs', wk.docs.map((d) => d.doc_path).sort().join(',') === 'Crafting,Gathering');
  check('namespace filter only enumerates requested ns (apnamespace=0, never =1)',
    calls.some((u) => /apnamespace=0/.test(u)) && !calls.some((u) => /apnamespace=1/.test(u)));

  const store = new RagStore(':memory:');
  store.ingestDocs({ codename: 'wikifx', type: wk.type, root: wk.root, docs: wk.docs, skipLog: wk.skipLog, makeLocator: wk.makeLocator });
  const sec = store.activeChunks(['wikifx']).find((c) => c.heading === 'Resource quality');
  check('wiki locator is Page§Section', sec && sec.locator === 'Crafting§Resource quality');
  store.close();

  // Fallback: no api.php -> the website crawler carries it.
  const fbRoutes = {
    'http://plainwiki.test/robots.txt': { headers: { 'content-type': 'text/plain' }, body: '' },
    'http://plainwiki.test/': { headers: HTML, body: '<h1 id="home">Home</h1><p>A plain non-MediaWiki page with more than enough body text to comfortably survive the fifty character minimum extraction guard applied by the crawler.</p>' },
  };
  const fb = await ingestWiki('http://plainwiki.test', { delay_ms: 0 }, { fetchImpl: fakeFetch(fbRoutes) });
  check('wiki with no api.php falls back to the website crawler (type website)', fb.type === 'website' && fb.docs.length >= 1);
}

// ---------------------------------------------------------------------------
// OPTIONAL live-web smoke: OFF by default, guarded on RAG_LIVE_WEB. Never runs in CI.
if (process.env.RAG_LIVE_WEB) {
  section('web ingester — LIVE smoke (RAG_LIVE_WEB set)');
  const live = await ingestWeb(process.env.RAG_LIVE_WEB, { max_pages: 2, delay_ms: 500 });
  check('live crawl returned at least one doc', live.docs.length >= 1);
}

console.log(`\nRAG tests OK — ${pass} checks passed`);
