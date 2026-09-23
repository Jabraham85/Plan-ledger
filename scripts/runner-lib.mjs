// runner-lib.mjs — pure, side-effect-free helpers extracted from runner.mjs so
// they're unit-testable without triggering the script's top-level CLI parsing /
// process.exit / DB-open side effects (runner.mjs runs immediately on import).
// Nothing here touches argv, spawns `claude`, or opens a Store.

import { spawnSync } from 'node:child_process';

// ---- findings write-back (plan #134) ---------------------------------------
// Optional inject-mode contract: ONE line `FINDINGS: [ {...}, ... ]` before the
// VERDICT line, carrying durable truths the agent learned. Strictly additive —
// a missing or malformed line NEVER fails the step (the verdict governs that);
// it just means nothing is absorbed, with a reason the runner logs.
export const FINDINGS_MAX = 20;

// Locate the FINDINGS array wherever the agent put it. Real agents do not keep
// the line clean: in the 2026-09-22 real-output benchmark only 7 of 18 did. 4 put
// `FINDINGS:` mid-line after prose and 8 glued `VERDICT: …` onto the end of the
// array (bench/findings-real, Amendment 2). So: take each `FINDINGS:` marker
// directly followed by `[`, match brackets string-aware (a `]` or a quoted
// "FINDINGS: […]" INSIDE a claim cannot end or restart the array), and keep the
// LAST complete array that is not nested inside an earlier one. Returns
// { start, end, body } or null; body === null means the array never closed.
export function findingsSpan(text) {
  const s = String(text || '');
  let best = null, coveredTo = -1;
  for (let at = s.indexOf('FINDINGS:'); at >= 0; at = s.indexOf('FINDINGS:', at + 1)) {
    if (at < coveredTo) continue; // a marker quoted inside an array we already matched
    const open = at + 'FINDINGS:'.length + (s.slice(at + 9).match(/^[ \t]*/)[0].length);
    if (s[open] !== '[') { if (!best) best = { start: at, end: open, body: s.slice(open).split('\n')[0].trim() || '' }; continue; }
    let depth = 0, inStr = false, esc = false, close = -1;
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']' && --depth === 0) { close = i; break; }
    }
    if (close < 0) { best = { start: at, end: s.length, body: null }; break; }
    best = { start: at, end: close + 1, body: s.slice(open, close + 1) };
    coveredTo = close + 1;
  }
  return best;
}

export function parseFindings(text) {
  const span = findingsSpan(text);
  if (!span) return { findings: [], error: null };
  if (span.body === null) return { findings: [], error: 'FINDINGS array never closes — nothing absorbed' };
  if (!span.body || span.body === '[]') return { findings: [], error: null };
  let v;
  try { v = JSON.parse(span.body); } catch { return { findings: [], error: 'FINDINGS is not valid JSON — nothing absorbed' }; }
  if (!Array.isArray(v)) return { findings: [], error: 'FINDINGS must be a JSON array — nothing absorbed' };
  const objs = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  const error = v.length > FINDINGS_MAX ? `only the first ${FINDINGS_MAX} of ${v.length} findings kept`
    : objs.length < v.length ? `${v.length - objs.length} non-object item(s) dropped` : null;
  return { findings: objs.slice(0, FINDINGS_MAX), error };
}

