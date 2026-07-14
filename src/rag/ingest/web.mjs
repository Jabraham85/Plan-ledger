// ingest/web.mjs — the website ingester (§6 website matrix) + the deterministic
// HTML→text extractor it shares with the wiki fallback.
//
// Same-origin BFS from the root. Zero deps: Node global fetch, no DOM, no headless
// browser (a documented SPA limitation — extraction sees only static HTML). robots.txt
// is honored, off-origin links are never enqueued, depth/page caps bound the walk, a
// politeness delay spaces requests, and only text/* content is read. Locator grammar:
//   <URL>#<nearest-anchor-or-heading-slug>   (§1).
//
// Determinism: given the same fetch responses, byte-identical docs out. Tests inject
// deps.fetchImpl to serve local fixtures — no live network in the suite.

import { slug } from '../store.mjs';

const UA = 'plan-ledger-rag/0.1';
const PAGE_TIMEOUT_MS = 15000;
const MAX_BYTES = 2 * 1024 * 1024;      // 2 MB per page
const MAX_REDIRECTS = 5;
const TEXTUAL = /^(text\/html|text\/plain|text\/markdown)\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalize a URL for the seen-set / dedup: strip fragment, lowercase host, drop a
// trailing slash on the path. Query is KEPT (it can select content).
export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch { return String(u ?? ''); }
}

// ---- robots.txt (longest-match rule for User-agent: *) ---------------------
export function parseRobots(text) {
  const rules = []; // { allow:boolean, path:string }
  let applies = false;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') applies = value === '*';
    else if (applies && (field === 'disallow' || field === 'allow')) {
      if (field === 'disallow' && value === '') continue; // "Disallow:" = allow all, no rule
      rules.push({ allow: field === 'allow', path: value });
    }
  }
  return rules;
}

