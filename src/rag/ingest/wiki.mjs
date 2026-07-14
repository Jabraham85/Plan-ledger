// ingest/wiki.mjs — the wiki ingester (§6 wiki matrix).
//
// Probe for a MediaWiki API (<root>/api.php, then <root>/w/api.php). If one answers
// with siteinfo, use it (clean wikitext via action=parse) — far better than scraping
// rendered HTML. If neither answers, EVERY wiki is at least a website: fall back to the
// same-origin crawler in web.mjs. Locator grammar in API mode:
//   <Page Title>§<Section heading>   (§1).
//
// Zero deps, deterministic given fixed responses; tests inject deps.fetchImpl.

import { ingestWeb } from './web.mjs';

const UA = 'plan-ledger-rag/0.1';
const TIMEOUT_MS = 15000;

const getJson = async (fetchImpl, url) => {
  const res = await fetchImpl(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, headers: res.headers, retryAfter: res.headers?.get?.('retry-after'), json: res.status === 200 ? await res.json() : null };
};

// Probe api.php then w/api.php. Returns the working API base URL, or null (→ fallback).
export async function detectApi(root, fetchImpl) {
  const base = String(root).replace(/\/+$/, '');
  for (const cand of [`${base}/api.php`, `${base}/w/api.php`]) {
    try {
      const { json } = await getJson(fetchImpl, `${cand}?action=query&meta=siteinfo&format=json`);
      if (json && json.query && json.query.general) return cand;
    } catch { /* try next candidate */ }
  }
  return null;
}

// ---- wikitext → markdown-ish text (deterministic) --------------------------
// Headings (== X ==) → #.., templates {{…}} dropped, links [[a|b]]→b / [[a]]→a and
// [url label]→label, bold/italic markers stripped, refs/comments removed.
export function wikitextToText(wt) {
  let s = String(wt ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '').replace(/<ref\b[^>]*\/>/gi, '');
  let prev; do { prev = s; s = s.replace(/\{\{[^{}]*\}\}/g, ''); } while (s !== prev); // nested templates
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');
  s = s.replace(/\[(?:https?:\/\/|\/\/)\S+\s+([^\]]+)\]/g, '$1').replace(/\[(?:https?:\/\/|\/\/)\S+\]/g, '');
  // List/def markers (*#:; at line start) BEFORE heading conversion — otherwise the
  // '#' this pass would emit for headings gets mistaken for an ordered-list marker.
  s = s.replace(/^[*#:;]+\s*/gm, '- ');
  s = s.replace(/^(={1,6})\s*(.*?)\s*\1\s*$/gm, (_, eq, txt) => `\n${'#'.repeat(eq.length)} ${txt.trim()}\n`);
  s = s.replace(/'''''([^']+)'''''/g, '$1').replace(/'''([^']+)'''/g, '$1').replace(/''([^']+)''/g, '$1');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// Small retry wrapper honoring Retry-After on 429/503 (maxlag), max 3 attempts.
async function apiGet(fetchImpl, url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await getJson(fetchImpl, url);
    if (r.status === 429 || r.status === 503) {
      const wait = Math.min(2000, Number(r.retryAfter || 0) * 1000 || 200);
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    return r;
  }
  return { status: 429, json: null, rateLimited: true };
}

/**
 * ingestWiki(root, options, deps) ->
 *   MediaWiki API present: { type:'wiki', root, docs, skipLog, makeLocator }
 *   otherwise:             the website crawler's result (type:'website') — full fallback.
 */
export async function ingestWiki(root, options = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('global fetch unavailable (Node ≥ 22 required) and no fetchImpl injected');

  const api = await detectApi(root, fetchImpl);
  if (!api) return ingestWeb(root, options, deps); // not MediaWiki → every wiki is a website

  const namespaces = options.namespaces && options.namespaces.length ? options.namespaces : [0];
  const maxPages = options.max_pages ?? 200;

  // Enumerate page titles per requested namespace (namespace filter, §6 wiki).
  const titles = [];
  for (const ns of namespaces) {
    if (titles.length >= maxPages) break;
    const url = `${api}?action=query&list=allpages&apnamespace=${encodeURIComponent(ns)}&aplimit=${Math.min(500, maxPages)}&format=json`;
    const r = await apiGet(fetchImpl, url);
    const pages = r.json?.query?.allpages || [];
    for (const p of pages) { if (titles.length >= maxPages) break; titles.push(p.title); }
  }

  const docs = [];
  const skipLog = [];
  for (const title of titles) {
    const url = `${api}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json`;
    const r = await apiGet(fetchImpl, url);
    if (r.rateLimited) { skipLog.push({ path: title, reason: 'rate-limited' }); continue; }
    if (r.json?.error) { skipLog.push({ path: title, reason: r.json.error.code || 'api-error' }); continue; }
    const wt = r.json?.parse?.wikitext?.['*'];
    if (wt == null) { skipLog.push({ path: title, reason: 'empty' }); continue; }
    if (/^#redirect/i.test(String(wt).trim())) { skipLog.push({ path: title, reason: 'redirect' }); continue; }
    const text = wikitextToText(wt);
    if (text.length < 1) { skipLog.push({ path: title, reason: 'empty' }); continue; }
    docs.push({ doc_path: title, text, kind: 'markdown' });
  }

  // Locator: Page Title§Section (the chunk heading is the section).
  const makeLocator = (doc, c) => (c.heading ? `${doc.doc_path}§${c.heading}` : doc.doc_path);
  return { type: 'wiki', root, docs, skipLog, makeLocator };
}
