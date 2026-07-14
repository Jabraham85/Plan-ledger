// chunker.mjs — deterministic, boundary-aware chunker for the RAG sidecar (§2).
//
// Pure functions only: same (text, kind, opts) in => byte-identical blocks out.
// No IO, no randomness. `seq` assignment lives in the store (document order); this
// module turns ONE document's text into ordered chunks with line-range locators.
//
// Token estimate is deliberately crude and stated everywhere as an estimate:
//   estTokens(s) = ceil(s.length / 4). Good enough for budgeting, fully deterministic.

// Estimated-token bounds (tunable per-ingest via opts, recorded in rag_sources.options).
export const CHUNK_DEFAULTS = Object.freeze({ MIN: 100, TARGET: 400, MAX: 600 });

export const estTokens = (s) => Math.ceil(String(s ?? '').length / 4);

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;

// Split a document into atomic blocks, boundary-aware by kind. Each block carries
// its 1-based [startLine,endLine] and the nearest enclosing heading text.
//   markdown|text: fenced code blocks atomic; split at headings; then blank-line paragraphs.
//   code:          split at blank-line groups; brace-balanced runs are never split apart;
//                  a leading comment block attaches to the declaration that follows.
function toBlocks(text, kind) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let heading = '';

  const push = (from, to, isHeading = false, hd = heading) => {
    // from/to are 0-based inclusive indices into `lines`.
    const body = lines.slice(from, to + 1).join('\n');
    if (body.trim() === '') return; // never emit a whitespace-only block
    blocks.push({ text: body, heading: hd, startLine: from + 1, endLine: to + 1, isHeading });
  };

  if (kind === 'code') {
    // Blank-line groups, but keep brace-balanced runs together. A pending leading
    // comment block is not emitted alone — it rides with the next code block.
    let i = 0;
    let pendingComment = null; // {from}
    while (i < lines.length) {
      if (lines[i].trim() === '') { i++; continue; }
      const from = i;
      let depth = 0;
      // consume until a blank line at brace depth 0 (or EOF)
      while (i < lines.length) {
        const l = lines[i];
        for (const ch of l) { if (ch === '{') depth++; else if (ch === '}') depth = Math.max(0, depth - 1); }
        const next = lines[i + 1];
        if (depth === 0 && (next === undefined || next.trim() === '')) { break; }
        i++;
      }
      const to = i;
      i++; // skip the terminating blank line
      const slice = lines.slice(from, to + 1).join('\n');
      const isComment = /^\s*(\/\/|\/\*|\*|#)/.test(lines[from]) && !/[{};()]/.test(slice.replace(/\/\/.*$/gm, ''));
      if (isComment) {
        pendingComment = pendingComment ?? { from };
        continue; // hold it for the following declaration
      }
      push(pendingComment ? pendingComment.from : from, to, false);
      pendingComment = null;
    }
    if (pendingComment) push(pendingComment.from, lines.length - 1, false); // trailing comment stands alone
    return blocks;
  }

  // markdown | text (html is pre-converted to markdown-ish upstream, §6)
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    // fenced code block: atomic, from the opening fence through the closing fence
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1];
      const from = i;
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}`).test(lines[i])) i++;
      const to = Math.min(i, lines.length - 1);
      i = to + 1;
      push(from, to, false);
      continue;
    }

    // heading: its own block, and it updates the enclosing heading for what follows
    const h = line.match(HEADING_RE);
    if (h) {
      heading = h[2].trim();
      push(i, i, true, heading);
      i++;
      continue;
    }

    // paragraph: consecutive non-blank, non-heading, non-fence lines
    const from = i;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !HEADING_RE.test(lines[i]) &&
      !FENCE_RE.test(lines[i])
    ) i++;
    push(from, i - 1, false);
  }
  return blocks;
}

// Hard-split an oversized block (> MAX est. tokens) at line boundaries into
// pieces each <= MAX. Never splits mid-line. Line ranges are preserved exactly.
function splitOversized(block, MAX) {
  const lines = block.text.split('\n');
  const pieces = [];
  let acc = [];
  let accStart = block.startLine;
  const flush = (endLine) => {
    if (acc.length === 0) return;
    pieces.push({ text: acc.join('\n'), heading: block.heading, startLine: accStart, endLine, isHeading: false });
    acc = [];
  };
  for (let k = 0; k < lines.length; k++) {
    const lineNo = block.startLine + k;
    const candidate = acc.length ? acc.join('\n') + '\n' + lines[k] : lines[k];
    if (acc.length && estTokens(candidate) > MAX) {
      flush(lineNo - 1);
      accStart = lineNo;
    }
    acc.push(lines[k]);
  }
  flush(block.startLine + lines.length - 1);
  return pieces;
}

/**
 * chunk(text, kind, opts) -> [{ text, heading, startLine, endLine, tokens }]
 * Deterministic. `kind` ∈ 'markdown' | 'text' | 'code' | 'html' (html handled as markdown).
 */
export function chunk(text, kind = 'text', opts = {}) {
  const MIN = opts.MIN ?? CHUNK_DEFAULTS.MIN;
  const TARGET = opts.TARGET ?? CHUNK_DEFAULTS.TARGET;
  const MAX = opts.MAX ?? CHUNK_DEFAULTS.MAX;
  const k = kind === 'html' ? 'markdown' : kind;

  const rawBlocks = toBlocks(text, k);

  // Expand any oversized single block into MAX-sized line-boundary pieces up front.
  const blocks = [];
  for (const b of rawBlocks) {
    if (estTokens(b.text) > MAX) blocks.push(...splitOversized(b, MAX));
    else blocks.push(b);
  }

  // Greedy pack: accumulate consecutive blocks while est(acc)+est(next) <= TARGET.
  // A heading block ALWAYS starts a new chunk (headings are the retrieval anchors).
  const chunks = [];
  let cur = null;
  const emit = () => { if (cur) { chunks.push(cur); cur = null; } };
  const start = (b) => { cur = { blocks: [b], heading: b.heading, startLine: b.startLine, endLine: b.endLine }; };
  const grow = (b) => { cur.blocks.push(b); cur.endLine = b.endLine; };

  for (const b of blocks) {
    if (!cur) { start(b); continue; }
    if (b.isHeading) { emit(); start(b); continue; }
    const combined = cur.blocks.map((x) => x.text).join('\n\n') + '\n\n' + b.text;
    if (estTokens(combined) <= TARGET) grow(b);
    else { emit(); start(b); }
  }
  emit();

  // Materialize text + tokens.
  let out = chunks.map((c) => {
    const body = c.blocks.map((x) => x.text).join('\n\n');
    return { text: body, heading: c.heading, startLine: c.startLine, endLine: c.endLine, tokens: estTokens(body) };
  });

  // Runt merge: a final chunk < MIN merges into its predecessor unless the merge
  // would exceed MAX. Keeps trailing fragments from becoming their own citations.
  if (out.length >= 2) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.tokens < MIN) {
      const mergedText = prev.text + '\n\n' + last.text;
      if (estTokens(mergedText) <= MAX) {
        out[out.length - 2] = {
          text: mergedText, heading: prev.heading, startLine: prev.startLine,
          endLine: last.endLine, tokens: estTokens(mergedText),
        };
        out.pop();
      }
    }
  }

  return out;
}
