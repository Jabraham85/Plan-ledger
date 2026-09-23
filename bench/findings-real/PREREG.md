# Pre-registration — findings write-back on REAL agent output

Written 2026-09-22, **before any run**. Follows plan #134 (findings write-back).
The synthetic benchmark (`scripts/eval-findings.mjs`) has two weaknesses this
experiment removes:

1. **Authorship bias:** the dedup and its test data were written by the same
   agent. Here the findings are written by independent agents.
2. **Storage-only:** the synthetic benchmark measured storage, not whether the
   brain helps anyone. Part B measures the outcome.

## Setup (fixed in advance)

- **Codebase under study:** a frozen snapshot of plan-ledger's `src/`,
  `scripts/`, `web/`, `docs/`, `package.json` and `README.md`. Agents are
  read-only (`Read, Grep, Glob`), with `--strict-mcp-config` (no MCP servers, so
  no route to any live DB) and `--setting-sources project` (no user hooks).
- **Model:** `sonnet` for every agent; `opus` for the judge.
- **Spend cap:** $15 total across all phases, enforced by the harness before
  each call. Every call is cached to `results/`, so a re-run never spends twice.
- **Every run is reported**, including errors and budget stops.

## Part A — dedup on real findings

- 6 topics × 3 independent agents = 18 investigations. Each agent gets the same
  brief with the same `FINDINGS_INSTRUCTIONS` the runner uses, and reports 3–8
  findings.
- **Ground truth:** a blind judge (`opus`, read-only on the snapshot), one call
  per topic. It (a) clusters that topic's findings into "same underlying fact"
  groups and (b) labels each finding `true` / `false` / `unverifiable` against
  the code. The judge never sees route outcomes. I spot-check a random sample of
  its truth labels by reading the code myself and report the agreement rate.
- **Replay:** every route (`exact`, `near`, `guarded`, `full`, `strict`,
  `strict_full`) at 0.7, over 6 arrival orders (agent order shuffled; each
  agent's own order kept). Offline, zero cost.

**Metrics:**
- **Wrong merge** — a finding merged into a row whose creator the judge put in a
  different cluster.
- **Fragmentation** — clusters stored as more than one active row.
- **Excess rows** — active rows minus clusters.
- **False findings stored as active.**

**H1 (dedup safety).** `strict_full` wrong merges ≤ 1% of its merges.
*Fail →* the default is unsafe on real data; switch to the safest route that
passes, or to `exact`.

**H2 (agent truthfulness).** Reported as the share of findings the judge labels
`true`. *If < 90% →* recommend a verification gate before absorb (for example,
evidence must cite a file:line that exists).

## Part B — does the brain help?

- **12 short-answer questions** (2 per topic), each with an exact answer
  verified by hand in the code before any run (see `questions.json`). Graded
  mechanically from the agent's `ANSWER:` line — no judgement involved.
- **Arms:**
  - **NONE:** the agent must find the answer in the code.
  - **BRAIN:** the same prompt plus the runner's brief — the top-5 findings from
    a brain built by absorbing all of Part A with `strict_full` (exactly
    `formatFindingLines(queryFindings(...))`).
- 12 questions × 2 arms × 2 reps = 48 runs, with arms interleaved.

**Metrics:** accuracy, cost (USD), turns, total input tokens, output tokens,
wall time — per arm, plus paired per-question differences.

**H3 (value).** BRAIN is non-inferior on accuracy (at most 1 fewer correct
answer of 24) **and** at least 25% cheaper in mean cost per question.
- *Accuracy lower by more than 1 →* the brain is misleading agents. Inspect
  whether the briefs carried false findings (a truth-gate need), and do not
  claim value.
- *Cheaper by less than 25% →* no material saving on this workload; report it
  as such.

## Amendment 1 — 2026-09-22, before any data was collected

The headless `claude` CLI's OAuth token expired: every call returned 401, $0
was spent, and no results exist. The user offered the DeepSeek API instead.
Changes, all fixed **before** any data:

- **Agents** (Part A investigators and Part B answerers): `deepseek-v4-pro`,
  run through a small read-only agent loop in `run.mjs` with three tools —
  `list_files`, `read_file`, `grep` — each confined to the snapshot. Thinking
  is disabled (the same setting the gemma-harness uses for DeepSeek memory
  operations). At most 30 turns per run.
- **Judge:** Claude Opus, run as blind in-session subagents. It gets the exact
  judge prompt the harness writes to `results-deepseek/judge/<topic>.prompt.md`
  and read-only access to the snapshot. It never sees route outcomes. This also
  improves on the original design: the judge is now a *different model family*
  from the agents, so there is no self-grading.
- **Part B repetitions:** 2 → **5** per question per arm (120 runs). The cheaper
  model buys statistical power.
- **Cost** = DeepSeek-reported usage (cache-hit / cache-miss / output tokens) ×
  the published rates on 2026-09-22 (`deepseek-v4-pro`: $0.022 / $0.66 / $1.98
  per 1M), doubled during DeepSeek peak hours (Mon–Fri UTC 01:00–04:00 and
  06:00–10:00). H3's cost test is relative between arms, so absolute rates
  largely cancel out.
- **Cap** stays **$15**, estimated from usage before each turn.

**Hypotheses H1–H3 and their thresholds are unchanged.**

**Scope change.** H1 is model-agnostic. H2 and H3 now measure **DeepSeek v4-pro
agents**. The briefing mechanism is not Claude-specific, but magnitudes for
Claude agents need the CLI replication, which the same harness supports with
`BENCH_PROVIDER=claude` and keeps in a separate `results-claude/`.

**Privacy.** The plan-ledger source snapshot is sent to DeepSeek. That is the
user's own code, sent at the user's offer.

## Amendment 2 — 2026-09-22, after Part A outputs, before the judge and Part B

**Observed.** The strict single-line parser recovered findings from only 11 of
18 Part A agents (80 findings), and only 7 of 18 agents followed the output
contract exactly. The losses were all *format*, not content:

- 4 agents glued `VERDICT: …` onto the end of the FINDINGS array.
- 4 agents put `FINDINGS:` mid-line after prose.
- 3 agents omitted the VERDICT entirely.

Under the production runner, 10 of 18 steps would have been recorded as FAIL.

**Change.** `scripts/runner-lib.mjs` now:

- locates the FINDINGS array anywhere, with string-aware bracket matching, so a
  quoted marker or `]` inside a claim cannot break it; multi-line arrays are
  accepted;
- cuts the array out before searching for the VERDICT, which recovers glued
  verdicts.

A **missing** VERDICT still fails. Covered by 10 new unit cases, each built from
a real failure mode.

**Effect.** All 18 cached outputs were re-parsed; **no model call was re-run**.
Result: 18 of 18 agents yield findings, **144 findings**, 15 of 18 verdicts
recovered. The three agents with no VERDICT still read as fail, correctly.

**Contract compliance is reported as a separate result** (7/18 strict).

**Part B grading.** Same tolerance, fixed **before any Part B run**: the answer
is the last `ANSWER:` anywhere in the output, not only at the start of a line.

**Snapshot artifact.** The snapshot omitted the repo-root `sea-config.json`, so
t4 agents correctly report it as "missing" relative to the snapshot. The
snapshot stays frozen, because the judge verifies against what the agents
actually saw. Such findings are true for the snapshot and false for the live
repo; they will be noted in the report.

Hypotheses unchanged.

## Known limits, stated up front

Single codebase, a small number of questions, one model family. Part B
questions ask about things Part A investigated, which is the brain's best case
(knowledge reuse). A "no relevant findings" case is not tested. The results
support claims about this setup, not universal ones.
