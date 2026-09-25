---
name: plan-ledger-brain
description: >-
  Use plan-ledger's brain — a truth-maintained store of verified project facts — while coding in
  Cursor: read what the brain knows before touching code, write back only what you verified (with
  path:line evidence), correct facts the code contradicts, and ingest past conversations into it.
  Use when working a plan-ledger step, when the user says "use the brain", "what do we know about
  X", "remember this", "ingest this conversation/chat", or before changing code in a project the
  brain covers.
---

# plan-ledger brain (Cursor)

The brain is plan-ledger's **findings** store: small, atomic facts about a project ("Export writes
CSV through src/export.js writeCsv()"), each with evidence, the step it was learned in, and what it
is **built on**. It is truth-maintained: when a fact is revised or retracted, everything built on
it is marked **suspect** and re-checked, and facts linked to files go stale when those files change.
A plan step's brief (`next_step` / `ready_steps` / `get_step`) carries the live facts that matter
for it under `brain`.

Your job is to **use** it (so you do not rediscover what is known), and to **feed** it — only with
what you verified — so the next agent starts ahead. This skill complements `/plan-ledger` (the plan
loop); use both together.

## Bridge invocation (not MCP)

Same JSON CLI bridge as `/plan-ledger` (installed paths, refreshed by `npm run sync:global-skill`):

```powershell
& "{{PLAN_LEDGER_NODE}}" "{{PLAN_LEDGER_CLI}}" <operation> --input '<json-args>'
```

Success → stdout `{ "ok": true, "result": … }`; failure → nonzero exit and `{ "ok": false, "error": … }`.
Brain operations:

| Operation | Use | Args |
|---|---|---|
| `recall` | what the ledger remembers about a topic (plans, notes, findings) | `{"query":"export csv","limit":8}` |
| `query_findings` | live facts matching words / a subject | `{"query":"auth token","subject":"module:auth","limit":20}` |
| `absorb_findings` | write verified facts back | `{"step_id":123,"source":"cursor","findings":[…]}` |
| `suspect_findings` | facts waiting to be re-checked | `{"limit":20}` |
| `resolve_finding` | settle one: confirm / revise / refute | `{"finding_id":42,"verdict":"revised","claim":"…","reason":"…","evidence":["src/x.ts:10"]}` |
| `retract_finding` | a fact that is simply wrong | `{"finding_id":42,"reason":"…"}` |

(When working inside the plan-ledger checkout with its repo MCP configured, the same calls exist as
`mcp__plan-ledger__*` tools — prefer the bridge everywhere else.)

## The loop

**1. Read before you touch code.** Get the step (`next_step` / `get_step`) and read its `brain`
facts. Then `query_findings` / `recall` for each module or file you are about to change.
- **Active** facts are established: use them instead of re-exploring. If your change *depends* on
  one and checking it is cheap (one file read), check it — a wrong fact caught now is cheap.
- **SUSPECT** or **CONFLICT** facts: never build on them. Check the code; then settle them (step 4).
- The brain does not replace reading the code you edit. It tells you where to look and what was
  already learned the hard way.

**2. Work.** Normal coding, verification, tests.

**3. Write back what you verified** — at the end of the step (or after an investigation), with
`absorb_findings`. Record what the next person must know that the code does not make obvious:
where things live, how a system actually works, constraints, conventions, pitfalls, decisions and
why. 3–10 findings for a real step; zero is fine for a trivial one.

```json
{"step_id": 123, "source": "cursor", "findings": [
  {"kind": "fact", "subject": "module:export", "claim": "Export writes CSV through writeCsv() in src/export.js; every column is escaped there, never at the call site",
   "evidence": ["src/export.js:12", "src/export.js:40"], "depends_on": [57]},
  {"kind": "warning", "subject": "module:export", "claim": "writeCsv() holds the whole file in memory; exports over ~200k rows OOM the worker",
   "evidence": ["src/export.js:18", "test/export.test.js:77"]},
  {"kind": "decision", "subject": "feature:export-button", "claim": "The export button calls the existing /api/export route rather than a new one, so permissions stay in one place",
   "evidence": ["src/routes/export.ts:5"]}
]}
```

Rules — a fact that is wrong is worse than no fact:
- **Only what you verified in the code or by running it.** Never plans, guesses, intentions, or
  "should". Evidence is `path:line` (repo-relative) or a command + result.
- **One atomic truth per finding**, specific enough to be checked. Name the subject consistently:
  `module:<name>`, `file:<path>`, `feature:<name>`, `api:<route>`, `convention:<topic>`, `tool:<name>`.
- **Don't repeat** what the brain already holds (you read it in step 1). If you learned that a
  known fact CHANGED, resolve that fact (step 4) instead of adding a contradicting one.
- **`depends_on`**: the `#id`s of known facts this one relies on — it is what makes truth maintenance
  work (if #57 is ever revised, this fact is re-checked).
- **`slot`** only for single-valued attributes (a new value replaces the old): e.g. `"slot":"version"`.
- **`"impact":"high"`** for a revelation that changes what earlier facts mean (a module was
  replaced, an assumption turned out false) — the brain then re-checks what it touches.
- `kind`: `fact` (how things are), `decision` (what was chosen and why), `warning` (a pitfall).

**4. Correct the brain when the code disagrees.** A fact you found wrong, or a suspect one you
checked:
- still true → `resolve_finding` `"verdict":"confirmed"` with evidence;
- partly true → `"verdict":"revised"` with the corrected `claim` and evidence;
- false → `"verdict":"refuted"` (or `retract_finding` if it should never have existed).
Correcting is as valuable as adding: facts built on a corrected one are re-checked automatically.

**5. Record the step** as `/plan-ledger` says (`record_attempt`, `set_step_status`, carry-forward).

## Ingest a conversation into the brain

When the user asks to ingest a past chat (a Cursor or Claude Code conversation, an exported
transcript, a design discussion) so future coding starts from what it established:

1. Read the transcript. Skip small talk, dead ends that were abandoned, and anything later undone.
2. Pull out **durable project truths**: how systems work, decisions and their reasons, conventions,
   constraints, known bugs and pitfalls, where things live, commands that work.
3. **Verify each one against the current code** before absorbing it — conversations are full of
   plans that never shipped and code that has since changed. Keep only what the code confirms; a
   decision can be kept if the code reflects it. Drop the rest (or record a `warning` if the
   conversation reveals a real pitfall the code still has).
4. `absorb_findings` with evidence citing both the code (`path:line`) and the conversation
   (`"chat:<file or title>#<turn>"`), `"source":"conversation"`, and the `step_id` of a step in a
   plan for that project (create an "Ingest: <topic>" step with `add_step` if none fits).
5. Tell the user what you recorded, what you dropped because the code no longer matches, and any
   brain facts you corrected on the way.

## Priming a plan (optional, costs model calls)

`node "{{PLAN_LEDGER_REPO}}/scripts/learn.mjs" --plan <id>` (or `--steps 12,13`) sends a read-only
agent to investigate the code each pending step will touch; every fact it reports is independently
verified against the source before it is absorbed. `--dry-run` shows what it would record. Needs the
project root set (`set_project_root`) and a model key in the environment; say so and ask before
spending.