export const FINDINGS_INSTRUCTIONS = [
  `\nIf you learned something DURABLE that a later step should know — a fact about the code or system, a decision, ` +
    `a lesson, a pitfall (NOT a log of what you did) — put it on ONE line immediately BEFORE your final line (VERDICT or COMPLETION_JSON):`,
  `FINDINGS: [{"kind":"fact","subject":"path#symbol or config key","claim":"one atomic truth","evidence":"file:line or command"}]`,
  `kinds: fact | decision | lesson | failure | warning. Add "slot" for a single-valued setting (e.g. "port"). ` +
    `If a finding rests on known findings (#ids from the brief), add "depends_on":[ids] so it is re-checked when they change. ` +
    `Report only what you verified; never invent evidence. Omit the line if there is nothing durable.`,
  // F1 (real-project study round 1: 9/70 real findings were false overclaims — "the only …",
  // "all validators …", "fails wholesale")
  `Universal words — "only", "all", "every", "no/none", "never", "last/latest" — need a repo-wide search as proof; ` +
    `otherwise scope the claim to where you checked ("in X.cpp, …"). State exactly what the code does, not more.`,
  // F5 (real-project study round 4, UNTESTED on held-out data): 4 of 6 false live brief
  // lines were plan interpretations ("this gap is T044's job", "must be authored for
  // this step"), which read wrong when briefed to other steps.
  `Record what the code, data and docs ARE — not what a step should do, and never relative to "this step" ` +
    `(a finding is briefed to other steps too). If a doc assigns work, quote where ("RESEARCH_TREE.md:243 assigns …").`,
];

// Per-part brief selection lives in src/brief.mjs (the Store's step brief uses it too).
export { splitParts, pickBrief } from '../src/brief.mjs';

// Brief side: relevant LIVE findings for a step, one line each (with #id so a new
// finding can cite what it was built on), conflicts and suspect ones called out.
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
export function formatFindingLines(findings) {
  if (!findings?.length) return [];
  return ['\nWhat the project already knows (recorded findings — verify any marked CONFLICT or SUSPECT before relying on it):',
    ...findings.map((f) => `- ${f.id != null ? `#${f.id} ` : ''}[${f.kind}] ${f.subject || '(general)'}: ${clip(f.claim, 200)}` +
      (f.status === 'suspect' ? '  ⚠ SUSPECT: something it was based on changed — re-check it' : '') +
      (f.conflicts_with?.length ? '  ⚠ CONFLICT: other reports disagree — verify' : ''))];
}

