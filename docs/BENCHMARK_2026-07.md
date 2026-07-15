# Benchmark 2026-07 — Vanilla agent vs plan tool (plan #97 step 3)

**Question (verbatim from `docs/BENCHMARK_DESIGN.md`):** *On one identical, objectively-gradable
coding task, how does a single vanilla `claude -p` session (ARM A) compare against the plan tool —
architect decomposition + role-tagged steps executed headless by `scripts/runner.mjs` (ARM B) — on
pass rate, tokens, cost, wall time, and blind-reviewed diff quality?*

**Verdict (n=1, INDICATIVE — not significant):** On this task the **vanilla arm won on every axis**.
It scored **30/30** vs the plan tool's **29/30**, at **~5.4× lower cost** ($1.03 vs $5.57), **~5.0×
fewer input tokens**, **~5.2× less wall time** (191 s vs 984 s), and **~6.2× fewer turns**. The plan
tool produced a correct-structured, cleanly-decomposed solution and its plan completed 6/6 with no
retries or budget stop — but it cost far more and shipped one latent boundary bug that its
per-step self-check never exercised. For a task of this size (four separable concerns, ~30–60 min),
decomposition overhead was not repaid.

Run date 2026-07-14/15 UTC · model **`claude-sonnet-5`** (both arms, asserted identical) · claude CLI
**2.1.114** · runner SHA **0010b45** · task-template baseline SHA **c7c9a5e16b7b**.

---

## 1. Metrics table

Every number below is traceable to a file under `bench97/metrics/` or `bench97/results/`.

| Metric | ARM A (vanilla) | ARM B (plan tool) | Source |
|---|---|---|---|
| **Pass rate (hidden grader)** | **30 / 30** | **29 / 30** | `metrics/arm-{a,b}.json .grade` |
| &nbsp;&nbsp;parser (7) | 7 / 7 | 7 / 7 | grade.groups |
| &nbsp;&nbsp;core (9) | 9 / 9 | 9 / 9 | grade.groups |
| &nbsp;&nbsp;persist (7) | 7 / 7 | 7 / 7 | grade.groups |
| &nbsp;&nbsp;edge (7) | 7 / 7 | **6 / 7** | grade.groups |
| **Cost (USD)** | **$1.0253** | **$5.5669** | `.cost_usd` |
| &nbsp;&nbsp;— plan-creation phase | — | $1.3711 | arm-b `.plan_phase.cost_usd` |
| &nbsp;&nbsp;— runner phase | — | $4.1958 | arm-b `.runner_phase.cost_usd` |
| **Tokens in (total)** | **674,043** | **3,375,905** | `.tokens.in` |
| &nbsp;&nbsp;input | 28 | 20 (plan phase only)¹ | `.tokens.in_parts` / `.in_parts_plan_phase` |
| &nbsp;&nbsp;cache_read | 637,862 | 414,584 (plan phase only)¹ | " |
| &nbsp;&nbsp;cache_creation | 36,153 | 81,070 (plan phase only)¹ | " |
| &nbsp;&nbsp;runner phase in (aggregate) | — | 2,880,231 (no split persisted)¹ | arm-b `.runner_phase.tokens_in` |
| **Tokens out (total)** | **19,110** | **89,189** | `.tokens.out` (plan 26,250 + runner 62,939) |
| **Wall time (s)** | **191** | **984** | `.wall_s` |
| **Turns** | **14** | **87** (10 plan + 77 runner) | `.turns` |
| **Agents / sessions** | 1 | **7** (1 plan-creation + 6 execution) | arm-b `.agents` + plan phase |
| **Plan steps** | — | 6 (all `done`, 1 attempt each) | plan #99, archived project `bench97` |
| **Budget stop?** | No ($1.03 of $10) | No ($5.57 of ~$10 effective) | `.is_error` / no `spend ceiling` in log |
| **Blind-review preference** | preferred | — | `results/review.json` (see §4) |

