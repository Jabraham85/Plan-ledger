// eval-rag.mjs — the RAG proof gate (plan #98, step 513, design §9).
//
// PROVES retrieval quality and GATES any ranking change on numbers: it ingests a
// fixed, committed fixture corpus into a throwaway in-memory rag.db, runs a hand-
// marked golden set of ground-truth queries through THREE ranker variants
// (term-count baseline · JS BM25 · FTS5 BM25), computes hit@1/@3/@5 and expansion
// precision/recall against the gold spans, prints a comparison table, and exits
// non-zero if the shipped default ranker regresses below the committed floor or
// below the term-count baseline.
//
// Deterministic + offline: no live network (the website ingester takes an injected
// fetch that serves the committed site/ fixtures; the git ingester builds a temp
// repo with pinned content). Temp/in-memory rag DBs ONLY — never data/rag.db.
//
// Run:  npm run eval:rag        (or: node scripts/eval-rag.mjs)
//       RAG_EVAL_DUMP=1 node scripts/eval-rag.mjs   → print every chunk id (gold authoring)
//       RAG_EVAL_JSON=1 node scripts/eval-rag.mjs   → machine-readable metrics on stdout

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { tokenize } from '../src/db.mjs';
import { RagStore } from '../src/rag/store.mjs';
import { ingestFs } from '../src/rag/ingest/fs.mjs';
import { ingestGit } from '../src/rag/ingest/git.mjs';
import { ingestWeb } from '../src/rag/ingest/web.mjs';
import { makeJsRanker, makeFtsRanker } from '../src/rag/rank.mjs';
import { makeIdf, expandRun, EXPAND_DEFAULTS } from '../src/rag/expand.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FX = join(__dirname, '..', 'test', 'fixtures', 'rag');
const EVAL = join(FX, 'eval-corpus');

// The committed pass floor for the SHIPPED default ranker. hit@3 below this — or
// below the term-count baseline — fails the gate (exit 1). See design §9 ship rule.
const HIT3_FLOOR = 0.60;

// ---------------------------------------------------------------------------
// Term-count BASELINE ranker (the floor the gate measures against).
//
// Deliberately the SAME tokenizer and the SAME deterministic total order as the
// two BM25 rankers, so the ONLY difference is the scoring math: a plain sum of
// query-term occurrences, with NO IDF weighting and NO length normalization. That
// isolates exactly what BM25 buys over naive counting (rare-term discrimination +
// long-chunk deflation). Not a shipping ranker — it lives here as the reference.
function makeTermCountRanker(store) {
  const byRank = (a, b) =>
    (b.score - a.score) ||
    (a.codename < b.codename ? -1 : a.codename > b.codename ? 1 : 0) ||
    (a.seq - b.seq);
  return {
    name: 'term-count',
    rank(queryTerms, { codenames, limit = 5 } = {}) {
      const q = [...new Set(queryTerms.map((t) => tokenize(t)).flat())];
      if (q.length === 0) return [];
      const qset = new Set(q);
      const chunks = store.activeChunks(codenames);
      const scored = [];
      for (const c of chunks) {
        let score = 0;
        for (const t of tokenize(c.text)) if (qset.has(t)) score += 1;
        if (score > 0) scored.push({ chunkId: `${c.codename}-${c.seq}`, codename: c.codename, seq: c.seq, score });
      }
      return scored.sort(byRank).slice(0, limit);
    },
  };
}

// ---------------------------------------------------------------------------
// Offline fetch double for the website ingester: serves the committed site/
// fixtures from disk against a fixed route table. No live network ever.
function makeRes(status, headers, body) {
  const h = new Map(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    headers: { get: (n) => (h.has(String(n).toLowerCase()) ? h.get(String(n).toLowerCase()) : null) },
    text: async () => body ?? '',
    json: async () => JSON.parse(body),
  };
}
function fakeFetch(routes) {
  return async (url) => {
    const r = routes[String(url)];
    if (!r) return makeRes(404, { 'content-type': 'text/html' }, 'not found');
    return makeRes(r.status ?? 200, r.headers ?? { 'content-type': 'text/html; charset=utf-8' }, r.body ?? '');
  };
}