// ---- re-evaluation (truth maintenance, schema v5) ---------------------------
// One suspect finding (a Store.suspectQueue() item) → a self-contained prompt:
// the fact, WHY it is suspect (old → new value of what it rested on, the changed
// file, or the high-impact fact), and the RESOLVE contract. `tools` says whether
// the model can read the source (code) or must judge from the text (stories).
// `snippets`: [{ ref: "path:line", text }] — the cited lines as they read NOW (F3).
export function buildReevalPrompt(item, { tools = false, snippets = [] } = {}) {
  const why = (item.causes || []).map((c) => {
    if (c.file && /directory/.test(c.detail)) return `- a file was ADDED or REMOVED in a directory it rests on: ${c.file} ` +
      `(if the fact says "only", "last", "no …" or "all", check it against that directory as it is now)`;
    if (c.file) return `- the source file it rests on ${/missing/.test(c.detail) ? 'was DELETED' : 'CHANGED'}: ${c.file}`;
    const f = c.finding;
    if (!f) return `- ${c.detail}`;
    if (/high-impact/.test(c.detail)) {
      // a reached fact carries the link the reach model found (bench/reach A2)
      const link = /\(reach: (.+)\)$/.exec(c.detail)?.[1];
      return `- a NEW fact about "${f.subject}" changes what everything about it means: "${f.claim}"` +
        (link && link !== 'refers to it indirectly' ? `\n  This fact refers to "${f.subject}" indirectly: ${link}` : '');
    }
    if (/^contradicts /.test(c.detail)) return `- another recorded fact CONTRADICTS this one: #${f.id} "${f.now ? f.now.claim : f.claim}"` +
      `${/: (.+)$/.exec(c.detail)?.[1] ? ` (${/: (.+)$/.exec(c.detail)[1]})` : ''}. At most one can be right — check which, against the source.`;
    if (f.status === 'retracted') return `- fact #${f.id} it was built on turned out to be WRONG and was retracted: "${f.claim}"`;
    if (f.now) return `- fact #${f.id} it was built on changed. It said: "${f.claim}" — it NOW says: "${f.now.claim}"`;
    return `- fact #${f.id} it was built on changed: "${f.claim}" (${c.detail})`;
  });
  return [
    `A recorded fact may no longer be true, because something it was based on changed.`,
    ``,
    `FACT #${item.id} (subject: ${item.subject || 'general'}): "${item.claim}"`,
    ...(item.evidence?.length ? [`Recorded evidence: ${item.evidence.join('; ')}`] : []),
    ``,
    `Why it is suspect:`,
    ...(why.length ? why : ['- (no cause recorded)']),
    ``,
    ...(snippets.length ? [`The cited lines as they are NOW:`, ...snippets.map((s) => `--- ${s.ref}\n${s.text}`), ``] : []),
    // F3 (real-project study round 1: 7/45 settling misses were lenient confirms of
    // partly-false claims and revisions that kept a wrong clause)
    tools ? [`Check the fact against the CURRENT source with your tools before deciding. Check EACH part of it separately —`,
      `names, numbers, conditions, and words like "only", "all", "every", "no", "never", "last" (for those, search the whole`,
      `repository, not just the cited file). If ANY part is no longer exactly true, it must be revised (or retracted).`].join('\n')
      : `Re-read the fact in light of the change. Decide from what is given here; do not invent details.`,
    // The record-keeper question (bench/revision PREREG A2). v1 asked "is it provably
    // still true?" (→ unsure / rewrote everything); v2 asked "does the change
    // logically falsify it?" (→ confirmed anything merely POSSIBLE). The right test
    // is WHY the fact was recorded: a fact that held because of the old value
    // follows the new one; an independent fact is left exactly as it is.
    `Ask: knowing the new information, would a careful record-keeper still write THIS fact exactly as it is?`,
    `- If the fact was true BECAUSE of what changed (it followed from the old value, or assumed it), it must follow the new value.`,
    `- If the fact is independent of the change (it would be written the same either way), leave it exactly as it is.`,
    `- The new information is already recorded on its own — never add it to this fact just to mention it.`,
    `Decide:`,
    `- confirmed: it would still be written exactly as it is`,
    `- revised: it would now be written differently — give it as one atomic sentence about the same subject, changing only what the new information changes`,
    `- retracted: it would no longer be recorded at all, and nothing true is left to state`,
    `- unsure: only if you genuinely cannot tell${tools ? ' even after checking the source' : ''}`,
    ``,
    `The FINAL LINE of your output MUST be exactly:`,
    `RESOLVE: {"verdict":"confirmed|revised|retracted|unsure","claim":"the corrected fact (revised only)","reason":"what you checked, briefly"}`,
  ].join('\n');
}

// Reach: which OTHER facts does a high-impact fact affect, even though they never
// name its subject ("she", "the town doctor", a consequence of the old belief)?
// `known`: what was recorded about the subject by name (bench/reach A1) — without
// it the model can't tell that "the shopkeeper" IS Anna, only that "she" might be.
export function buildReachPrompt(fact, candidates, known = []) {
  return [
    `A new fact changes what everything about "${fact.subject}" means:`,
    `  "${fact.claim}"`,
    ``,
    ...(known.length ? [`What was recorded about "${fact.subject}" before (tells you their roles, titles and relationships):`,
      ...known.map((k) => `  - ${k.claim}`), ``] : []),
    `Facts that name "${fact.subject}" are already being re-checked. Below are OTHER recorded facts.`,
    `List the ones the new fact may make false or misleading — typically because they refer to "${fact.subject}"`,
    `INDIRECTLY (a pronoun like "she"/"he"/"they", a role or title, a nickname) or describe something that depended on what`,
    `was believed before. Do NOT list facts that are unrelated to "${fact.subject}", or that stay true as written.`,
    ``,
    ...candidates.map((c) => `#${c.id} [${c.subject || 'general'}] ${c.claim}`),
    ``,
    `For each one, say in a few words HOW it refers to "${fact.subject}" (e.g. "'she' is ${fact.subject}").`,
    `The FINAL LINE of your output MUST be exactly (an empty list is fine):`,
    `REACH: [{"id": <id>, "why": "<the link>"}, ...]`,
  ].join('\n');
}

