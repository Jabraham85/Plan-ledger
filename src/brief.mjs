// brief.mjs — pick the brain's findings for a piece of work (pure; shared by the
// Store's step brief and the runner). One query over the whole task lets one topic
// crowd the brief; one query PER PART does not (bench/slices: same 5-line budget,
// 55% → 89% of the needed facts the brain held).

// Split a task's text into the separate things it asks about: lines, bullets,
// numbered items and sentences, each with at least 3 words.
export function splitParts(text) {
  return String(text ?? '')
    .split(/\n+|(?:^|\s)\(\d+\)\s|(?:^|\s)\d+[.)]\s|\s[-•*]\s|(?<=[.;?!])\s+(?=[A-Z(`"'])/)
    .map((s) => (s ?? '').replace(/^[-•*\s]+/, '').trim())
    .filter((s) => s.split(/\s+/).length >= 3);
}

// The best hit for EACH part, strongest parts first, deduplicated; topped up from a
// whole-text query if parts found fewer than `limit`.
// query(text, k) → findings with a numeric `score` (e.g. Store.queryFindings).
export function pickBrief(query, text, { limit = 5 } = {}) {
  const hits = [];
  for (const p of splitParts(text).slice(0, 40)) { const top = query(p, 1)[0]; if (top) hits.push(top); }
  hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const out = [], seen = new Set();
  for (const f of [...hits, ...query(text, limit)]) {
    if (seen.has(f.id)) continue;
    seen.add(f.id); out.push(f);
    if (out.length === limit) break;
  }
  return out;
}
