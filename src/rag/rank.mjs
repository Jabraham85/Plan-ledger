// rank.mjs — one Ranker interface, two implementations (§3).
//   makeFtsRanker: FTS5 BM25, primary when the virtual table probe succeeded.
//   makeJsRanker:  pure-JS classic BM25 (k1=1.2, b=0.75), the mandatory fallback.
// Both tokenize identically to the ledger (shared tokenize from src/db.mjs) and
// return the SAME shape in the SAME deterministic total order:
//   [{ chunkId, codename, seq, score >= 0, snippet }]
//   sorted score DESC, then codename ASC, then seq ASC (no float tie decides alone).

import { tokenize } from '../db.mjs';

export { tokenize };

const K1 = 1.2, B = 0.75;
const SNIP_MAX = 200;

const chunkId = (c) => `${c.codename}-${c.seq}`;

// Deterministic total order: score desc, codename asc, seq asc.
const byRank = (a, b) => (b.score - a.score) || (a.codename < b.codename ? -1 : a.codename > b.codename ? 1 : 0) || (a.seq - b.seq);

// First line of a chunk containing any query term, else the first line; capped.
function jsSnippet(text, qterms) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const q = new Set(qterms);
  const hit = lines.find((l) => tokenize(l).some((t) => q.has(t))) || lines[0] || '';
  return hit.length > SNIP_MAX ? hit.slice(0, SNIP_MAX - 1) + '…' : hit;
}

// ---- FTS5 BM25 -------------------------------------------------------------

export function makeFtsRanker(store) {
  return {
    name: 'fts5',
    rank(queryTerms, { codenames, limit = 5 } = {}) {
      const terms = [...new Set(queryTerms.map((t) => tokenize(t)).flat())];
      if (terms.length === 0) return [];
      // Each term is tokenized then double-quoted: MATCH-syntax injection ("/NEAR/*/-)
      // is structurally impossible. Implicit AND is defeated with explicit OR (§3 gotcha a).
      const match = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
      const codeFilter = codenames && codenames.length ? `AND c.codename IN (${codenames.map(() => '?').join(',')})` : '';
      const sql = `
        SELECT c.codename AS codename, c.seq AS seq, c.text AS text,
               bm25(rag_fts) AS bm, snippet(rag_fts, 0, '', '', '…', 12) AS snip
        FROM rag_fts JOIN rag_chunks c ON c.id = rag_fts.rowid
        JOIN rag_sources s ON s.id = c.source_id AND s.status = 'active'
        WHERE rag_fts MATCH ? ${codeFilter}`;
      const rows = store.db.prepare(sql).all(match, ...(codenames && codenames.length ? codenames : []));
      return rows
        // bm25() is negative, lower = better; normalize to -bm25 so higher = better (§3 gotcha b).
        .map((r) => ({ chunkId: chunkId(r), codename: r.codename, seq: r.seq, score: -r.bm, snippet: (r.snip || '').slice(0, SNIP_MAX) }))
        .sort(byRank)
        .slice(0, limit);
    },
  };
}

// ---- pure-JS BM25 fallback -------------------------------------------------

export function makeJsRanker(store) {
  return {
    name: 'js',
    rank(queryTerms, { codenames, limit = 5 } = {}) {
      const qterms = [...new Set(queryTerms.map((t) => tokenize(t)).flat())];
      if (qterms.length === 0) return [];
      const chunks = store.activeChunks(codenames);
      if (chunks.length === 0) return [];
      const docs = chunks.map((c) => ({ c, toks: tokenize(c.text) }));
      const N = docs.length;
      const avgdl = docs.reduce((s, d) => s + d.toks.length, 0) / N || 1;
      const df = new Map();
      for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
      const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      const scored = [];
      for (const d of docs) {
        const dl = d.toks.length;
        const tf = new Map();
        for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1);
        let score = 0;
        for (const t of qterms) {
          const f = tf.get(t) || 0;
          if (!f) continue;
          score += idf(t) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * dl / avgdl));
        }
        if (score > 0) scored.push({ chunkId: chunkId(d.c), codename: d.c.codename, seq: d.c.seq, score, snippet: jsSnippet(d.c.text, qterms) });
      }
      return scored.sort(byRank).slice(0, limit);
    },
  };
}

// Selection: RAG_RANKER=js forces the fallback (also how the eval compares them);
// otherwise FTS5 when the open-time probe succeeded, else the JS fallback.
export function makeRanker(store) {
  if (String(process.env.RAG_RANKER || '').toLowerCase() === 'js') return makeJsRanker(store);
  return store.ftsAvailable ? makeFtsRanker(store) : makeJsRanker(store);
}