// Consistency audit: which of these facts (all about the same file or subject)
// contradict each other? Pure text judgment — deciding which one is TRUE is left to
// re-evaluation, which reads the source.
export function buildAuditPrompt(group) {
  return [
    `These recorded facts are all about the same part of a codebase (${group.key.replace(/^(file|subject):/, '')}).`,
    `Find the pairs that CONTRADICT each other: one codebase cannot make both true at once (different values, "X" vs "not X",`,
    `"only A" vs "also B", "hard-wired" vs "configurable", …). Facts that are merely different, overlapping, or one more`,
    `detailed than the other are NOT contradictions. Do not judge which one is right.`,
    `Before listing a pair, test it: picture ONE codebase where both sentences hold. If you can, it is NOT a contradiction`,
    `(e.g. "Z01 is the only zone recipe" and "Z02 has no recipe" AGREE; "retries 3 times" and "retries up to 3 times`,
    `with backoff" AGREE; "is 11" and "is 12" CLASH).`,
    `For each pair quote the clashing words from each fact exactly as written.`,
    ``,
    ...group.findings.map((f) => `#${f.id} [${f.subject || 'general'}] ${f.claim}`),
    ``,
    `The FINAL LINE of your output MUST be exactly (an empty list is fine, and is the usual answer):`,
    `CONTRADICTIONS: [{"a": <id>, "b": <id>, "a_says": "<exact words from a>", "b_says": "<exact words from b>", "why": "<why both cannot hold>"}, ...]`,
  ].join('\n');
}
// claims: optional {id: claim} — a pair whose a_says/b_says is given but is not in that
// fact's text is dropped (a misread, not a clash).
export function parseAudit(text, allowed = null, claims = null) {
  const s = String(text ?? '');
  const at = s.lastIndexOf('CONTRADICTIONS:');
  if (at < 0) return { error: 'no CONTRADICTIONS marker' };
  const open = s.indexOf('[', at);
  if (open < 0) return { error: 'CONTRADICTIONS has no [list]' };
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '[') depth++; else if (ch === ']' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return { error: 'CONTRADICTIONS list is not closed' };
  let items; try { items = JSON.parse(s.slice(open, end + 1)); } catch { return { error: 'CONTRADICTIONS is not valid JSON' }; }
  if (!Array.isArray(items)) return { error: 'CONTRADICTIONS is not a list' };
  const ok = allowed ? new Set(allowed) : null;
  const num = (v) => (typeof v === 'number' ? v : /^\s*#?\s*\d+\s*$/.test(String(v ?? '')) ? Number(String(v).replace(/\D/g, '')) : NaN);
  const flat = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = new Set(), pairs = [];
  let dropped = 0;
  for (const it of items) {
    const a = num(it?.a), b = num(it?.b);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b || (ok && (!ok.has(a) || !ok.has(b)))) continue;
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(k)) continue;
    const quoted = (id, q) => !claims || !flat(q) || flat(claims[id]).includes(flat(q));
    if (!quoted(a, it.a_says) || !quoted(b, it.b_says)) { dropped++; continue; }
    seen.add(k); pairs.push({ a, b, why: String(it.why ?? '').trim().slice(0, 200) });
  }
  return { pairs, dropped };
}

