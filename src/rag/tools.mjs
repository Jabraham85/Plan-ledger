// tools.mjs — the six RAG MCP tools (§5). registerRagTools(server, ragStore) is
// the ONLY file src/server.mjs touches (+2 lines: import + call).
//
// Every result carries a `directive` string suggesting the recursive next move,
// mirroring the ledger's next_step/record_attempt directive pattern.
//
// STEP-511 SCOPE: rag_ingest handles source types 'file' and 'folder' only. The
// git/website/wiki ingesters land in step 512 and return an explicit not-yet error.

import { z } from 'zod';
import { statSync } from 'node:fs';
import { tokenize } from '../db.mjs';
import { ingestFs } from './ingest/fs.mjs';
import { slug } from './store.mjs';
import { makeRanker } from './rank.mjs';
import { makeIdf, expandRun, EXPAND_DEFAULTS } from './expand.mjs';

// Same ok/try-catch envelope as server.mjs's tool() helper, bound to the passed server.
function makeTool(server) {
  const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
  return (name, cfg, fn) =>
    server.registerTool(name, cfg, (args) => {
      try { return ok(fn(args ?? {})); }
      catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
    });
}

// Auto-detect the source type from a locator. Only file/folder are handled this step.
function detectType(source, explicit) {
  if (explicit) return explicit;
  if (/\.git$/i.test(source)) return 'git';                       // git URL or local *.git
  if (/^https?:\/\//i.test(source)) return /\/api\.php/i.test(source) ? 'wiki' : 'website';
  try {
    const st = statSync(source);
    return st.isDirectory() ? 'folder' : 'file';
  } catch {
    throw new Error(`source not found and not a URL: ${source}`);
  }
}

export function registerRagTools(server, store) {
  const tool = makeTool(server);

  tool('rag_ingest', {
    title: 'Ingest a source into codename-N chunks',
    description:
      'Scrub a source into deterministic codename-N chunks with exact back-pointing locators. ' +
      'Type auto-detected from `source` (existing file → file; existing dir → folder). ' +
      'STEP 511: only file/folder are supported; git/website/wiki arrive in step 512. ' +
      'Re-ingesting the same codename supersedes the old version but keeps its chunks resolvable for one generation.',
    inputSchema: {
      source: z.string().describe('path or URL'),
      codename: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
      type: z.enum(['file', 'folder', 'git', 'website', 'wiki']).optional(),
      options: z.object({
        max_file_kb: z.number().int().optional(),
        max_files: z.number().int().optional(),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
        max_depth: z.number().int().optional(),
        max_pages: z.number().int().optional(),
        delay_ms: z.number().int().optional(),
        namespaces: z.array(z.number().int()).optional(),
        include_log: z.boolean().optional(),
      }).optional(),
    },
  }, ({ source, codename, type, options = {} }) => {
    const t = detectType(source, type);
    if (t === 'git' || t === 'website' || t === 'wiki') {
      throw new Error(`source type '${t}' is not yet implemented — step 512 (file and folder are supported now)`);
    }
    const res = ingestFs(source, options);
    const code = codename || slug(res.root.split(/[\\/]/).filter(Boolean).pop() || 'source');
    if (!code) throw new Error('could not derive a codename from the source; pass an explicit codename');
    const summary = store.ingestDocs({ codename: code, type: res.type, root: res.root, options, docs: res.docs, skipLog: res.skipLog });
    return {
      ...summary,
      directive: `Ingested ${summary.chunks} chunks as '${code}' (v${summary.version}). ` +
        `Query it: rag_query {query:"<2-5 terms>", codenames:["${code}"]}. Cite chunk ids in your output.`,
    };
  });

  tool('rag_status', {
    title: 'RAG sources status (the ingest-or-query decision)',
    description:
      'List indexed sources (version, status, type, root, chunk/token counts, ingest time). ' +
      'No codename → all sources. Present with a plausible ingested_at → query it; missing → rag_ingest it.',
    inputSchema: { codename: z.string().optional() },
  }, ({ codename }) => {
    const rows = store.status(codename);
    return {
      sources: rows,
      directive: rows.length
        ? `${rows.length} source row(s). Query with rag_query {query, codenames:[…]}; re-ingest if a source changed.`
        : (codename ? `No source '${codename}'. rag_ingest {source:"<path>", codename:"${codename}"} first.` : 'Nothing indexed yet. rag_ingest a source to begin.'),
    };
  });

  tool('rag_query', {
    title: 'Query the RAG index (slim hits + auto-expanded runs)',
    description:
      'THE entry point. Returns slim cited hits (chunk id + score + locator + heading + snippet) and, by default, ' +
      'the neighbor-expanded full-text run around each hit (context grows to prev/next chunks until a neighbor is ' +
      'no longer relevant). Use 2–5 informative terms, not sentences (stopwords are dropped). On token-budget ' +
      'overflow the response is truncated with an explicit rag_expand pointer to keep walking.',
    inputSchema: {
      query: z.string(),
      codenames: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(20).optional(),
      expand: z.boolean().optional(),
      threshold: z.number().min(0).max(1).optional(),
      max_hops: z.number().int().min(0).max(10).optional(),
      token_budget: z.number().int().min(1).optional(),
    },
  }, ({ query, codenames, limit = 5, expand = true, threshold = EXPAND_DEFAULTS.threshold, max_hops = EXPAND_DEFAULTS.max_hops, token_budget = EXPAND_DEFAULTS.token_budget }) => {
    const terms = tokenize(query);
    const ranker = makeRanker(store);
    const ranked = ranker.rank(terms, { codenames, limit });

    // Slim hits: resolve each chunk for its exact locator + heading.
    const hits = ranked.map((h) => {
      const r = store.resolveChunk(h.chunkId);
      return {
        chunk: h.chunkId, score: Number(h.score.toFixed(4)),
        locator: r ? r.row.locator : '', heading: r ? r.row.heading : '',
        snippet: h.snippet,
      };
    });

    const out = { query, terms, ranker: ranker.name, hits };
    if (!expand || hits.length === 0) {
      out.expanded = [];
      out.directive = hits.length
        ? 'Slim hits above (expansion off). rag_expand {chunk:"<id>"} to grow context; rag_cite to translate ids to locators.'
        : 'No hits. Broaden terms or check rag_status — the source may need ingesting or a different codename.';
      return out;
    }

    // Expansion: one IDF corpus over the queried codenames, then walk each hit.
    const corpus = store.activeChunks(codenames);
    const idf = makeIdf(corpus);
    const sourceCache = new Map();
    const merged = new Map(); // codename -> { seqs:Map<seq,chunkRow>, sourceId }
    const covered = new Set();
    let runningTokens = 0, truncated = false, next = null;

    for (const h of ranked) {
      const resolved = store.resolveChunk(h.chunkId);
      if (!resolved) continue;
      const src = resolved.source;
      if (runningTokens >= token_budget) { truncated = true; next = `rag_expand {chunk:'${h.chunkId}', direction:'both'}`; break; }
      if (!sourceCache.has(src.id)) sourceCache.set(src.id, store.chunksForSource(src.id));
      const sourceChunks = sourceCache.get(src.id);
      const run = expandRun(resolved.row, sourceChunks, terms, idf, { threshold, max_hops, token_budget: token_budget - runningTokens });
      if (run.budgetHit) { truncated = true; next = `rag_expand {chunk:'${run.last}', direction:'next'}`; }
      const entry = merged.get(h.codename) || { seqs: new Map(), sourceId: src.id };
      for (const c of sourceChunks) {
        if (!run.seqs.includes(c.seq)) continue;
        const key = `${h.codename}#${c.seq}`;
        if (covered.has(key)) continue;
        covered.add(key);
        entry.seqs.set(c.seq, c);
        runningTokens += c.tokens_est;
      }
      merged.set(h.codename, entry);
    }

    // Merged runs (overlapping expansions in a codename collapse into one cited range).
    out.expanded = [...merged.entries()].map(([code, e]) => {
      const chunks = [...e.seqs.values()].sort((a, b) => a.seq - b.seq);
      const first = chunks[0], last = chunks[chunks.length - 1];
      return {
        chunks: `${code}-${first.seq}..${code}-${last.seq}`,
        first: `${code}-${first.seq}`, last: `${code}-${last.seq}`,
        seqs: chunks.map((c) => c.seq),
        text: chunks.map((c) => c.text).join('\n\n'),
        locators: chunks.map((c) => c.locator),
      };
    });
    if (truncated) { out.truncated = true; out.next = next; }
    out.directive = `Cited context above. If insufficient: ${next || `rag_expand {chunk:'${hits[0].chunk}', direction:'next'}`} ` +
      'to keep walking, or re-query with narrower terms. Cite chunk ids in your output.';
    return out;
  });

  tool('rag_expand', {
    title: 'Manually walk a chunk\'s neighbors (agent-driven recursion)',
    description:
      'Given a chunk id (e.g. frontier-docs-12 or frontier-docs@v2-12), return its neighbors in the requested ' +
      'direction so you can grow context on demand. This is the recursion step the rag_query `next` pointer names.',
    inputSchema: {
      chunk: z.string().describe('e.g. frontier-docs-12 or frontier-docs@v2-12'),
      direction: z.enum(['prev', 'next', 'both']).optional(),
      count: z.number().int().min(1).max(5).optional(),
    },
  }, ({ chunk, direction = 'both', count = 1 }) => {
    const resolved = store.resolveChunk(chunk);
    if (!resolved) throw new Error(`chunk '${chunk}' not found (wrong codename/seq, or the source needs ingesting)`);
    const src = resolved.source;
    const sourceChunks = store.chunksForSource(src.id);
    const bySeq = new Map(sourceChunks.map((c) => [c.seq, c]));
    const center = resolved.row.seq;
    const wanted = [];
    if (direction === 'prev' || direction === 'both') for (let i = 1; i <= count; i++) wanted.push(center - i);
    if (direction === 'next' || direction === 'both') for (let i = 1; i <= count; i++) wanted.push(center + i);
    wanted.push(center);
    const chunks = [...new Set(wanted)].sort((a, b) => a - b)
      .map((seq) => bySeq.get(seq)).filter(Boolean)
      .map((c) => ({ chunk: `${c.codename}-${c.seq}`, text: c.text, locator: c.locator, heading: c.heading }));
    const first = chunks[0].chunk, last = chunks[chunks.length - 1].chunk;
    return {
      center: `${resolved.source.codename}-${center}`,
      chunks,
      directive: `Neighbors above. Keep walking: rag_expand {chunk:'${last}', direction:'next'} or rag_expand {chunk:'${first}', direction:'prev'}. rag_cite to translate ids.`,
    };
  });

  tool('rag_cite', {
    title: 'Translate chunk ids to exact source citations',
    description:
      'Turn chunk ids into exact back-pointers (path#Lstart-Lend for files/folders). Run before final output so ' +
      'every claim carries a verifiable locator. superseded:true → re-query the active version before shipping.',
    inputSchema: { chunks: z.array(z.string()).min(1) },
  }, ({ chunks }) => {
    const citations = store.cite(chunks);
    const superseded = citations.filter((c) => c.superseded).map((c) => c.chunk);
    return {
      citations,
      directive: superseded.length
        ? `Superseded chunk(s): ${superseded.join(', ')}. Re-run rag_query against the active version before shipping those claims.`
        : 'Locators above. Paste them beside each claim in your output.',
    };
  });

  tool('rag_forget', {
    title: 'Remove a source (or just its superseded generations)',
    description:
      'Delete a codename entirely (default), or only its superseded generations (prune_superseded:true). ' +
      'A plain DELETE — the RAG index is disposable; re-ingest rebuilds it.',
    inputSchema: { codename: z.string(), prune_superseded: z.boolean().optional() },
  }, ({ codename, prune_superseded = false }) => {
    const res = store.forget(codename, prune_superseded);
    return {
      ...res,
      directive: res.removed_versions.length
        ? `Removed ${res.removed_chunks} chunk(s) across version(s) ${res.removed_versions.join(', ')}.`
        : `Nothing to remove for '${codename}'.`,
    };
  });
}
