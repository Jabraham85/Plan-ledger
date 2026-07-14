// expand.mjs — THE expansion rule (§4), pure functions over RagStore reads.
//
// "Every time there's a hit the context expands both to the previous chunk and the
//  next chunk until the chunk no longer contains relevant information."
//
// Formulation: relevance-ratio threshold with an IDF-weighted term-presence score.
//   rel(C,Q) = Σ over unique query terms present in tokenize(C.text) of idf(t)
//              idf(t) = ln(1 + N/df(t)), N = chunk count in the queried codenames
//   (identical machinery to getLessons, src/db.mjs — deterministic, ranker-independent)
// Walk contiguous neighbors (prev then next) while rel(neighbor) >= threshold*base,
// stopping at the FIRST neighbor that fails (no skip-ahead — contiguity is the point).

import { tokenize } from '../db.mjs';

export const EXPAND_DEFAULTS = Object.freeze({ threshold: 0.35, max_hops: 3, token_budget: 2000 });

// Build an IDF function over a candidate corpus (all active chunks in the codenames).
export function makeIdf(corpusChunks) {
  const N = corpusChunks.length || 1;
  const df = new Map();
  for (const c of corpusChunks) for (const t of new Set(tokenize(c.text))) df.set(t, (df.get(t) || 0) + 1);
  return (t) => Math.log(1 + N / (df.get(t) || 1));
}

// rel(text, qterms, idf): sum of idf over UNIQUE query terms present in the text.
export function rel(text, qterms, idf) {
  const present = new Set(tokenize(text));
  let s = 0;
  for (const t of new Set(qterms)) if (present.has(t)) s += idf(t);
  return s;
}

/**
 * expandRun(hit, sourceChunks, qterms, idf, opts) -> {
 *   seqs, chunkIds, first, last, text, locators, tokens
 * }
 * hit: a chunk row from the SAME source (has .seq, .text, .tokens_est, .codename).
 * sourceChunks: ordered chunk rows for hit's source (neighbor lookup by seq).
 * budgetLeft: caps the walk's running token total (§4 payload discipline).
 */
export function expandRun(hit, sourceChunks, qterms, idf, opts = {}) {
  const threshold = opts.threshold ?? EXPAND_DEFAULTS.threshold;
  const maxHops = opts.max_hops ?? EXPAND_DEFAULTS.max_hops;
  const budget = opts.token_budget ?? EXPAND_DEFAULTS.token_budget;

  const bySeq = new Map(sourceChunks.map((c) => [c.seq, c]));
  const base = rel(hit.text, qterms, idf);
  const accepted = new Map([[hit.seq, hit]]);
  let tokens = hit.tokens_est;
  let budgetHit = false;

  if (base > 0) {
    for (const dir of [-1, +1]) {
      let seq = hit.seq, hops = 0;
      while (hops < maxHops) {
        seq += dir; hops += 1;
        const n = bySeq.get(seq);
        if (!n) break;                                    // no neighbor in this source/version
        if (rel(n.text, qterms, idf) < threshold * base) break; // "no longer relevant" -> stop
        if (tokens + n.tokens_est > budget) { budgetHit = true; break; } // token budget guard
        accepted.set(n.seq, n);
        tokens += n.tokens_est;
      }
    }
  }

  const run = [...accepted.values()].sort((a, b) => a.seq - b.seq);
  const seqs = run.map((c) => c.seq);
  return {
    seqs,
    chunkIds: run.map((c) => `${c.codename}-${c.seq}`),
    first: `${run[0].codename}-${run[0].seq}`,
    last: `${run[run.length - 1].codename}-${run[run.length - 1].seq}`,
    text: run.map((c) => c.text).join('\n\n'),
    locators: run.map((c) => c.locator),
    tokens,
    budgetHit,
  };
}