// → { ids, why: {id: link}, ignored }. Accepts [{"id":N,"why":"…"}] (bench/reach A2)
// or a bare [N, …] list; ids outside `allowed` are ignored.
export function parseReach(text, allowed = null) {
  const s = String(text ?? '');
  const at = s.lastIndexOf('REACH:');
  if (at < 0) return { error: 'no REACH marker' };
  const open = s.indexOf('[', at);
  if (open < 0) return { error: 'REACH has no [list]' };
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return { error: 'REACH list is not closed' };
  const body = s.slice(open, end + 1);
  let items;
  try { items = JSON.parse(body); } catch { items = (body.match(/\d+/g) || []).map(Number); }
  if (!Array.isArray(items)) return { error: 'REACH is not a list' };
  const why = {}, all = [];
  for (const it of items) {
    // models echo the prompt's "#12" form — accept "#12", "12" and 12 alike
    const raw = typeof it === 'object' && it ? it.id : it;
    const id = typeof raw === 'number' ? raw : /^\s*#?\s*\d+\s*$/.test(String(raw ?? '')) ? Number(String(raw).replace(/\D/g, '')) : NaN;
    if (!Number.isInteger(id) || all.includes(id)) continue;
    all.push(id);
    if (it && typeof it === 'object' && it.why) why[id] = String(it.why).trim().slice(0, 200);
  }
  const ok = allowed ? new Set(allowed) : null;
  const ids = ok ? all.filter((i) => ok.has(i)) : all;
  return { ids, why: Object.fromEntries(ids.filter((i) => why[i]).map((i) => [i, why[i]])), ignored: ok ? all.filter((i) => !ok.has(i)) : [] };
}

// Evidence "path:line" / "path:10-14" → the lines around it as they read now, from
// `readFile(path) → text|null` (kept pure: the caller supplies file access).
export function evidenceSnippets(evidence, readFile, { around = 3, max = 4 } = {}) {
  const out = [];
  for (const e of evidence || []) {
    const m = /^([\w@.~/\\-]+\.[a-z0-9]{1,6}):(\d+)(?:-(\d+))?/i.exec(String(e).trim());
    if (!m) continue;
    const text = readFile(m[1]);
    if (text == null) { out.push({ ref: m[0], text: '(file no longer exists)' }); continue; }
    const lines = text.split('\n'), a = Math.max(1, Number(m[2]) - around), b = Math.min(lines.length, Number(m[3] || m[2]) + around);
    out.push({ ref: m[0], text: lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n').slice(0, 1500) });
    if (out.length >= max) break;
  }
  return out;
}

// The LAST `RESOLVE:` marker anywhere, then its JSON object by string-aware brace
// matching (models glue markers onto prose lines — the FINDINGS lesson).
export function parseResolve(text) {
  const s = String(text ?? '');
  const at = s.lastIndexOf('RESOLVE:');
  if (at < 0) return { error: 'no RESOLVE marker' };
  const open = s.indexOf('{', at);
  if (open < 0) return { error: 'RESOLVE has no JSON object' };
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return { error: 'RESOLVE JSON is not closed' };
  let o;
  try { o = JSON.parse(s.slice(open, end + 1)); } catch (e) { return { error: `RESOLVE JSON invalid: ${e.message}` }; }
  const verdict = String(o.verdict ?? '').trim().toLowerCase();
  if (!['confirmed', 'revised', 'retracted', 'unsure'].includes(verdict)) return { error: `bad verdict "${o.verdict}"` };
  const claim = String(o.claim ?? '').trim();
  if (verdict === 'revised' && !claim) return { error: 'revised without a claim' };
  return { verdict, claim: verdict === 'revised' ? claim : '', reason: String(o.reason ?? '').trim().slice(0, 500) };
}

// The inject-mode result contract: the agent's final line must be
// "VERDICT: pass|fail|partial — <what_tried>". No marker → FAIL (an agent that
// didn't follow the contract can't be trusted to have finished the step).
export function parseVerdict(text) {
  // Cut the FINDINGS array out first and break the line where it ended. That
  // (a) recovers a VERDICT glued onto the end of the array — 8 of 18 real agents
  // did that, and each would have been recorded as a FAIL despite passing — and
  // (b) stops contract text QUOTED inside a finding from being read as the
  // verdict. The marker must still exist: a missing VERDICT is still a fail.
  const s = String(text || '');
  const span = findingsSpan(s);
  const rest = span && span.body !== null ? `${s.slice(0, span.start)}\n${s.slice(span.end)}` : s;
  const lines = rest.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*VERDICT:\s*(pass|fail|partial)\s*(?:[—–-]+\s*(.*))?$/i.exec(lines[i]);
    if (m) return { verdict: m[1].toLowerCase(), what_tried: (m[2] || '').trim() || null };
  }
  return { verdict: 'fail', what_tried: null };
}

// VERIFY: <command> — optional first-line convention in step.context, same shape
// as the RAG: line (docs/RAG.md §10): `/^RAG:\s*.../m`. Declares an objective,
// post-hoc check the runner enforces AFTER the agent exits, in both MCP and
// inject modes. Left in step.context verbatim (never stripped) — same "travels
// inside context, forwarded as-is" design as RAG:.
export function parseVerify(context) {
  const m = /^VERIFY:\s*(.+)$/m.exec(String(context || ''));
  if (!m) return null;
  const cmd = m[1].trim();
  return cmd || null;
}

// Run a step's VERIFY command. Guard (per the step brief): VERIFY commands come
// from the step author — trusted user/orchestrator input, the same trust class
// as step context — so shell:true is deliberate (lets `&&`, pipes, etc. work in
// the command string) and not treated as a shell-injection boundary here.
export function runVerify(cmd, { cwd = process.cwd(), timeoutMs = 10 * 60 * 1000 } = {}) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs });
  const combined = `${r.stdout || ''}${r.stderr ? '\n' + r.stderr : ''}`.trim();
  return { ok: r.status === 0, code: r.status, tail: combined.slice(-500) };
}