// ---------------------------------------------------------------------------
// Build the fixed git fixture repo in a temp dir: pinned content, two commits,
// deterministic author + dates. Exercises the git ingester fully offline. Caller
// removes the returned dir. (sha varies run to run; gold anchors are content-based
// so citations still resolve — nothing in the eval depends on a fixed sha.)
function buildTempRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'rag-eval-repo-'));
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const gc = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=eval@test', '-c', 'user.name=eval', ...a], { encoding: 'utf8', env });
  spawnSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8', env });

  const write = (rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
  // Commit 1: the refinery, in a matching-but-distinct doc set so cross-source
  // retrieval has a second corpus of the same domain vocabulary to rank against.
  write('README.md', '# Refinery\n\nThe refinery pipeline converts raw ore into refined ingots that crafters buy. It sits between the gatherer and the crafter in the production chain and is the only place ore becomes a tradable ingot.\n');
  write('docs/pipeline.md', '# Pipeline Stages\n\nThe refinement pipeline runs three ordered stages: wash the raw ore to strip tailings, smelt the washed ore into a molten pour, and cast the pour into a standard ingot mold. Each stage preserves the resource quality of the input so a flawless ore yields a flawless ingot.\n');
  write('src/refine.mjs', '// refine.mjs — the refinery entry point.\n\n// refineOre washes, smelts and casts raw ore into a finished ingot, preserving\n// the input resource quality tier through every stage of the pipeline.\nexport function refineOre(ore) {\n  const washed = { ...ore, tailings: 0 };\n  const molten = { ...washed, state: "molten" };\n  return { ...molten, state: "ingot", quality: ore.quality };\n}\n');
  gc('add', '-A');
  gc('commit', '-m', 'initial refinery pipeline and refine entry point');

  // Commit 2: add the smelting stage detail and a changelog.
  write('src/smelt.mjs', '// smelt.mjs — the smelting stage.\n\n// smelt melts washed ore at the furnace temperature for its tier; a hotter burn\n// is required for higher-quality ore and wastes less of the pour as slag.\nexport function smelt(washedOre, furnaceTemp) {\n  const loss = furnaceTemp < 1200 ? 0.1 : 0.02;\n  return { ...washedOre, state: "molten", slag: loss };\n}\n');
  write('CHANGELOG.md', '# Changelog\n\n## Second commit\n\nAdded the dedicated smelting stage module and this changelog so the furnace temperature rule is documented separately from the pipeline overview.\n');
  gc('add', '-A');
  gc('commit', '-m', 'add smelting stage module and changelog');
  return repo;
}

// ---------------------------------------------------------------------------
// Ingest the whole fixture corpus (all four ingester paths) into one store.
// Returns { store, repoDir } — caller closes the store and removes repoDir.
async function ingestCorpus() {
  const store = new RagStore(':memory:');

  // eval-docs: 3 markdown design/guide docs (folder ingest).
  const d = ingestFs(join(EVAL, 'docs'));
  store.ingestDocs({ codename: 'eval-docs', type: d.type, root: d.root, docs: d.docs, skipLog: d.skipLog });

  // eval-src: 3 .mjs source files (folder ingest, code-kind chunker).
  const s = ingestFs(join(EVAL, 'src'));
  store.ingestDocs({ codename: 'eval-src', type: s.type, root: s.root, docs: s.docs, skipLog: s.skipLog });

  // eval-site: 3 static HTML pages through the REAL website extractor, offline.
  const readSite = (n) => readFileSync(join(FX, 'site', n), 'utf8');
  const HTML = { 'content-type': 'text/html; charset=utf-8' };
  const routes = {
    'http://frontier.test/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private\n' },
    'http://frontier.test/': { headers: HTML, body: readSite('index.html') },
    'http://frontier.test/page-a.html': { headers: HTML, body: readSite('page-a.html') },
    'http://frontier.test/page-b.html': { headers: HTML, body: readSite('page-b.html') },
  };
  const web = await ingestWeb('http://frontier.test/', { delay_ms: 0 }, { fetchImpl: fakeFetch(routes) });
  store.ingestDocs({ codename: 'eval-site', type: web.type, root: web.root, docs: web.docs, skipLog: web.skipLog, makeLocator: web.makeLocator });

  // eval-repo: a temp git repo (2 commits, tracked files + commit log), offline.
  const repoDir = buildTempRepo();
  const git = ingestGit(repoDir, { include_log: true });
  store.ingestDocs({ codename: 'eval-repo', type: git.type, root: git.root, docs: git.docs, skipLog: git.skipLog, makeLocator: git.makeLocator });

  return { store, repoDir };
}