¹ **The runner persists only aggregate token counts, not the input/cache 3-way split** — so ARM B's
3-way split is available for the plan-creation phase only; the 2.88 M runner-phase input tokens are
reported as a single aggregate. This is a measurement gap (threat T6, and improvement #4).

**Ratios (ARM B ÷ ARM A):** cost ×5.43 · tokens-in ×5.01 · tokens-out ×4.67 · wall ×5.15 · turns
×6.21 · pass rate 0.97×.

---

## 2. What ARM B's one failure was (root-caused)

- **Failing test:** `edge: amount upper bound is inclusive at 1000000.00`
  (`grader/tests/edge.test.mjs`). It asserts `add 1000000.00` → exit 0 **and** `add 1000000.01` →
  exit 2 `error: invalid amount`. ARM B returned exit **0** for `1000000.01` (accepted it).
- **Root cause (CONFIRMED, read from source):** `arm-b/src/lib/money.mjs:4`
  `const MAX_CENTS = 100000000000; // 1,000,000.00 in cents`. This is wrong by 1000×:
  1,000,000.00 dollars = **100,000,000** cents, but ARM B wrote **100,000,000,000**, so it accepts
  amounts up to ~$1,000,000,000.00. ARM A's `validate.mjs:8` has the correct `MAX_CENTS = 100000000n`.
- **Why it slipped through:** inject-mode marks a step `pass` on a non-empty `VERDICT:` line
  (`runner.mjs:196-200`, threat T8) — not on any objective check. Step 2's embedded self-check
  exercised valid amounts but never the just-over-max boundary, so the agent self-reported `pass`
  with the latent bug. Everything else in ARM B is correct (parser 7/7, core incl. the float trap
  9/9, persist incl. byte-exact file + schema-2 rejection 7/7).

---

## 3. Qualitative comparison

Both arms independently chose a **modular, multi-file** design (weakening the design's T7 assumption
that a reviewer could tell the arms apart by monolith-vs-multifile style):

- **ARM A (vanilla, 5 files, 362 LOC):** `errors.mjs` (`CliError` with exit code), `args.mjs`
  (deliberate 3-pass parser to guarantee leftmost-error ordering), `validate.mjs`, `store.mjs`,
  `cli.mjs`. Error flow is `throw CliError` → single `try/catch` in `main()` → `process.exitCode`
  (not `process.exit`), which is clean and unit-testable. Correct on every discriminating rule.
- **ARM B (plan tool, `cli.mjs` + `lib/{money,validate,store}.mjs` + `tests/run.mjs`, ~1024-line
  diff):** correct structure and separation, but all five command handlers plus arg parsing live in
  one 279-line `cli.mjs`, and errors are emitted via scattered inline `process.exit()` in a `fail()`
  helper (harder to test than throw/catch). It additionally wrote its own end-to-end regression
  suite (step 6, `test-engineer` role) — genuinely useful, but that suite did not catch the
  MAX_CENTS bug either. Plan decomposition (plan #99, now archived): `build-devops` scaffold →
  `implementer` ×4 (add / list / report / budget) → `test-engineer` e2e. Contexts were large and
  self-contained (3.6k–7.4k chars/step) as the frozen prompt demanded.

**Cost structure of the plan tool's overhead:** the plan-creation phase **alone** ($1.371, 10 turns,
26,250 output tokens) cost *more than ARM A's entire run* ($1.025). Then 6 fresh execution
processes each re-received the money/validate/store contract verbatim and re-paid cache-creation,
driving runner-phase input to 2.88 M tokens (vs ARM A's 0.67 M whole-run). The plan tool's price is
paid in (a) authoring the decomposition and (b) per-step context re-transmission across cold
processes.

---

## 4. Blind quality review (secondary — heavily caveated)

Protocol: coin-flip anonymization (`flip=1` → **X = arm-b, Y = arm-a**), mapping sealed until scores
recorded (`results/review/mapping.txt`), rubric = `prompts/review.txt` (score a–d 1–5). **The
reviewer was the analyst, not an independent session** — a material deviation from design §9 (see
threats). Scores (`results/review.json`):

| | (a) spec-adherence | (b) organization | (c) error-handling | (d) maintainability |
|---|---|---|---|---|
| **X (arm-b)** | 3 | 4 | 4 | 4 |
| **Y (arm-a)** | 5 | 5 | 5 | 5 |

**Preference: Y (arm-a).** Rationale: Y is correct on the money boundary and validation order and
uses throw/catch + `exitCode`; X carries the MAX_CENTS units bug and scatters `process.exit()`. This
review merely *corroborates* the objective grade — it is not independent evidence (see T7′ below).

---

## 5. Threats to validity

Design threats **T1–T9** apply verbatim (`docs/BENCHMARK_DESIGN.md` §12). The load-bearing ones plus
the four the step called out:

- **T1 n = 1.** One task, one run per arm. All figures are point estimates; **no significance is
  claimed.** The whole verdict could flip on a re-run — the cheapest upgrade is 3 runs/arm.
- **Reviewer identity (T7′, amplified).** The blind reviewer was the analyst who had already graded
  both arms and read both source trees, so the review is **not blind and not independent**. Worse,
  anonymization leaked through metadata: X.diff = 1024 lines (has a test suite), Y.diff = 394 lines,
  so the arms were trivially distinguishable by size. Treat §4 as color only, never as a headline.
- **Budget overshoot — did NOT occur.** Neither arm hit its cap: ARM A spent $1.03 of $10; ARM B
  spent $5.57 against a $3 plan-creation cap + $7 runner ceiling (per-agent $2). So there is **no
  truncation artifact** in these results — every arm ran to completion. (Recorded because the step
  flagged it as a threat to check; here it is a non-threat.)
- **T6 cache asymmetry (intrinsic signal).** ARM A is one session that reuses its prompt cache
  (cache_read 637,862 dominates; only 36,153 creation). ARM B spawns 7 cold processes that each
  re-pay cache-creation (plan-phase creation 81,070; runner phase not split). This structurally
  inflates ARM B's input tokens and is **intrinsic to the two designs** — signal, not noise — but it
  means "tokens-in ×5" partly reflects cache mechanics, not five times the "real" work. The runner's
  aggregate-only logging prevents quantifying this per step.
- **T5 tool asymmetry — closed.** The B2 runner fix is in (SHA 0010b45; `runner.mjs:201` prints
  `Available tools: …`), and both arms were passed identical `--allowed-tools
  Read,Write,Edit,Bash,Glob,Grep`, so ARM B agents could self-test. No handicap.
- **T8 weak step gate — realized.** ARM B's step 2 self-reported `pass` while shipping the MAX_CENTS
  bug; the runner's "pass = non-empty VERDICT line" gate cannot catch this. The hidden grade is the
  only trustworthy outcome metric, as designed.
- **T2/T3 selection & leakage.** Task authored by the same model family and a plan-tool-invested
  author; spec + grader were frozen and committed before either arm ran, grading is black-box, and
  both arms share any residual expense-CLI training leakage equally.

---

## 6. Improvement suggestions for the plan tool (each tied to an observation)

1. **Gate inject steps on their embedded self-check, and force adversarial cases into it.**
   *Observation:* ARM B's only failure (MAX_CENTS off-by-1000×, `money.mjs:4`) passed because
   step 2's self-check tried valid amounts but never `1000000.01`, and the runner's pass gate is
   just "non-empty VERDICT line" (`runner.mjs:196-200`). *Change:* have the runner optionally
   execute the step's embedded self-check command and gate on its exit code (not the agent's
   self-report); and make the plan-creation prompt require every step's self-check to include the
   spec's discriminating boundary cases (here the `≤ 1000000.00` edge). This directly attacks the
   one-test gap that cost ARM B the tie.

2. **Decompose by shared concern, not one-command-per-step, to stop re-transmitting invariants.**
   *Observation:* steps 3–5 (list/report/budget) each spawned a fresh agent that re-received the
   money/store/validate contract verbatim (ctx 4–5k chars each) and re-paid cache-creation, and the
   runner-phase input hit 2.88 M tokens vs ARM A's 0.67 M whole-run (arm-b `.runner_phase.tokens_in`
   vs arm-a `.tokens.in`). *Change:* prefer a decomposition that builds the shared lib once, then
   adds the read-only commands in one larger step — fewer cold spawns, less duplicated context.