// The gate: an agent-claimed "pass" with a failing VERIFY is downgraded to
// "fail" and the command's output tail (~500 chars) is appended to resultText.
// No-op (verdict/resultText unchanged) when there's no VERIFY command, or the
// claimed verdict wasn't "pass" in the first place — a claimed fail/partial is
// already not a pass, nothing to override.
export function applyVerifyGate(verdict, resultText, verifyCmd, opts = {}) {
  if (!verifyCmd || verdict !== 'pass') return { verdict, resultText, verified: null };
  const v = runVerify(verifyCmd, opts);
  if (v.ok) return { verdict, resultText: `${resultText} | VERIFY ok: \`${verifyCmd}\``, verified: true };
  return {
    verdict: 'fail',
    resultText: `${resultText} | VERIFY FAILED (\`${verifyCmd}\` exit ${v.code}): ${v.tail}`,
    verified: false,
  };
}

// Per-attempt usage line, persisted into the attempt's `result` field (in
// addition to the runner's existing end-of-run console summary).
export function formatUsageLine({ tin = 0, tout = 0, cost = 0, turns = 0, model } = {}) {
  return `usage: in=${tin} out=${tout} cost=$${Number(cost || 0).toFixed(4)} turns=${turns} model=${model || 'default'}`;
}

// MCP mode has no hook into record_attempt (it runs inside the agent, via MCP
// tools) — so usage is stitched on after the fact: if a NEW attempt landed on
// this step while the agent ran, append the usage line to ITS result column
// directly (db is the Store's public DatabaseSync handle — same direct-access
// pattern test/smoke.mjs already uses for schema checks). If no new attempt
// appeared (agent errored before ever calling record_attempt), there's nothing
// to append to — skip and let the caller log a console note.
export function appendUsageToLatestAttempt(db, stepId, sinceAttemptId, usageLine) {
  const row = db.prepare('SELECT id, result FROM attempts WHERE step_id=? ORDER BY id DESC LIMIT 1').get(stepId);
  if (!row || row.id <= sinceAttemptId) return { appended: false };
  db.prepare('UPDATE attempts SET result=? WHERE id=?').run(`${row.result}\n${usageLine}`, row.id);
  return { appended: true, attemptId: row.id };
}
