# Findings — the brain's write-back channel

Added 2026-09-22 (plan #134, schema v4). The orchestrator loop is now closed:
plan-ledger **briefs** an agent with what the project already knows, the agent
does the work, and the durable things it **learned** are absorbed back —
without duplicating what the ledger already holds. Absorbing makes **zero model
calls**.

```
          ┌──────────── brief: lessons + relevant ACTIVE findings ────────────┐
          │                                                                    ▼
   plan-ledger (SQLite WAL)                                              agent does the step
          ▲                                                                    │
          └──── absorb: dedup · supersede · flag conflicts (no model) ◄── FINDINGS line /
                                                                         absorb_findings tool
```

## What a good finding is

A finding is **one atomic, durable truth**, anchored to a **subject** and backed
by **evidence**. It should still be true tomorrow. It is *not* a diary entry
("I edited the file") — attempts and carry-forward already cover that.

| field | meaning |
|---|---|
| `claim` *(required)* | the truth, e.g. `recall() only returns ACTIVE findings` |
| `subject` | stable anchor: a path, `path#symbol`, config key, or topic. Dedup and correction are scoped by subject — always set it. |
| `kind` | `fact` (default) · `decision` · `lesson` · `failure` · `warning` |
| `evidence` | where it was verified: `file:line`, a command, a test name |
| `slot` | for a single-valued aspect (a port, a default, a version): a newer finding with the same subject+slot supersedes the old one |
| `supersedes` | id of an existing finding this one corrects |

Carry-forward is for **the next step**. Findings are for **the project**:
`recall` and every future brief surface them.

## Tools

- `absorb_findings(findings, plan_id?|step_id?, source?, dry_run?)` → a
  per-item outcome: `created` · `duplicate` · `near_duplicate` · `superseded` ·
  `conflict` · `rejected` (with the reason).
- `query_findings(subject?, kind?, status?, query?, …)` — `subject` is a
  prefix; `status: "any"` shows the superseded and retracted history.
- `retract_finding(finding_id, reason)` — a finding that is wrong, with no
  replacement. To replace one, absorb the correction with `supersedes`.
- `recall` includes **active** findings (type `finding`). Superseded and
  retracted findings never resurface; findings in a disagreement come back with
  status `conflict`.

Headless runs: inject-mode agents may end with one line **before** the verdict:

```
FINDINGS: [{"kind":"fact","subject":"src/db.mjs#recall","claim":"…","evidence":"src/db.mjs:958"}]
VERDICT: pass — …
```

The runner absorbs it (`source: runner:<role>`). A malformed line is logged and
ignored — it never fails the step. MCP-mode agents call `absorb_findings`
themselves.

## How dedup decides (default route `strict_full`, threshold 0.7)

In order, per finding, inside one transaction (items in the same batch see each other):

1. **Exact** — the same canonical claim on the same subject → merge: evidence
   is unioned and `seen_count` goes up. The canonical form keeps **numbers** and
   **polarity**, and folds antonyms (`disabled` ≡ `not enabled`).
2. **Explicit** — `supersedes: <id>` → the old finding is superseded; history is kept.
3. **Slot** — same subject + slot with a new value → the newest wins, **unless**
   the value was already superseded before (the *revert guard*): that is most
   likely a stale report, so it is flagged as a conflict instead of applied.
4. **Near** — a paraphrase of a known finding (same subject + kind, token
   Jaccard ≥ 0.7) merges, but only when **numbers and polarity agree**.
   Otherwise it becomes a **conflict**: both are kept and cross-linked.
   Two claims that *swap* words ("re-reads **step** status" vs "re-reads
   **plan** status") never merge — the *substitution guard*.
5. Otherwise → **created**.

Nothing is ever deleted.

## Evidence for the default

`node scripts/eval-findings.mjs [--detail]`: 21 facts × 5 seeds = 520
synthetic reports with ground truth, covering repeats, paraphrases, value
updates with and without slots, polarity flips, one-word-different *distinct*
facts, and stale re-reports.

| route | wrong merges | current value kept | stale shown unflagged | excess rows | recall@3 |
|---|---|---|---|---|---|
| exact | 0 | 100% | 65 | 177 | 100% |
| near @0.7 (no guards) | **160** | 61% | 40 | 32 | 59% |
| full @0.7 (initial design) | 32 | 86% | 6 | 43 | 86% |
| **strict_full @0.7** | **0** | **100%** | **1** | **73** | **99%** |

Two findings from the run shaped the design: unguarded near-dup destroyed 128
value updates, and "newest report wins" let stale reports overwrite current
values. Those two results are why the guards exist.

## Known limits

- **Lexical, not semantic.** Heavy paraphrases and synonym swaps (`one ranking`
  / `single ranking`) are stored as separate rows. That is bloat, not loss.
- Word-valued changes without a `slot` (`mode is fast` → `mode is careful`)
  look like two distinct facts. Use a `slot` for settings.
- The fixture was written by the same agent that wrote the dedup. Re-run the
  evaluation on **real** findings once some accumulate.

## Truth maintenance (schema v5)

Findings record what they were **built on**. When that changes, the findings built on
it turn **suspect**. They are briefed with a warning, never as fact, until they are
re-evaluated.

**What a finding can be built on:**

- **Files.** Paths in `subject`/`evidence`, or given in `files`, are linked by content
  hash when the finding is absorbed with a `root`.
- **Other findings.** `depends_on: [ids]`, or linked automatically from the brief the
  agent was shown (`briefed`) when a finding shares its subject or wording.

**What makes a finding suspect:**

- `checkStale()` / `check_stale`: a linked file changed or vanished.
- A finding it rests on is **superseded, revised or retracted**. This goes **one hop**
  at a time, and continues only through a dependent whose claim actually changed, so a
  confirmation stops the cascade.
- `impact: "high"` ("the princess is a frog"): every finding on that subject, on a
  sub-aspect of it, or naming it.

**Settling it** — `resolve_finding` / `Store.resolveFinding`:

| verdict | effect |
|---|---|
| `confirmed` | active again, re-anchored to the current files |
| `revised` | replaced by a new claim (history kept); re-opens ITS dependents |
| `retracted` | no longer true; re-opens its dependents |
| `unsure` | stays suspect; the reason is logged |

Also:

- Editing a live finding is a `revised`.
- An exact re-report of a suspect finding confirms it.

**Automatic re-evaluation:**

```
node scripts/reevaluate.mjs --root <project dir>   # code: model reads the source (read-only tools)
node scripts/reevaluate.mjs --no-tools             # notes/stories: judged from the text
node scripts/reevaluate.mjs --dry-run              # print the prompts, change nothing
```

**Measured** (`bench/revision/ANALYSIS.md`, pre-registered, DeepSeek v4-pro):

- **Code:** detection exact, changed facts fixed 36/36, false alarms cleared 99/99, and
  the brain ended 98–100% correct against 70% without truth maintenance.
- **Stories:** 85% settled right on held-out scenarios; the errors are mostly "unsure",
  which stays flagged.
- **Reach** (`bench/reach/ANALYSIS.md`): the sweep only finds facts that *name* the subject, so
  `reevaluate` first asks the model which OTHER facts refer to it indirectly ("she", "the town
  doctor"). It sees what was known about the subject and returns the link per fact, which
  re-evaluation is then shown. Held-out: 27/27 hidden facts found, 0/27 false alarms, 18/18
  must-change facts fixed, 0/27 unrelated facts changed.

**Checks that run on the cited source:**

- **Verify on ingest.** `scripts/learn.mjs` learns facts from a finished step, checks each one against the source in a staging store, and keeps only the verified ones (`source learn:<id>+verified`).
- **Folder listings.** A claim like "only Z01 exists" rests on a directory listing. When a file appears there, the claim turns suspect.
- **Clause by clause.** Re-evaluation is shown the cited lines as they read NOW, and must check each part of a compound claim.

**Consistency audit** (`node scripts/reevaluate.mjs --audit --root <dir>`):

Dedup only catches near-identical wording, so two facts about the same code can quietly disagree ("hard-wired to Z01" vs "takes a -Map parameter"). The audit handles this in four steps:

1. It groups live facts by the file they rest on (otherwise by subject).
2. One text-only call per group names the pairs that cannot both be true. It must quote the clashing words from each fact, and a misquote is dropped.
3. `markContradiction` cross-links each pair and re-opens both sides. Re-evaluation, reading the source, then decides which one stands.
4. If both come back confirmed, the pair was a false alarm and is unlinked (a `consistent` event).

**On a real, private game codebase (UE5, ~100 live facts), pre-registered, with blind judges:**

- **Learning from history:** held-out briefs came out 91–95% true, against 70% without truth maintenance. Verifying on ingest raised that to 98%.
- **Seeded audit benchmark** (10 planted contradictions and 5 agreeing restatements, 3 runs):
  - 30/30 planted contradictions found;
  - 1 of 48 flags false with the current prompt, against 3 of 49 before it.
  - The first prompt flagged 2 false pairs on the live facts. The current one flags none, and re-evaluation had confirmed both sides of each false pair anyway.

## Seeing the brain: the Graph explorer

The board (`node web/server.mjs`, header button **◉ Graph**) draws three views:

| view | what it shows |
|---|---|
| **Brain** | Facts as dots coloured by status. Squares are the files they rest on (sized by how many facts rest on them, coloured by repo area). Diamonds are the steps they were learned in. Arrows mean "built on"; dashed red means "conflicts". |
| **Plan steps** | A plan's steps with `next` / `builds_on` / `blocks` links, plus other plans they reference. |
| **Code map** | The highest-degree nodes of a plan's code graph. |

**Navigation:**

- **Search and filter:** `/` searches, and Enter jumps to the next match. Status/type chips filter the view. The brain view can be grouped by step or by area.
- **Minimap:** click or drag it to move the view.
- **Arrow keys:** walk to the linked node in that direction.
- **Shift-click:** shows the path from the selection to that node. It takes the cheapest chain of links and prefers "built on / rests on" over "learned in the same step".
- **`n` / `N`:** cycle through facts that are suspect or in conflict.
- **`e` and `1` `2` `3`:** focus on the selection's neighbourhood, 1–3 hops deep.
- **`[` `]`:** back and forward through what you selected.
- **Deep links:** `#graph/<brain|steps|code>/<plan>/<node>`.
- **`?`:** lists every key.

The detail panel shows a fact's evidence, provenance, what it is built on, what is built on it, its conflicts, revisions and history. **Confirm / Revise / Retract** edit the memory in place, and a revision or retraction re-opens what was built on it.
