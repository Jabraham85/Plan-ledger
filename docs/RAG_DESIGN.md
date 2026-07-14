# RAG sidecar — deterministic source scrubber + slim retriever

**Plan:** #98 · **Step:** 510 (design) · **Status:** design accepted for implementation
**Author role:** architect · **Date:** 2026-07-14

A **non-AI program** that agents *call* — never an agent doing the reading. Two halves:

- **Ingest** ("scrub the sources — files, folders, websites, wikis, gits — leave no stone unturned"): deterministic crawlers that chunk every source into `codename-chunknumber` units with exact back-pointing locators.
- **Retrieve** ("a program too when feeding back, making token usage slim"): lexical ranking + the **neighbor-expansion rule** — a hit grows into its previous/next chunks until a chunk no longer scores relevant — returning token-slim, cited payloads that the agent recursively expands or narrows via further tool calls.

Everything is deterministic: same corpus + same query ⇒ byte-identical results. No embeddings, no network at query time, no native deps (`node:sqlite` only — same constraint as `src/db.mjs:11`).

---

## 0. Decision criteria (stated before scoring)

All alternatives below are judged on, in order:

1. **Determinism** — same inputs, same outputs; testable by fixture.
2. **Zero native deps / zero query-time network** — house rule (package.json has one runtime dep, the MCP SDK).
3. **Blast radius** — how much existing code changes (six processes already share `data/plan-ledger.db`: `src/server.mjs:22`, `web/server.mjs:17`, `web/app.mjs:17`, `scripts/runner.mjs:69`, `scripts/seed-templates.mjs:7`, `scripts/build-graph.mjs:12`).
4. **Token economy** — the retrieval payload must stay slim (progressive-disclosure philosophy, `src/db.mjs:4-9`).
5. **Citation stability** — `codename-N` must translate back to a source forever, or clearly say "superseded".
6. **Provability** — improvements ship only if the eval (step 513) shows they win.

---

## 1. Storage: own `rag.db` sidecar (decided)

### Alternatives

| Option | WAL contention | Backup/portability | Store-class reuse | Blast radius | Verdict |
|---|---|---|---|---|---|
| **A. Sibling `data/rag.db`, own `RagStore` class** | none — bulk ingest writes never block the busy ledger DB | index is *derived* data; rebuildable; excluded from precious backups | reuses the *pattern* (WAL, busy_timeout, migration), not the class | server.mjs +2 lines | **CHOSEN** |
| B. New tables inside `plan-ledger.db` via `Store._migrate()` | bad — a 50k-chunk website ingest holds write locks against the MCP server, the board's `activity()` poll (`src/db.mjs:825`), and the runner | index bloat rides inside the precious plan DB; FTS5 shadow tables clutter every backup | full reuse of `Store` | db.mjs schema + migration churn | rejected |
| C. One DB per codename | none | worst — N files to manage | none | tool code must fan out over files | rejected |

**Why A wins:** the ledger DB is hot (six concurrent openers, grep evidence above) and *precious*; the RAG index is cold-written, hot-read, and *disposable* (re-ingest rebuilds it). Separating them means an ingest crash can never corrupt plan data, and `rag_forget` is a plain DELETE with no fear. There are **no cross-DB joins to lose** — nothing in the plans schema references chunks (the plan-time RAG declaration, §10, is a text convention precisely so this stays true). Evidence that would flip it: if steps ever need an enforced FK to chunks, revisit B.

**Location:** `$PLAN_LEDGER_RAG_DB`, else `data/rag.db` next to `data/plan-ledger.db` (mirrors `src/server.mjs:22`).

### DDL (v1)

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;          -- bump on any schema change; RagStore._migrate() checks it