// ---------------------------------------------------------------------------
// DUMP mode: print every chunk id + heading + preview so gold labels can be
// authored against real chunk boundaries. Not part of scoring.
async function dump() {
  const { store, repoDir } = await ingestCorpus();
  for (const c of store.activeChunks()) {
    const preview = c.text.replace(/\s+/g, ' ').slice(0, 95);
    console.log(`${c.codename}-${c.seq}  [${c.doc_path}] hd="${c.heading}" tok=${c.tokens_est}`);
    console.log(`      ${preview}`);
  }
  store.close();
  rmSync(repoDir, { recursive: true, force: true });
}

if (process.env.RAG_EVAL_DUMP) {
  await dump();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Anchor resolution: match a gold content anchor to EXACTLY ONE active chunk by
// whitespace-normalized, case-insensitive substring. A stale anchor (0 matches)
// or an ambiguous one (>1) fails the run loudly — the gold is never silently wrong.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function buildAnchorIndex(store) {
  const rows = store.activeChunks();
  const index = rows.map((c) => ({ id: `${c.codename}-${c.seq}`, codename: c.codename, seq: c.seq, ntext: norm(c.text) }));
  return (anchor) => {
    const a = norm(anchor);
    const hits = index.filter((r) => r.ntext.includes(a));
    assert.equal(hits.length, 1, `gold anchor must resolve to exactly ONE chunk, got ${hits.length}: "${anchor}"${hits.length ? ' -> ' + hits.map((h) => h.id).join(', ') : ''}`);
    return hits[0];
  };
}