// Longest matching rule wins; Allow beats Disallow at equal length (RFC 9309 spirit).
export function robotsAllows(rules, pathname) {
  let best = null;
  for (const r of rules) {
    if (r.path && pathname.startsWith(r.path)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  }
  return best ? best.allow : true;
}

// ---- HTML → markdown-ish text (deterministic, no DOM) ----------------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#34': '"' };
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, name) => (Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : (ENTITIES[name.toLowerCase()] ?? m)));
}
const stripTags = (s) => decodeEntities(String(s ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

const DROP_TAGS = ['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript', 'template'];

/**
 * htmlToText(html) -> { text, headingAnchors, links }
 *   text:           markdown-ish (headings as #, lists as "- ", <pre> as fences, tables as pipes)
 *   headingAnchors: { <heading text>: <anchor slug> } — id attr if present, else slug(text)
 *   links:          raw href strings found in <a> (for the BFS frontier)
 */
export function htmlToText(html) {
  let s = String(html ?? '');
  const links = [];
  for (const m of s.matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi)) {
    links.push(decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  // Isolate <body> when present so chrome outside it never leaks in.
  const bodyM = s.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyM) s = bodyM[1];
  // Drop entire boilerplate subtrees (repeat to catch simple nesting).
  for (const tag of DROP_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    let prev; do { prev = s; s = s.replace(re, ' '); } while (s !== prev);
    s = s.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
  }
  // <pre>…</pre> → fenced block (protect its inner newlines from collapse).
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => `\n\`\`\`\n${decodeEntities(inner.replace(/<[^>]+>/g, ''))}\n\`\`\`\n`);
  // Table rows → pipe lines.
  s = s.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = [...row.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => stripTags(c[2]));
    return cells.length ? `\n${cells.join(' | ')}\n` : '\n';
  });
  // Headings → #.. with an anchor slug harvested from id (else the heading text).
  const headingAnchors = {};
  s = s.replace(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, (_, lvl, attrs, inner) => {
    const idM = attrs.match(/\bid\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/i);
    const htext = stripTags(inner);
    const anchor = idM ? (idM[2] ?? idM[3] ?? idM[4]) : slug(htext);
    if (htext) headingAnchors[htext] = anchor;
    return `\n${'#'.repeat(Number(lvl))} ${htext}\n`;
  });
  // List items → "- ".
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${stripTags(inner)}\n`);
  // Block-level breaks → blank lines; <br> → newline.
  s = s.replace(/<br\b[^>]*\/?>/gi, '\n')
       .replace(/<\/(p|div|section|article|ul|ol|table|blockquote)>/gi, '\n\n')
       .replace(/<(p|div|section|article|ul|ol|blockquote)\b[^>]*>/gi, '\n');
  // Strip whatever tags remain, decode entities, collapse whitespace deterministically.
  s = decodeEntities(s.replace(/<[^>]+>/g, ' '));
  s = s.replace(/[ \t]+/g, ' ')
       .split('\n').map((l) => l.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, (m) => (m ? '' : m))).join('\n')
       .replace(/\n{3,}/g, '\n\n')
       .trim();
  return { text: s, headingAnchors, links };
}

// ---- fetch one page, following ≤ MAX_REDIRECTS manual same-origin hops ------
async function fetchPage(url, origin, fetchImpl) {
  let cur = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try { res = await fetchImpl(cur, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) }); }
    catch (e) { return { skip: /tim|abort/i.test(e.name || e.message || '') ? 'timeout' : `fetch-error: ${e.message}` }; }
    const status = res.status;
    if (status >= 300 && status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { skip: `http-${status}` };
      let next; try { next = new URL(loc, cur).toString(); } catch { return { skip: 'redirect-bad-location' }; }
      if (new URL(next).origin !== origin) return { skip: 'redirected-off-site' };
      cur = next; continue;
    }
    if (status !== 200) return { skip: `http-${status}` };
    const ctype = res.headers.get('content-type') || '';
    if (!TEXTUAL.test(ctype)) return { skip: 'content-type' };
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) return { skip: 'too-large' };
    const body = await res.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) return { skip: 'too-large' };
    return { finalUrl: cur, ctype, body };
  }
  return { skip: 'redirect-loop' };
}

/**
 * ingestWeb(root, options, deps) ->
 *   { type:'website', root, docs:[{doc_path,text,kind,headingAnchors}], skipLog, makeLocator }
 * Abort-source (throws): root not a URL, robots 5xx/timeout, robots disallows the root.
 */
export async function ingestWeb(root, options = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('global fetch unavailable (Node ≥ 22 required) and no fetchImpl injected');
  let rootUrl;
  try { rootUrl = new URL(root); } catch { throw new Error(`website root is not a valid URL: ${root}`); }
  const origin = rootUrl.origin;

  const maxDepth = options.max_depth ?? 3;
  const maxPages = options.max_pages ?? 50;
  const delayMs = options.delay_ms ?? 500;

  // robots.txt once per origin: 404 → allow all; 5xx/timeout → abort (conservative).
  let robotsRules = [];
  try {
    const rr = await fetchImpl(`${origin}/robots.txt`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    if (rr.status === 200) robotsRules = parseRobots(await rr.text());
    else if (rr.status >= 500) throw new Error(`robots.txt fetch failed (${rr.status}); refusing to crawl`);
    // 3xx/4xx (incl. 404) → treat as allow-all.
  } catch (e) {
    if (/refusing to crawl/.test(e.message)) throw e;
    // network/timeout fetching robots itself → conservative abort.
    throw new Error(`robots.txt unreachable (${e.message}); refusing to crawl ${origin}`);
  }
  if (!robotsAllows(robotsRules, rootUrl.pathname)) throw new Error(`robots.txt disallows the crawl root ${rootUrl.pathname}`);

  const start = normalizeUrl(rootUrl.toString());
  const queue = [{ url: start, depth: 0 }];
  const seen = new Set([start]);
  const contentHashes = new Set();
  const docs = [];
  const skipLog = [];
  let capHit = false;
  let first = true;

  while (queue.length) {
    if (docs.length >= maxPages) { capHit = true; break; }
    const { url, depth } = queue.shift();
    const pathname = new URL(url).pathname;
    if (!robotsAllows(robotsRules, pathname)) { skipLog.push({ path: url, reason: 'robots-disallow' }); continue; }
    if (!first && delayMs > 0) await sleep(delayMs); // politeness between requests
    first = false;

    const r = await fetchPage(url, origin, fetchImpl);
    if (r.skip) { skipLog.push({ path: url, reason: r.skip }); continue; }

    const { text, headingAnchors, links } = htmlToText(r.body);
    if (text.length < 50) { skipLog.push({ path: url, reason: 'empty-after-extraction' }); continue; }
    const h = hashText(text);
    if (contentHashes.has(h)) { skipLog.push({ path: url, reason: 'duplicate' }); continue; }
    contentHashes.add(h);
    docs.push({ doc_path: url, text, kind: 'markdown', headingAnchors });

    if (depth < maxDepth) {
      for (const href of links) {
        let abs; try { abs = new URL(href, url); } catch { continue; }
        if (abs.origin !== origin) continue;           // same-origin boundary
        if (!/^https?:$/.test(abs.protocol)) continue; // no mailto:/javascript:/etc.
        const norm = normalizeUrl(abs.toString());
        if (seen.has(norm)) continue;
        seen.add(norm);
        queue.push({ url: norm, depth: depth + 1 });
      }
    }
  }
  if (capHit) skipLog.push({ path: '', reason: 'page-cap-hit' });

  // Locator: URL#anchor. The chunk's heading maps back to the page's anchor slug.
  const anchorByDoc = new Map(docs.map((d) => [d.doc_path, d.headingAnchors || {}]));
  const makeLocator = (doc, c) => {
    if (!c.heading) return doc.doc_path;
    const anchor = anchorByDoc.get(doc.doc_path)?.[c.heading] || slug(c.heading);
    return anchor ? `${doc.doc_path}#${anchor}` : doc.doc_path;
  };
  return { type: 'website', root, docs, skipLog, makeLocator };
}

// Cheap deterministic content hash for mirror/alias dedup (not cryptographic).
function hashText(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