CREATE TABLE IF NOT EXISTS rag_sources (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  codename     TEXT    NOT NULL,               -- slug, e.g. 'frontier-docs'
  version      INTEGER NOT NULL DEFAULT 1,     -- bumped on every re-ingest of the same codename
  status       TEXT    NOT NULL DEFAULT 'active',  -- ingesting | active | superseded | failed
  type         TEXT    NOT NULL,               -- file | folder | git | website | wiki
  root         TEXT    NOT NULL,               -- the locator handed to rag_ingest (path or URL)
  options      TEXT    NOT NULL DEFAULT '{}',  -- JSON: the exact caps/globs/depth used (reproducibility)
  docs         INTEGER NOT NULL DEFAULT 0,
  chunks       INTEGER NOT NULL DEFAULT 0,
  tokens_est   INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT    NOT NULL DEFAULT '',    -- sha256 over ordered per-doc hashes → cheap "did it change"
  skip_log     TEXT    NOT NULL DEFAULT '[]',  -- JSON [{path, reason}], capped at 50 entries
  error        TEXT    NOT NULL DEFAULT '',
  ingested_at  TEXT    NOT NULL,
  UNIQUE (codename, version)
);
CREATE INDEX IF NOT EXISTS idx_rag_sources_code ON rag_sources(codename, status);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id  INTEGER NOT NULL REFERENCES rag_sources(id) ON DELETE CASCADE,
  codename   TEXT    NOT NULL,                 -- denormalized: query path never joins for the common case
  seq        INTEGER NOT NULL,                 -- 1-based, contiguous per (source_id); THE chunk number
  text       TEXT    NOT NULL,
  doc_path   TEXT    NOT NULL,                 -- doc within the source (rel path | URL | wiki page title)
  heading    TEXT    NOT NULL DEFAULT '',      -- nearest enclosing heading (retrieval context + locator)
  locator    TEXT    NOT NULL,                 -- exact back-pointer, see "Locator grammar" below
  tokens_est INTEGER NOT NULL,                 -- ceil(chars/4)
  hash       TEXT    NOT NULL,                 -- sha256(normalized text) → re-ingest dedup/versioning
  UNIQUE (source_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_code ON rag_chunks(codename, seq);

-- External-content FTS index: no text duplication; rides on rag_chunks.
-- SPIKED OK on node v24.11.0 (see §3): bm25(), snippet(), 'delete' sync all work.
CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
  text, content='rag_chunks', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
```

`RagStore` (NEW, `src/rag/store.mjs`) follows the `Store` conventions from `src/db.mjs:183-212` (constructor opens/migrates, synchronous prepared statements, `close()`), but migrates via `PRAGMA user_version` instead of column sniffing — the schema is new, so it can start clean.

### Citation contract & versioning (criterion 5)

- **Chunk id grammar:** `codename-seq` (e.g. `frontier-docs-17`) always refers to the **active** version. Fully qualified form `codename@v2-seq` pins a superseded version.
- **Re-ingest = expand→migrate→contract:**
  1. *Expand:* new `rag_sources` row `(codename, version+1, status:'ingesting')`; chunks written under it. The active version keeps serving queries during ingest.
  2. *Migrate:* on success, the new row flips to `active`, the old to `superseded` — one transaction.
  3. *Contract:* superseded chunks are **retained** (one generation) so any `codename-N` an agent wrote into a step brief still resolves; `rag_cite` on a chunk whose version is superseded returns `superseded: true` + the active version's ingest date so the caller knows to re-query. `rag_forget {codename, prune_superseded:true}` (or the next re-ingest) deletes generation N−2.
  - A failed ingest flips the new row to `failed` and deletes its chunks in the same transaction — the active version is never touched (same atomicity discipline as `Store.importGraph`, `src/db.mjs:698-722`).

### Locator grammar ("chunk names and numbers translate back to the sources")

| Source type | locator format | example |
|---|---|---|
| file/folder | `<rel-or-abs path>#L<start>-L<end>` | `src/db.mjs#L183-L212` |
| git | `<rel path>@<short-sha>#L<start>-L<end>` | `Source/Gather.cpp@a1b2c3d#L10-L54` |
| website | `<URL>#<nearest-anchor-or-heading-slug>` | `https://ex.org/guide#installation` |
| wiki | `<page title>§<section heading>` | `Crafting§Resource quality` |

---

## 2. Deterministic chunker (`src/rag/chunker.mjs`, NEW)

**Token estimate:** `estTokens(s) = Math.ceil(s.length / 4)` — stated everywhere as an estimate; good enough for budgeting, fully deterministic.

**Bounds:** `MIN=100`, `TARGET=400`, `MAX=600` estimated tokens (tunable per-ingest via `options`, recorded in `rag_sources.options`).

**Algorithm** (pure function: `chunk(text, kind) → [{text, heading, startLine, endLine}]`):

1. **Split into atomic blocks**, boundary-aware by kind:
   - `markdown|text`: fenced code blocks (``` … ```) are atomic; then split at headings (`#`–`######`), then at blank-line paragraph breaks. Each block remembers the nearest enclosing heading.
   - `code` (by extension): split at top-level blank-line groups; a heuristic keeps brace-balanced runs together (never split inside an unbalanced `{`/`}` region); leading comment blocks attach to the declaration that follows.
   - `html`: converted to markdown-ish text first (see website ingester, §6), then chunked as markdown.
2. **Greedy pack:** accumulate consecutive blocks while `est(acc) + est(next) <= TARGET`; emit on overflow. A heading block always starts a new chunk (headings are the retrieval anchors).
3. **Oversized single block** (> `MAX`): hard-split at line boundaries into `MAX`-sized pieces (never mid-line).
4. **Runt merge:** a final chunk `< MIN` merges into its predecessor unless it would exceed `MAX`.
5. `seq` assigned 1-based in document order, docs ordered by sorted `doc_path` — so `codename-N` is **stable for a given source version** (the citation contract's foundation).

**Overlap: NO (decided).** Sliding-window overlap was considered and rejected:

| | Overlap chunking | Neighbor expansion (chosen) |
|---|---|---|
| Token cost | duplicated text in every hit payload, always | context fetched only when the query warrants it |
| Citation clarity | the same sentence lives in 2 chunk ids — "exactly what and where" breaks | one sentence, one chunk id |
| Recall at boundaries | static, fixed at ingest time | dynamic, query-aware, tunable at query time |

Expansion *replaces* overlap's only benefit (boundary recall) with a deterministic, query-time mechanism — which is exactly the user's core requested mechanic. The eval (§9) measures boundary recall via expansion recall, so this choice is checked empirically.

**Codename derivation:** caller-supplied, else `slug(basename(root))` (lowercase, `[^a-z0-9]+`→`-`, trimmed). Collision with an existing *different root* → error telling the agent to pass an explicit codename (never silent suffixing — ids must stay predictable).

---

## 3. Ranking: FTS5 BM25 primary, pure-JS BM25 fallback

**Spike result (empirical, this machine, node v24.11.0):**

```
> node -e "new (require('node:sqlite').DatabaseSync)(':memory:').exec(\"CREATE VIRTUAL TABLE t USING fts5(x)\")"
FTS5 OK
(node:17912) ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

Extended spike — `bm25()`, `snippet()`, `unicode61` tokenizer, and the external-content pattern with `'delete'` sync all work:

```
[{"codename":"a","score":-0.0000021463414634146348,"snip":"the [quick] brown [fox] jumps"}]
delete-sync ok: true
```

Gotchas recorded from the spike: (a) `MATCH 'quick fox'` is **implicit AND** — the query builder must OR terms explicitly; (b) `bm25()` returns *negative* scores (lower = better) — normalize to `-bm25()`; (c) `node:sqlite` is flagged experimental — hence the fallback below is a hard requirement, not decoration.

**Design: one `Ranker` interface, two implementations** (`src/rag/rank.mjs`, NEW):

```js
// rank(queryTerms: string[], opts: {codenames?, limit}) →
//   [{chunkId, codename, seq, score >= 0, snippet}]  — deterministic order:
//   score DESC, then codename ASC, then seq ASC (total order; no float ties decide alone)
export function makeFtsRanker(ragDb) { /* SELECT … FROM rag_fts JOIN rag_chunks … MATCH ?
     ORDER BY bm25(rag_fts); query = terms.map(t => '"'+t+'"').join(' OR ') */ }
export function makeJsRanker(ragDb)  { /* classic BM25, k1=1.2 b=0.75, over tokenize()'d
     chunk text; same tokenize() as the query side */ }
```

- **Tokenization is shared** between indexing and querying and mirrors the house `tokenize` at `src/db.mjs:168` (lowercase, split on `[^a-z0-9_]+`, length > 2, stopword set) — the JS ranker and the term-presence scorer in §4 both use it. The FTS side approximates it via `unicode61`; the eval quantifies the difference.
- **Trust boundary:** the raw query string never reaches `MATCH`. It is tokenized first and each term is double-quoted — FTS5 query-syntax injection (`"`, `NEAR`, `*`, `-`) is structurally impossible. MCP args are zod-validated (house pattern, `src/server.mjs:29-33`); URLs/paths are validated per §6.
- **Selection:** FTS5 by default when the `CREATE VIRTUAL TABLE` probe succeeds at RagStore open; `RAG_RANKER=js` env forces the fallback (also how the eval compares them). The JS ranker is prior art in-repo: `getLessons` IDF scoring at `src/db.mjs:492-508` and `recall` at `src/db.mjs:802-818`.
- **What ships is decided by the eval** (§9): term-count baseline vs JS BM25 vs FTS5 BM25 — the user's condition, "as long as you can test and prove it".

---

## 4. THE expansion rule (the core mechanic, precisely)

> "Every time there's a hit the context expands both to the previous chunk and the next chunk until the chunk no longer contains relevant information."

**One deterministic formulation (chosen):** relevance-ratio threshold with an IDF-weighted term-presence score. The alternative formulation from the brief — "neighbor shares ≥ K query terms" — is **subsumed and declined**: `rel > 0` already means ≥1 shared term, and a fixed K ignores term informativeness (matching "the… uses" ≠ matching "checkpointing"); the IDF weighting handles that continuously. Declined, revisit only if the eval shows expansion precision < 0.5 that a K-terms guard would fix.

```
rel(C, Q) = Σ over unique query terms t present in tokenize(C.text) of idf(t)
            where idf(t) = ln(1 + N / df(t)), N = chunk count in the queried codenames
            (identical machinery to getLessons, src/db.mjs:494-498 — deterministic, ranker-independent)

expand(H, Q, {threshold=0.35, max_hops=3, token_budget}):
  base = rel(H, Q)                      # if base == 0 (FTS matched on stemming edge): no expansion
  for dir in (prev, next):              # prev = seq-1, seq-2… ; next = seq+1, seq+2…
    walk contiguous seq in dir while ALL of:
      • neighbor exists in the same (codename, version)
      • hops ≤ max_hops
      • rel(neighbor, Q) >= threshold * base      # "no longer contains relevant info" → stop
      • running token total ≤ token_budget
    stop at the FIRST failing neighbor (no skip-ahead — contiguity is the point)
  return the contiguous run [first_accepted_prev … H … last_accepted_next]
```

- Deterministic: `rel` is a pure function of stored text + query; walks are ordered; no randomness.
- Tunable: `threshold`, `max_hops`, `token_budget` are query params with the defaults above; defaults live in one exported const so the eval can sweep them.
- Runs happen **server-side per hit** when `rag_query {expand:true}` (the default), and **on demand** via `rag_expand` for the agent's recursive loop.
- Overlapping runs from two hits in the same codename merge into one cited range (no duplicate text in the payload).

**Payload discipline (criterion 4):**

- Slim hit (always): `{chunk:'codename-12', score, locator, heading, snippet}` — snippet ≤ 200 chars (FTS5 `snippet()` when available, else first matching line).
- Expanded run (only when expansion accepted it): full text, plus `first`/`last` chunk ids so the agent can keep walking manually.
- Whole response capped by `token_budget` (default 2000 est. tokens). On cap: `"truncated": true, "next": "rag_expand {chunk:'frontier-docs-15', direction:'next'}"` — the recursion pointer is explicit.

---

## 5. MCP tool surface (zod-level, house `tool()` helper `src/server.mjs:29`)

Six tools. (`rag_list` was considered and folded into `rag_status` with no argument — one fewer tool name to learn.) Every result carries a `directive` string suggesting the recursive next move (house pattern, cf. `next_step` / `record_attempt` directives at `src/server.mjs:109-136,196-221`).

```js
// rag_ingest — scrub a source into codename-N chunks. Type auto-detected from `source`:
//   existing file path → file; existing dir → folder; ends in .git or is a git URL /
//   has a .git dir → git; URL whose /api.php answers → wiki; other http(s) → website.
{ source:   z.string().describe('path or URL'),
  codename: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  type:     z.enum(['file','folder','git','website','wiki']).optional(),  // explicit override
  options:  z.object({
    max_file_kb: z.number().int().optional(),      // default 512
    max_files:   z.number().int().optional(),      // default 5000
    include:     z.array(z.string()).optional(),   // globs
    exclude:     z.array(z.string()).optional(),   // globs, merged with defaults
    max_depth:   z.number().int().optional(),      // website BFS, default 3
    max_pages:   z.number().int().optional(),      // website/wiki, default 50 / 200
    delay_ms:    z.number().int().optional(),      // politeness, default 500
    namespaces:  z.array(z.number().int()).optional(), // wiki, default [0]
    include_log: z.boolean().optional(),           // git: last 200 commit subjects as one doc
  }).optional() }
// → { codename, version, type, docs, chunks, tokens_est, skipped:[{path,reason}] (≤50), directive }

// rag_status — the ingest-or-query decision input. No codename → all sources.
{ codename: z.string().optional() }
// → [{ codename, version, status, type, root, docs, chunks, tokens_est, ingested_at }]

// rag_query — THE entry point. Slim hits + auto-expanded runs.
{ query:        z.string(),
  codenames:    z.array(z.string()).optional(),   // filter; default all active
  limit:        z.number().int().max(20).optional(),   // hits, default 5
  expand:       z.boolean().optional(),           // default true
  threshold:    z.number().min(0).max(1).optional(),   // default 0.35
  max_hops:     z.number().int().max(10).optional(),   // default 3
  token_budget: z.number().int().optional() }          // default 2000
// → { query, ranker:'fts5'|'js', hits:[{chunk,score,locator,heading,snippet}],
//     expanded:[{chunks:'code-10..code-14', text, locators:[…]}], truncated?, next?, directive }

// rag_expand — the manual recursion step (agent-driven walk).
{ chunk:     z.string().describe('e.g. frontier-docs-12 or frontier-docs@v2-12'),
  direction: z.enum(['prev','next','both']).optional(),   // default 'both'
  count:     z.number().int().min(1).max(5).optional() }  // default 1 each way
// → { center, chunks:[{chunk, text, locator, heading}], directive }

// rag_cite — chunk ids → exact source citations (the translation back).
{ chunks: z.array(z.string()).min(1) }
// → [{ chunk, codename, version, superseded, locator, doc_path, heading, source_root }]

// rag_forget — remove a source (or just its superseded generations).
{ codename: z.string(), prune_superseded: z.boolean().optional() }  // default: forget everything
// → { codename, removed_versions, removed_chunks }
```

Registration: `src/rag/tools.mjs` (NEW) exports `registerRagTools(server, ragStore)`; `src/server.mjs` gains **two lines** (import + call) — the whole blast radius on the live server file.

Example exchange (contract-level):

```
rag_query {query:"expansion threshold neighbor rule", codenames:["pl-docs"]}
→ { ranker:"fts5",
    hits:[{chunk:"pl-docs-41", score:7.2, locator:"docs/RAG_DESIGN.md#L210-L241",
           heading:"THE expansion rule", snippet:"…walk contiguous seq while rel(neighbor,Q) >= threshold*base…"}],
    expanded:[{chunks:"pl-docs-40..pl-docs-42", text:"…full text of the run…",
               locators:["docs/RAG_DESIGN.md#L198-L252"]}],
    directive:"Cited context above. If insufficient: rag_expand {chunk:'pl-docs-42',direction:'next'}
               to keep walking, or re-query with narrower terms. Cite chunk ids in your output." }
```

---

## 6. Ingester matrix — no stone unturned

Common failure model: **skip-and-record** (into `skip_log`, returned capped at 50) for per-item problems; **abort-source** (version → `failed`, active generation untouched) only for structural failures (root missing, clone failed, robots disallows root). Ingest never writes outside `rag.db` and the OS temp dir.

### fs (file / folder) — `src/rag/ingest/fs.mjs` (NEW)

| Condition | Behavior |
|---|---|
| Binary file | sniff first 8 KB; any NUL byte → skip `binary` |
| Bad encoding | read UTF-8 (strip BOM); U+FFFD replacement ratio > 5% → skip `undecodable` |
| File > `max_file_kb` (512) | skip `too-large` (cap recorded in options) |
| Default excludes | `node_modules`, `.git`, `dist`, `build`, `out`, `coverage`, `.venv`, `__pycache__`, `*.min.*`, `*.lock`, `package-lock.json` — superset of the extractor's list, cf. `src/extract.mjs:13-14`; user `exclude` merges, `include` overrides |
| Symlinks | files: ingested via realpath; **directories: not followed** (cycle-proof by construction); realpath dedup set catches remaining aliases |
| Empty file (0 bytes / whitespace) | skip `empty` |
| Permission error / vanished mid-walk | skip `unreadable: <errno>` |
| > `max_files` (5000) | stop walk, record `file-cap-hit`, ingest what was gathered (partial is explicit in skip_log) |
| Root doesn't exist | **abort-source** |

### git — `src/rag/ingest/git.mjs` (NEW)

| Condition | Behavior |
|---|---|
| Local path with `.git` | use in place — **no clone, no network** |
| URL | `git clone --depth 1 --single-branch <url> <tempdir>` via `spawnSync` **arg array** (no shell interpolation — URL is untrusted input); `git --version` probed first, clear error if git missing |
| Private repo | whatever the local git auth (credential manager / SSH agent) provides; the program never handles or stores credentials |
| File selection | `git ls-files` at HEAD (tracked only), then the full fs matrix above applies per file |
| Locator commit | `git rev-parse --short HEAD` baked into every locator (`path@sha#L…`) — citations survive later commits |
| Commit history | `options.include_log` → last 200 subjects (`git log --format=%h %s -200`) as one synthetic doc `<codename>/_commits` |
| Submodules | not recursed (ingest each as its own codename if needed) |
| Clone failure (auth/network/404) | **abort-source** with git's stderr in `error` |
| Cleanup | temp clone removed in `finally` — success or failure |

### website — `src/rag/ingest/web.mjs` (NEW)

| Condition | Behavior |
|---|---|
| Crawl scope | same-origin BFS from root (scheme+host+port); off-origin links not enqueued |
| Caps | `max_depth` 3, `max_pages` 50 — hitting either stops the walk, recorded `page-cap-hit` |
| robots.txt | fetched once per origin; longest-match Disallow for `*` honored. robots 404 → allow all; robots 5xx/timeout → **abort-source** (conservative). Root itself disallowed → abort-source |
| Politeness | `delay_ms` (500) between requests, serial fetching, UA `plan-ledger-rag/0.1` |
| Fetch | Node ≥ 22 global `fetch` (zero deps); timeout 15 s per page via `AbortSignal.timeout`; non-200 → skip `http-<status>` |
| Content-type | `text/html`, `text/plain`, `text/markdown` only; others skip `content-type` |
| Page > 2 MB | skip `too-large` |
| Redirects | followed ≤ 5, final URL must still be same-origin, else skip `redirected-off-site` |
| HTML→text (deterministic extraction) | regex/state-machine pass, no DOM dep: drop `<script> <style> <nav> <header> <footer> <aside> <noscript> <template>` subtrees; `<h1>`–`<h6>` → `#`…`######` (keeping `id` attr as anchor slug for locators); `<li>` → `- `; `<pre>/<code>` → fenced blocks; `<table>` rows → pipe-lines; entities decoded; whitespace collapsed |
| URL normalization / dedup | strip fragment, keep query, lowercase host, drop trailing `/`; dedupe by normalized URL **and** by content hash (mirrors/aliases) |
| JS-rendered SPA | **documented limitation** — no headless browser (determinism + zero deps); extraction yields whatever static HTML carries; skip_log records `empty-after-extraction` when a page yields < 50 chars |

### wiki — `src/rag/ingest/wiki.mjs` (NEW)

| Condition | Behavior |
|---|---|
| Detection | probe `<root>/api.php` then `<root>/w/api.php` with `?action=query&meta=siteinfo&format=json`; JSON with `query.general` → MediaWiki API mode |
| API mode | `list=allpages` per namespace (`namespaces` default `[0]`), page cap `max_pages` (200); text via `action=parse&prop=wikitext` rendered by the deterministic wikitext→text pass (headings `==` → `#`, templates `{{…}}` dropped, links `[[a|b]]` → `b`); locator = `Page Title§Section` |
| Not MediaWiki | **fall back to the website crawler** (same table above) — every wiki is at minimum a website |
| API rate-limit / maxlag error | honor `Retry-After`, max 3 retries, then skip page `rate-limited` |
| Redirect/empty pages | skip `redirect` / `empty` |

---

## 7. Agent interaction contract (the recursive loop)

The agent-facing doc (step 514, `docs/RAG.md`) ships this; the design fixes the contract:

1. **Ingest-or-query decision:** `rag_status` first. Codename present with plausible `ingested_at` → query. Missing → `rag_ingest`. Source known-changed (e.g. you just edited the repo) → re-ingest (versioning keeps old citations resolvable).
2. **Query slim:** `rag_query {query, codenames:[…]}` — 2–5 informative terms beat sentences (stopwords are dropped anyway). Multi-codename search is one call: `codenames:["frontier-docs","frontier-src"]`.
3. **Recurse — expand vs narrow:**
   - Hits look right but context feels cut off → `rag_expand` on the boundary chunk (the payload's `next` field literally contains the call to make).
   - Hits scattered across many docs / low scores → **narrow**: re-query with more specific terms (add the identifier you saw in a snippet).
   - Zero hits → broaden: fewer/synonym terms; still zero → wrong codename or the source needs ingesting (`rag_status` again).
   - Two hits in the same doc a few chunks apart → the span between them is probably relevant: expand from either end rather than re-querying.
4. **Cite:** every claim the agent writes carries chunk ids; before final output, one `rag_cite {chunks:[…]}` translates ids to exact `path#L`/URL locators. Superseded chunks (`superseded:true`) → re-run the query against the active version before shipping the claim.

Worked example:

```
rag_status {}                                   → frontier-docs missing
rag_ingest {source:"C:/…/Frontier/docs"}        → codename frontier-docs, 214 chunks
rag_query  {query:"gather yield modifier", codenames:["frontier-docs"]}
                                                → hit frontier-docs-57 (+ run 56..58), truncated,
                                                  next: rag_expand {chunk:"frontier-docs-58",…}
rag_expand {chunk:"frontier-docs-58", direction:"next", count:2}   → 59, 60 full text
rag_cite   {chunks:["frontier-docs-57","frontier-docs-59"]}
                                                → GATHERER_PLAN.md#L120-L161, #L190-L215
```

**When NOT to use it:** single known file (read it directly / `read_file_ref`), plan/step/lesson knowledge (`recall` / `get_lessons` already do that over the ledger — the RAG is for *external* corpora), sources that change every minute.

---

## 8. Client story (same MCP server, both clients)

The tools ride the existing stdio server (`src/server.mjs`) — **zero new processes**; anything that can call plan-ledger tools gets RAG for free.

- **Claude Code:** the `/plan` skill gains one paragraph: before working a step, check the step brief for `RAG:` lines (§10) and run the starter queries; when research is needed mid-step, prefer `rag_query`/`rag_expand` over reading whole files into context; cite chunk ids in reports. The headless runner needs nothing — RAG pointers travel inside `step.context`, which the runner already forwards verbatim.
- **Cursor:** the Cursor rule/skill surface shipped by plan 96 gains the mirror paragraph: same server binary, same tool names; the rule text tells the agent the loop is query → expand/narrow → cite and that `rag_status` answers "is it indexed?". No Cursor-specific code — the MCP config already points at `src/server.mjs`.

---

## 9. Eval design (step 513 — proof gate for any "improvement")

- **Fixture corpus** (`test/fixtures/rag/`, committed, no network at test time):
  - `docs/` — 3 markdown files (~2k words each: one design-doc style, one runbook style, one FAQ style);
  - `src/` — 3 `.mjs` source files (real code shapes: class, functions, comments);
  - `site/` — 3 static HTML pages ingested from `file://`-style local fixture paths through the website extractor (extraction tested without network);
  - `repo/` — built by the eval script into a temp dir: `git init` + 2 commits + 5 files (exercises the git ingester offline).
- **Ground truth** (`test/fixtures/rag/golden.json`): ~15 entries `{query, relevant_chunks:["codename-N",…], relevant_span:{codename, first, last}}`, hand-marked after a pinned reference ingest (chunker params frozen in the file; changing chunker defaults requires re-marking — noted in the file header).
- **Metrics:**
  - `hit@3`, `hit@5` — fraction of queries with ≥ 1 relevant chunk in top k;
  - **expansion precision** = |expanded ∩ relevant_span| / |expanded|;
  - **expansion recall** = |expanded ∩ relevant_span| / |relevant_span|;
  - payload tokens per query (the slimness budget, reported not gated).
- **Variant table** (`npm run eval:rag` prints; numbers get committed back into this doc):

| Variant | hit@3 | hit@5 | exp. precision | exp. recall | avg payload tok |
|---|---|---|---|---|---|
| term-count baseline | – | – | – | – | – |
| JS BM25 | – | – | – | – | – |
| FTS5 bm25 | – | – | – | – | – |

- **Ship rule:** a variant ships only if it **beats or ties the baseline on hit@3** (tie → hit@5 → simpler implementation wins). Threshold/max_hops defaults are swept (`threshold ∈ {0.25, 0.35, 0.5}`, `max_hops ∈ {2,3,5}`) once, and the winning defaults are written into §4 and the code's exported const.

---

## 10. Plan-time RAG declaration (addendum requirement)

**Goal:** the planning session declares what must be ragged so dispatched step agents start with knowledge infrastructure ready, instead of discovering sources mid-step.

### Mechanism — alternatives

| Option | Schema churn | Reaches every consumer (runner, get_context, board, next_step) | Deterministic to parse | Verdict |
|---|---|---|---|---|
| **(i) Text convention in `step.context`** | zero | yes — context is forwarded verbatim by `getStep` (`src/db.mjs:359-381`), `next_step`, `buildPlanContext`, and the headless runner's prompt builder | yes — one anchored regex | **CHOSEN** |
| (ii) `file_refs` with `rag://codename` locators | zero DDL but code churn | no — `readFileRef` does `statSync(r.path)` (`src/db.mjs:564-572`) and would return `exists:false` noise; `suggestFileRefs` path-normalizes real paths (`src/db.mjs:583-605`); board renders paths as files. Every consumer needs a `rag://` special case | needs URI parsing in ≥ 3 places | rejected |
| (iii) New column/table (`step_rag_refs`) | DDL + migration + tool schema churn | only after touching every reader | yes | rejected — unjustified for what is a pointer + two strings |

**(i) wins on blast radius:** it is the only option where the *existing* pipeline already delivers the declaration to every executor, including the headless runner, with zero code change outside the RAG feature itself. It also keeps the §1 promise that nothing in the plans schema references chunks. Evidence that would flip it: if the board ever needs to *render* RAG pointers as structured UI, promote to (iii) then — the text convention migrates forward trivially (one script greps `^RAG:` lines).

### The convention (exact grammar)

One line, anywhere in `step.context` (planners put it first), one line per codename:

```
RAG: <codename> — start: "<query 1>"[; "<query 2>"[; "<query 3>"]]
```

Example: `RAG: frontier-docs — start: "gather yield modifier"; "resource quality tiers"`

Parse rule (for any tooling that wants it, incl. the eval of step brief quality): `/^RAG:\s*(?<codename>[a-z0-9-]+)\s*—\s*start:\s*(?<queries>.+)$/m`, queries split on `;`, each stripped of surrounding quotes.

### Planner-side contract (folds into requirement 7's loop)

At plan creation (`/plan new` decomposition), the planner:
1. Lists the knowledge the steps need (repo dirs, design docs, dependency gits, external sites/wikis).
2. `rag_status` → `rag_ingest` anything missing (codenames chosen to be stable across plans: `frontier-docs`, not `plan98-docs`).
3. Writes a `RAG:` line into each step's `context` naming the codename(s) + 1–3 starter queries the step agent runs **before** its own work, then recurses (expand/narrow) per §7.

The mapping record *is* the set of RAG lines (greppable via `recall`, visible in `get_context` output) — no extra table.

### `/plan new` skill paragraph (verbatim, for step 514's tech-writer)

> **Declare the plan's knowledge up front.** While decomposing, list every source the steps will need (repo folders, design docs, dependency gits, external sites/wikis). Check `rag_status`; `rag_ingest` anything missing under a stable codename. Then give each step a first line in its context of the form `RAG: <codename> — start: "<query>"[; "<query>"]` naming the source(s) and 1–3 starter queries. Step agents run those queries first (`rag_query`, then `rag_expand`/narrow as needed) and cite chunk ids — so they start grounded instead of rediscovering sources mid-step.

---

## 11. Module layout (all NEW files)

```
src/rag/store.mjs        RagStore: open/migrate rag.db, chunk CRUD, versioning, rag_cite/forget logic
src/rag/chunker.mjs      pure chunk(text, kind, opts) — §2
src/rag/rank.mjs         makeFtsRanker / makeJsRanker + shared tokenize/idf — §3
src/rag/expand.mjs       rel() + expand() — §4 (pure functions over RagStore reads)
src/rag/ingest/fs.mjs    §6 fs matrix
src/rag/ingest/git.mjs   §6 git matrix (spawnSync arg-array only)
src/rag/ingest/web.mjs   §6 website matrix + HTML→text extractor
src/rag/ingest/wiki.mjs  §6 wiki matrix (API mode; falls back to web.mjs)
src/rag/tools.mjs        registerRagTools(server, ragStore) — the only file server.mjs touches
test/rag.mjs             unit tests (temp DBs only — never data/*.db), fixture-driven
test/fixtures/rag/…      §9 corpus + golden.json
scripts/eval-rag.mjs     npm run eval:rag — §9 table
```

Existing-file diffs, complete list: `src/server.mjs` +2 lines (import + register), `package.json` +2 script lines (`test:rag`, `eval:rag`), `test` script extended to include `node test/rag.mjs`.

---

## 12. Implementation step list (maps to plan 98 steps 2–5)

Verification commands are PowerShell-5.1-safe (no `&&`).

**Step 2 = ledger step 511 — Core engine** *(role: implementer; depends on: this doc)*
Context digest: build `src/rag/{store,chunker,rank,expand,tools}.mjs` per §§1–5 DDL/pseudocode/zod verbatim; register in `server.mjs` (+2 lines); `test/rag.mjs` covers: chunker determinism (same input twice → identical seq/text/hash), bounds (MIN/TARGET/MAX), fence atomicity, expansion stop-at-threshold (fixture where seq±2 is irrelevant → run is exactly 3 chunks), version supersede (re-ingest of changed fixture → old id resolves with `superseded:true`), FTS injection attempt (`query: 'x" OR NEAR('` returns results or empty, never throws), both rankers behind `RAG_RANKER`.
Acceptance (binary): `node test/rag.mjs` exits 0 with those named checks; `npm test` green; rag_* tools appear in the e2e tool list (`node test/mcp-e2e.mjs`).
Verify: `npm test; node test/rag.mjs`

**Step 3 = ledger step 512 — Ingesters** *(role: implementer; depends on: 511)*
Context digest: `src/rag/ingest/{fs,git,web,wiki}.mjs` per the §6 matrices — every table row lands as a test or an explicit guard with a skip_log reason string matching the matrix. Offline only: fs fixtures incl. a NUL-byte file, an oversized file, a symlinked dir; git via temp `git init` repo; web via the extractor run on `test/fixtures/rag/site/*.html` read from disk (fetch layer injected/mocked); wiki via a canned `api.php` JSON fixture.
Acceptance (binary): each ingester's offline test proves chunks land with correct locator grammar (§1 table); folder + git + HTML fixtures round-trip `rag_ingest → rag_query → rag_cite` to correct locators; every §6 row traceable to a test name or a guard.
Verify: `node test/rag.mjs` (extended; exits 0)

**Step 4 = ledger step 513 — Eval** *(role: test-engineer; depends on: 512)*
Context digest: build §9 corpus + `golden.json` (~15 pairs) + `scripts/eval-rag.mjs`; run the three variants + the threshold/hops sweep; commit the numbers into §9's table in this doc; flip the shipped default per the ship rule.
Acceptance (binary): `npm run eval:rag` prints the variant table; the shipped ranking beats or ties baseline on hit@3; numbers committed in this doc's §9.
Verify: `npm run eval:rag`

**Step 5 = ledger step 514 — Agent guidance both clients** *(role: tech-writer; depends on: 513)*
Context digest: write `docs/RAG.md` from §7 + §10 (recursive loop, token-economy rules, when-not-to-use, planner-side declaration incl. the verbatim `/plan new` paragraph from §10); wire the pointer paragraph into the Claude Code `/plan` skill and the Cursor rule per plan 96's surface; verify every tool name/param against the shipped zod schemas.
Acceptance (binary): `docs/RAG.md` committed; both client skills reference it; `git grep -n "rag_query" docs/RAG.md` and each skill file return hits; every cited tool/param exists in `src/rag/tools.mjs`.
Verify: `git log --oneline -1 -- docs/RAG.md; git grep -n "RAG:" -- docs`

Parallelizable: none across steps (linear dependency chain); within 512 the four ingesters are parallel once 511's store API is fixed.

---

## 13. Declined alternatives (summary)

| Alternative | Why declined | What would flip it |
|---|---|---|
| Embeddings / vector DB | non-deterministic across model versions, native/API deps, per-query cost; the user asked for **a program** | never within this plan's constraints |
| Overlap chunking | duplicates tokens, splits citations; expansion is the user's requested replacement (§2 table) | eval expansion-recall < 0.5 that overlap demonstrably fixes |
| Chunks inside `plan-ledger.db` | WAL contention with 6 concurrent openers; index is derived, ledger is precious (§1) | steps needing an enforced FK to chunks |
| Per-agent / per-plan indexes | duplicates corpora, breaks stable codenames across plans; sources are project-global | a real multi-tenant isolation need |
| "K shared terms" expansion guard | subsumed by IDF-weighted `rel > 0`; fixed K ignores term informativeness (§4) | eval shows precision failure a K-guard fixes |
| `rag://` locators in `file_refs` | `readFileRef` statSync noise + special-casing in ≥ 3 consumers (§10 table) | board needing structured RAG-pointer UI |
| Extra `rag_list` tool | `rag_status` with no arg covers it | — |
| Headless browser for SPA sites | breaks determinism + zero-dep rule | — |
