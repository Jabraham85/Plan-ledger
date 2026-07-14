// rag.mjs — unit + behavioral tests for the RAG core engine (plan #98, step 511).
// Temp/in-memory DBs ONLY — never data/plan-ledger.db or a real data/rag.db.
// Run: node test/rag.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { chunk, estTokens, CHUNK_DEFAULTS } from '../src/rag/chunker.mjs';
import { RagStore, parseChunkId } from '../src/rag/store.mjs';
import { ingestFs } from '../src/rag/ingest/fs.mjs';
import { registerRagTools } from '../src/rag/tools.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FX = join(__dirname, 'fixtures', 'rag');
let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log('  ok  ' + label); pass++; };
const section = (s) => console.log('\n== ' + s + ' ==');

// A mock MCP server: capture the registered handlers so we can invoke them and
// parse the JSON payload exactly as a real client would receive it.
function harness(store) {
  const handlers = {};
  registerRagTools({ registerTool: (name, cfg, fn) => { handlers[name] = fn; } }, store);
  return (name, args) => {
    const res = handlers[name](args ?? {});
    const body = res.content[0].text;
    return res.isError ? { __error: body } : JSON.parse(body);
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

console.log(`\nRAG tests OK — ${pass} checks passed`);