// ---------------------------------------------------------------------------
// Metrics over one variant. Returns per-query rows + macro aggregates.
function scoreVariant(ranker, gold, resolve, store, idf) {
  let h1 = 0, h3 = 0, h5 = 0;
  let pSum = 0, rSum = 0, tokSum = 0;
  const rows = [];
  for (const g of gold) {
    const terms = tokenize(g.query);
    const relevant = new Set(g.relevant.map((a) => resolve(a).id));
    const ranked = ranker.rank(terms, { codenames: g.codenames || undefined, limit: 5 });
    const ids = ranked.map((r) => r.chunkId);
    const hitAt = (k) => ids.slice(0, k).some((id) => relevant.has(id));
    const hit1 = hitAt(1), hit3 = hitAt(3), hit5 = hitAt(5);
    if (hit1) h1++; if (hit3) h3++; if (hit5) h5++;

    // End-to-end expansion: seed from THIS variant's top hit, expand, compare to span.
    const span = { first: resolve(g.span.first), last: resolve(g.span.last) };
    assert.equal(span.first.codename, span.last.codename, `span endpoints must share a codename (${g.id})`);
    const spanIds = new Set();
    for (let s = span.first.seq; s <= span.last.seq; s++) spanIds.add(`${span.first.codename}-${s}`);

    let precision = 0, recall = 0, payload = 0, expandedIds = [];
    if (ranked.length) {
      const seed = store.resolveChunk(ranked[0].chunkId);
      if (seed) {
        const sourceChunks = store.chunksForSource(seed.source.id);
        const run = expandRun(seed.row, sourceChunks, terms, idf, EXPAND_DEFAULTS);
        expandedIds = run.chunkIds;
        payload = run.tokens;
        const inter = expandedIds.filter((id) => spanIds.has(id)).length;
        precision = expandedIds.length ? inter / expandedIds.length : 0;
        recall = spanIds.size ? inter / spanIds.size : 0;
      }
    }
    pSum += precision; rSum += recall; tokSum += payload;
    rows.push({ id: g.id, hit1, hit3, hit5, precision, recall, payload, top: ids[0] || '(none)', expandedIds });
  }
  const n = gold.length;
  return {
    name: ranker.name, n,
    hit1: h1 / n, hit3: h3 / n, hit5: h5 / n,
    precision: pSum / n, recall: rSum / n, payload: tokSum / n,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Ranker-isolated expansion: seed from the GOLD span.first (not any ranker), so
// this measures the expansion RULE alone. Used for the threshold/max_hops sweep.
function expansionRuleScore(gold, resolve, store, idf, opts) {
  let pSum = 0, rSum = 0, tokSum = 0;
  for (const g of gold) {
    const terms = tokenize(g.query);
    const span = { first: resolve(g.span.first), last: resolve(g.span.last) };
    const spanIds = new Set();
    for (let s = span.first.seq; s <= span.last.seq; s++) spanIds.add(`${span.first.codename}-${s}`);
    const seed = store.resolveChunk(span.first.id);
    const sourceChunks = store.chunksForSource(seed.source.id);
    const run = expandRun(seed.row, sourceChunks, terms, idf, opts);
    const inter = run.chunkIds.filter((id) => spanIds.has(id)).length;
    pSum += run.chunkIds.length ? inter / run.chunkIds.length : 0;
    rSum += spanIds.size ? inter / spanIds.size : 0;
    tokSum += run.tokens;
  }
  const n = gold.length;
  return { precision: pSum / n, recall: rSum / n, payload: tokSum / n };
}

// ---------------------------------------------------------------------------
const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%';
const f2 = (x) => x.toFixed(2);
const pad = (s, w) => String(s).padEnd(w);

async function main() {
  const gold = JSON.parse(readFileSync(join(FX, 'golden.json'), 'utf8')).queries;
  const { store, repoDir } = await ingestCorpus();
  try {
    const resolve = buildAnchorIndex(store);
    // Pre-resolve every anchor once so a stale gold fails before any scoring.
    for (const g of gold) { g.relevant.forEach(resolve); resolve(g.span.first); resolve(g.span.last); }

    const idf = makeIdf(store.activeChunks());
    const variants = [makeTermCountRanker(store), makeJsRanker(store)];
    if (store.ftsAvailable) variants.push(makeFtsRanker(store));
    const results = variants.map((v) => scoreVariant(v, gold, resolve, store, idf));

    const baseline = results.find((r) => r.name === 'term-count');
    const shipName = store.ftsAvailable ? 'fts5' : 'js';
    const shipped = results.find((r) => r.name === shipName);

    // ---- variant comparison table ----
    console.log('\nRAG retrieval eval — variant comparison');
    console.log(`corpus: ${store.activeChunks().length} chunks across eval-docs/eval-src/eval-site/eval-repo · golden queries: n=${gold.length} (indicative, not conclusive)`);
    console.log(`ranker availability: fts5=${store.ftsAvailable ? 'yes' : 'NO (fallback to js)'} · shipped default: ${shipName}\n`);
    console.log(`${pad('Variant', 14)}${pad('hit@1', 8)}${pad('hit@3', 8)}${pad('hit@5', 8)}${pad('exp.P', 8)}${pad('exp.R', 8)}${pad('avg tok', 8)}`);
    console.log('-'.repeat(62));
    for (const r of results) {
      const mark = r.name === shipName ? ' *' : '';
      console.log(`${pad(r.name + mark, 14)}${pad(pct(r.hit1), 8)}${pad(pct(r.hit3), 8)}${pad(pct(r.hit5), 8)}${pad(f2(r.precision), 8)}${pad(f2(r.recall), 8)}${pad(r.payload.toFixed(0), 8)}`);
    }
    console.log('\n* shipped default. exp.P/exp.R are END-TO-END (expansion seeded from each variant\'s own top hit).');

    // ---- per-query breakdown for the shipped ranker (surfaces misses honestly) ----
    console.log(`\nPer-query (shipped ranker = ${shipName}):`);
    console.log(`${pad('id', 5)}${pad('h@1', 5)}${pad('h@3', 5)}${pad('h@5', 5)}${pad('top hit', 16)}exp.P/R`);
    for (const row of shipped.rows) {
      const b = (x) => (x ? ' Y ' : ' . ');
      console.log(`${pad(row.id, 5)}${pad(b(row.hit1), 5)}${pad(b(row.hit3), 5)}${pad(b(row.hit5), 5)}${pad(row.top, 16)}${f2(row.precision)}/${f2(row.recall)}`);
    }

    // Queries where EVERY variant misses at hit@3 — a corpus/gold gap, flagged not hidden.
    const allMiss = gold.filter((g) => results.every((r) => !r.rows.find((x) => x.id === g.id).hit3));
    if (allMiss.length) {
      console.log('\nQueries missed by ALL variants at hit@3 (corpus/gold gap, not a ranker failure):');
      for (const g of allMiss) console.log(`  ${g.id}: "${g.query}"`);
    } else {
      console.log('\nNo query is missed by all variants at hit@3.');
    }

    // ---- expansion-rule threshold / max_hops sweep (ranker-independent) ----
    console.log('\nExpansion-rule sweep (seeded from gold span, ranker-independent):');
    console.log(`${pad('threshold', 11)}${pad('max_hops', 10)}${pad('exp.P', 8)}${pad('exp.R', 8)}${pad('avg tok', 8)}`);
    let best = null;
    for (const threshold of [0.25, 0.35, 0.5]) {
      for (const max_hops of [2, 3, 5]) {
        const s = expansionRuleScore(gold, resolve, store, idf, { threshold, max_hops, token_budget: EXPAND_DEFAULTS.token_budget });
        const f1 = (s.precision + s.recall) ? (2 * s.precision * s.recall) / (s.precision + s.recall) : 0;
        const isDefault = threshold === EXPAND_DEFAULTS.threshold && max_hops === EXPAND_DEFAULTS.max_hops;
        console.log(`${pad(threshold, 11)}${pad(max_hops, 10)}${pad(f2(s.precision), 8)}${pad(f2(s.recall), 8)}${pad(s.payload.toFixed(0), 8)}${isDefault ? '  <- current default' : ''}`);
        // Prefer higher F1, tie-break to fewer tokens then higher threshold (simpler/stricter).
        if (!best || f1 > best.f1 + 1e-9 || (Math.abs(f1 - best.f1) < 1e-9 && s.payload < best.payload)) {
          best = { threshold, max_hops, ...s, f1 };
        }
      }
    }
    // Recall is saturated at 1.00 across EVERY threshold on this fixture (the gold
    // spans are tight by construction), so the sweep can ONLY see precision — it is
    // structurally blind to the under-expansion (recall loss) that a higher threshold
    // would cause on a real corpus with fuzzier section boundaries. Raising the
    // shipped default to the fixture's precision-max would therefore be over-fitting
    // n=18. The honest recommendation: keep the current, more conservative default;
    // a higher threshold is only justified once a larger golden set shows recall
    // HEADROOM (recall < 1.0 at the current default) that a tighter walk preserves.
    const recallSaturated = Math.abs(expansionRuleScore(gold, resolve, store, idf, { ...EXPAND_DEFAULTS }).recall - 1) < 1e-9;
    console.log(`\nHighest-F1 point on THIS fixture: threshold=${best.threshold}, max_hops=${best.max_hops} (P=${f2(best.precision)} R=${f2(best.recall)}).`);
    if (recallSaturated) {
      console.log(`Recall is saturated (1.00) at every threshold, so the sweep sees only precision and cannot detect the`);
      console.log(`under-expansion risk a higher threshold adds on real corpora. RECOMMENDATION: keep the current defaults`);
      console.log(`(threshold=${EXPAND_DEFAULTS.threshold}, max_hops=${EXPAND_DEFAULTS.max_hops}); revisit only when a larger gold set shows recall headroom. No code change.`);
    } else if (best.threshold !== EXPAND_DEFAULTS.threshold || best.max_hops !== EXPAND_DEFAULTS.max_hops) {
      console.log(`Recall has headroom AND a different (threshold, max_hops) wins — consider updating EXPAND_DEFAULTS in src/rag/expand.mjs.`);
    } else {
      console.log(`The current defaults (threshold=${EXPAND_DEFAULTS.threshold}, max_hops=${EXPAND_DEFAULTS.max_hops}) are on the frontier — no change indicated.`);
    }

    // ---- ship gate ----
    console.log('\nShip gate (design §9 rule):');
    console.log(`  floor: shipped hit@3 >= ${pct(HIT3_FLOOR)} AND shipped hit@3 >= term-count baseline hit@3`);
    console.log(`  shipped (${shipName}) hit@3 = ${pct(shipped.hit3)} · baseline hit@3 = ${pct(baseline.hit3)}`);
    const betterEqBaseline = shipped.hit3 >= baseline.hit3 - 1e-9;
    const aboveFloor = shipped.hit3 >= HIT3_FLOOR - 1e-9;
    let verdict, code;
    if (aboveFloor && betterEqBaseline) { verdict = 'PASS — shipped ranker meets the floor and does not regress below baseline.'; code = 0; }
    else { verdict = `FAIL — ${!aboveFloor ? `below floor ${pct(HIT3_FLOOR)}` : ''}${!aboveFloor && !betterEqBaseline ? '; ' : ''}${!betterEqBaseline ? 'regressed below term-count baseline' : ''}.`; code = 1; }
    console.log(`  ${verdict}`);

    if (process.env.RAG_EVAL_JSON) {
      const out = { corpusChunks: store.activeChunks().length, n: gold.length, ftsAvailable: store.ftsAvailable, shipped: shipName, floor: HIT3_FLOOR,
        variants: results.map((r) => ({ name: r.name, hit1: r.hit1, hit3: r.hit3, hit5: r.hit5, precision: r.precision, recall: r.recall, payload: r.payload })),
        bestExpansion: best, gate: { verdict, code } };
      console.log('\n' + JSON.stringify(out));
    }

    return code;
  } finally {
    store.close();
    rmSync(repoDir, { recursive: true, force: true });
  }
}

const exitCode = await main();
process.exit(exitCode);