3. **Stop copying spec.md into every step context; point steps at the file already in the clone.**
   *Observation:* plan creation alone cost $1.371 / 26,250 output tokens — more than ARM A's entire
   run — because the frozen prompt asks each of 6 contexts to embed spec excerpts "word-for-word,"
   so most of spec.md was re-serialized ~6×. The working copy already contains `spec.md`.
   *Change:* let step contexts *reference* `spec.md` in cwd (the inject runner can inject a standing
   "spec.md is in your working directory — read the relevant section" line) instead of the plan
   author paying output tokens to duplicate it. Attacks the largest fixed overhead the tool adds.

4. **Log per-step token/cost in the runner (design improvement B2b).**
   *Observation:* `metrics.mjs` could only report ARM B's input 3-way split for the plan phase; the
   runner persists aggregate-only (`in 2,880,231` with no input/cache breakdown), so T6 cache
   asymmetry cannot be attributed to specific steps. *Change:* emit a per-step usage line after
   `runner.mjs:194` so future runs can pinpoint which steps drive the token blow-up.

---

## 7. Reproduction & artifacts

- Harness: `C:/Users/AI/Documents/bench97/` (`scripts/run-arm-a.sh`, `run-arm-b.sh`, `grade.sh`,
  `metrics.mjs`); design `C:/Users/AI/Documents/plan-ledger/docs/BENCHMARK_DESIGN.md`.
- Consolidated metrics: `bench97/metrics/arm-a.json`, `bench97/metrics/arm-b.json`.
- Raw: `bench97/results/arm-a.json`, `arm-b-plan.json`, `arm-b-runner.log` (usage line at tail),
  `arm-{a,b}.diff`, `arm-{a,b}-grade.json`, `review.json`, `review/mapping.txt`.
- ARM B plan: plan #99 "bench97 ARM B" in plan-ledger project **bench97** (id 6), **archived** after
  metrics capture; current project restored to id 5.
- Preflight: `plan-ledger` `npm test` green (89 core + 79 RAG checks + MCP e2e OK); runner SHA
  0010b45 with `parseVerdict` (`runner.mjs:211`) and the B2 `Available tools:` line
  (`runner.mjs:201`); baseline task-template SHA c7c9a5e16b7b.

*Author: analyst (plan #97 step 509). Model `claude-sonnet-5`, claude CLI 2.1.114.*
