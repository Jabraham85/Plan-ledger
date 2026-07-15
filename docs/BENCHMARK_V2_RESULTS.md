# Benchmark v2 (stratum) — vanilla opus vs plan tool on a layered task (plan #100 step 525)

**Question (verbatim from `docs/BENCHMARK_V2_DESIGN.md` §0):** *Does decomposition + role dispatch pay
off on layered work too large for one clean context — a 6-stage project where stage N is unbuildable
without correct stages 1..N-1, where a single vanilla session is predicted to degrade stage-over-stage?*

**Verdict (n=1 per cell, INDICATIVE — not significant):** On this layered task the two arms were a
**near dead heat on quality** — the plan tool (ARM B) scored **130/130**, the single vanilla opus
session (ARM A) **129/130** (its one miss a *mid-stack* B-tree case, **not** the predicted late-stack
collapse). The genuinely new result is **economic and directional**: ARM B cost **$8.19 vs ARM A's
$9.17 (≈11% cheaper)** and used **≈12% fewer input tokens** — a **reversal of v1**, where the plan tool
cost **5.4× more** and lost. But that reversal is driven **as much by the model-tier policy as by
decomposition**: ARM A ran the whole task on opus, while ARM B ran a $4.63 opus plan + 2 opus bookend
steps + **6 cheap sonnet implementation steps ($2.21 total)**. Read v1 and v2 **as a pair**: the plan
tool's demonstrated payoff here is *cost via tiered dispatch once a task decomposes cleanly*, **not** a
quality multiplier — because the single opus session did **not** degrade as the thesis predicted.

Run date 2026-07-15 UTC · model **`claude-opus-4-8`** (both leaders; ARM B agents tiered per
`~/.claude/plan-roles.json`) · claude CLI **2.1.114** · runner SHA **fca106c** (VERIFY gate `c10764d`
+ per-step usage `fca106c`) · task-template baseline SHA **36bc67da** · grader SHA **6aaba7d9** ·
design commit **2803a91**.

---

## 1. Metrics table

Every number traceable to a file under `bench100/metrics/` or `bench100/results/`.

| Metric | ARM A (vanilla opus) | ARM B (plan tool) | Source |
|---|---|---|---|
| **Pass rate (hidden staged grader)** | **129 / 130** | **130 / 130** | `metrics/arm-{a,b}.json .grade` |
| **Cost (USD)** | **$9.170** | **$8.188** | `.cost_usd` |
| &nbsp;&nbsp;— plan-creation phase | — | $4.632 | arm-b `.plan_phase.cost_usd` |
| &nbsp;&nbsp;— runner phase | — | $3.556 | arm-b `.runner_phase.cost_usd` |
| &nbsp;&nbsp;— by model (ARM B) | opus $9.163 / haiku $0.008 | **opus $5.975 / sonnet $2.213 / haiku $0.002** | `.modelUsage` + `.per_step` |
| **Tokens in (total)** | **2,651,072** | **2,341,375** | `.tokens.in` |
| &nbsp;&nbsp;input / cache_read / cache_creation | 70 / 2,544,462 / 106,540 | 36 / 949,155 / 84,412 (plan phase only)¹ | `.tokens.in_parts` |
| &nbsp;&nbsp;runner-phase in (aggregate) | — | 1,307,772 | arm-b `.runner_phase.tokens_in` |
| **Tokens out (total)** | **44,629** | **43,305** | `.tokens.out` (plan 21,637 + runner 21,668) |
| **Wall time (s)** | **568** | **1,231** (≈258 plan + ≈973 runner) | `.wall_s` |
| **Turns** | **35** | **84** (43 plan + 41 runner) | `.turns` |
| **Agents / sessions** | 1 | **8** (1 plan-creation + skeleton + 6 stages + integration) | arm-b `.agents` |
| **Plan steps** | — | 8 (all `done`, **1 attempt each, 0 retries**) | plan #101, archived project `bench100` |
| **Budget stop?** | No ($9.17 of $30) | No ($8.19 of $45; plan $4.63/$8, runner $3.56/$37) | `.is_error` / no ceiling in log |
| **Blind-review preference** | tie | tie | `results/review/review.json` (§5) |

¹ The runner persists only aggregate token counts, not the input/cache 3-way split — so ARM B's 3-way
split is available for the plan-creation phase only. The **per-step** table (§4) is the v2 fix that lets
us attribute the runner-phase blow-up anyway.

**Ratios (ARM B ÷ ARM A):** cost **×0.893** · tokens-in **×0.883** · tokens-out ×0.970 · wall ×2.167 ·
turns ×2.400 · pass rate **1.008×** (+1 test).

---

## 2. Per-stage falloff curves — the core v2 exhibit

Passed / total per stage group (the grader compounds: stage-N tests run against the arm's *own*
stages 1..N, so the first cliff localises the break — `BENCHMARK_V2_DESIGN.md` §5).

| Stage (dep order) | ARM A | ARM A frac | ARM B | ARM B frac |
|---|---|---|---|---|
| 1 Pager | 18/18 | 1.000 | 18/18 | 1.000 |
| 2 WAL/recovery | 20/20 | 1.000 | 20/20 | 1.000 |
| 3 B-tree | **21/22** | **0.955** | 22/22 | 1.000 |
| 4 SQL parser | 18/18 | 1.000 | 18/18 | 1.000 |
| 5 Executor | 24/24 | 1.000 | 24/24 | 1.000 |
| 6 Transactions | 18/18 | 1.000 | 18/18 | 1.000 |
| Integration (full-stack + crash-recovery) | 10/10 | 1.000 | 10/10 | 1.000 |

**Reading (honest, per T-ATTR):** **Neither curve falls late-stack.** The thesis predicted ARM A would
ace the early stages and **degrade on executor/txn/integration** under accumulated context pressure. It
did the opposite: ARM A aced stages 5, 6, and integration and dropped its single point on **B-tree
(stage 3, mid-stack)**. At `claude-opus-4-8`'s context capacity, the ~1500-LOC / 6-stage task did **not**
induce the single-session degradation the experiment was built to provoke. The plan tool's +1 test is
real but marginal, and it did **not** arrive via the hypothesised mechanism — a result that constrains,
rather than confirms, the "home turf" thesis (§6, Finding 2). The design's own flip-condition (§3, "if
ARM A does not degrade late-stack, the layering did not create the predicted pressure") is **met** — a
larger/deeper task (or a smaller model) would be needed to actually stress a single context.

---

## 3. Model-tier split (model guard)

Both leaders were asserted `claude-opus-4-8`; ARM B agents resolved via `plan-roles.json` (architect/
debugger → opus, implementer → sonnet). `modelUsage` keys confirm:

- **ARM A — effectively pure opus.** All 44,629 task-output tokens billed to `claude-opus-4-8`
  ($9.163). A negligible `claude-haiku-4-5` call ($0.0076, **14 output tokens**) is the CLI's internal
  summariser, not coding. ✓ pure-opus guard satisfied.
- **ARM B — opus leader + tiered agents.** Plan creation opus ($4.630). Runner: **step 1 skeleton
  (architect) opus, step 8 integration (debugger) opus, steps 2–7 (implementer) sonnet** — exactly the
  policy. ARM B by cost ≈ **73% opus / 27% sonnet**. ✓ tier-policy guard satisfied.

---

## 4. ARM B per-step token/cost attribution (first real exercise of the DB path)

From the plan-ledger DB `attempts.result` usage lines (`metrics.mjs extractPerStepUsage`; the console
fallback does **not** work for inject mode — README gotcha). Per-step sum = runner aggregate exactly
(Σ tin = 1,307,772; Σ cost = $3.556). ✓ the step-521 logging path works end-to-end on its first live run.

| idx | role | model | step | tin | tout | cost | turns |
|---|---|---|---|---|---|---|---|
| 1 | architect | **opus** | Contract skeleton (6 stubs + package.json) | 268,933 | 2,961 | $0.3849 | 12 |
| 2 | implementer | sonnet | Stage 1 Pager | 48,730 | 981 | $0.2810 | 2 |
| 3 | implementer | sonnet | Stage 2 WAL/recovery | 49,855 | 1,253 | $0.2804 | 2 |
| 4 | implementer | sonnet | Stage 3 B-tree | 76,441 | 1,309 | $0.4218 | 3 |
| 5 | implementer | sonnet | Stage 4 SQL parser | 49,548 | 1,145 | $0.4213 | 2 |
| 6 | implementer | sonnet | Stage 5 Executor | 50,703 | 1,322 | $0.4560 | 2 |
| 7 | implementer | sonnet | Stage 6 Transactions | 50,620 | 1,356 | $0.3525 | 2 |
| 8 | debugger | **opus** | Full-stack integration + crash-recovery | 712,942 | 11,341 | $0.9582 | 16 |

**What this newly shows (v1 could not):** the two **opus bookend steps** (skeleton + integration)
consume **75.1% of runner input tokens** (981,875 / 1,307,772) and **68% of turns** (28 / 41) but only
**37.8% of runner cost** ($1.343 / $3.556). The inversion is the T6 cache asymmetry, now *localised*:
the opus steps' huge token counts are dominated by **cheap cache-read within their own multi-turn
sessions** (step 8's debugger re-read the whole tree across 16 turns), whereas each of the **6 cold
sonnet agents re-pays cache-creation** on a fresh ~50k context and so costs **$0.28–$0.46 for only
~50k tokens** — a high per-token rate. The plan tool's overhead lives in **cold-agent context setup**,
not in the opus reasoning steps.

---

## 5. Blind quality review (secondary — color only, per T-STUB-LEAK)

Protocol: coin-flip anonymization (**X = arm-b, Y = arm-a**), rubric `prompts/review.txt` (a–d, 1–5).
**Reviewer = the analyst (this session)**, not an independent session — a material deviation from design
§9/R3; worse, the diff line counts (X=1318, Y=915) leaked arm identity to the analyst who ran both arms.
Treat as color only (`results/review/review.json`).

| | (a) spec-adherence | (b) organization | (c) error-handling | (d) maintainability |
|---|---|---|---|---|
| **X (arm-b)** | 5 | 5 | **4** | 5 |
| **Y (arm-a)** | 5 | 5 | **5** | 4 |

**Preference: tie.** Both nail the exact byte layouts, AST shapes, `SqlError` taxonomy, and PK-ascending
default. The interesting divergence from the grader: on code merit the **more robust** transaction/error
handling is **arm-a's (Y)** — explicit bounds checks in *both* pager and txn layer, `snapshotDirty`/
`restoreDirty` giving per-statement atomicity **inside** an explicit transaction, and a length-prefixed
catalog. **arm-b (X)** is more readable/commented but its `runWrite` does **not** roll back a failed
statement's dirty pages when inside a `BEGIN` — a latent partial-write gap under the spec's "a throwing
statement leaves state unchanged" rule. **arm-b scored 130/130 anyway** because the hidden suite never
exercises "INSERT fails mid-transaction, then continue" — so the arm the grader ranked *higher* carries
the *weaker* error handling. Green grader ≠ bug-free (§6, Finding 4).

---

## 6. V1-vs-V2 comparative — where the crossover actually sits

| Axis | v1 (flat task, sonnet both) | v2 (layered task, opus leader + tiered agents) |
|---|---|---|
| Task | 1 task, 4 flat concerns, ~360 LOC, 30 tests | 6 physically-layered stages, ~1500 LOC, 130 tests |
| Leaders | sonnet both arms | **opus** both leaders |
| ARM B agents | sonnet | **opus (2) + sonnet (6)** per tier policy |
| Pass | A **30/30** · B 29/30 → **A wins** | A 129/130 · B **130/130** → **B +1 (near-tie)** |
| Cost B÷A | **×5.43 (B far dearer)** | **×0.89 (B cheaper)** |
| Tokens-in B÷A | ×5.01 | ×0.88 |
| Wall B÷A | ×5.15 | ×2.17 |
| Verdict | vanilla wins every axis | quality dead-heat; **B wins on cost** |

**The crossover, on the joint evidence:**

- **Cost crossover is gated on the tier policy, not task shape alone.** v1 decomposition with *both arms
  on sonnet* cost 5.4× more and never recouped. v2 flips the sign — but the flip is largely because ARM A
  paid opus rates for **all** ~1500 LOC ($9.17) while ARM B routed the 6 bulk-implementation stages to
  **sonnet** ($2.21 total) under a $4.63 opus plan + $1.34 of opus bookends. **Decomposition's economic
  win here is the tiered dispatch it enables** (cheap workers under an opus plan+review frame), *plus*
  the fact that a layered task decomposes cleanly enough to route. Had both arms been forced to one model,
  the cost gap would shrink toward v1's shape (opus decomposition still pays per-cold-agent cache setup).
- **Quality crossover is *not* reached in either experiment.** The plan tool is within **±1 test** of the
  single session in both (−1 in v1, +1 in v2); at n=1 that is inside the noise floor. Crucially, v2's +1
  did **not** come from the predicted single-session degradation — ARM A held the whole 6-stage stack in
  one context and missed only one mid-stack B-tree case. So **neither experiment demonstrates the plan
  tool as a quality multiplier**; v2 only demonstrates it as a **cost lever** on a decomposable task.
- **Net map:** flat + untiered → single session wins (v1). Layered + tiered → decompose-and-dispatch wins
  **on price at equal quality** (v2). The unmeasured cell — the one that would actually test the original
  thesis — is a task big/deep enough (or a model weak enough) that the single session **provably
  degrades**; opus-4-8 did not reach it at ~1500 LOC.

### New data-derived findings (≥3 required)

1. **Cost reversal is real but confounded by model tiering (T-TIER).** ARM B is 11% cheaper *and* uses
   12% fewer input tokens than ARM A — the opposite of v1's 5.4×. Attribution: sonnet did **62% of runner
   cost** doing the bulk of the code, under opus framing. This is a plan-tool win *only in conjunction
   with the role→tier map*; it is not evidence that decomposition-per-se is cheaper (v1 says it is not).
2. **The predicted late-stack falloff did not occur.** Both falloff curves are essentially flat; ARM A's
   sole miss is B-tree (stage 3), not executor/txn/integration. The design's flip-condition (§3) is met:
   opus-4-8 did not degrade over the stack, so this task did not create the context pressure the
   experiment assumed. The thesis's *mechanism* is unsupported at this task size on this model.
3. **Per-step attribution (new) localises the plan-tool overhead to cold-agent setup.** The 2 opus
   bookend steps hold 75% of tokens / 68% of turns but 38% of cost; the 6 cold sonnet agents each re-pay
   cache-creation (~$0.28–$0.46 / ~50k tokens). The token blow-up v1 could only report in aggregate is
   now pinned to per-agent context re-transmission, not to reasoning depth.
4. **Enforced VERIFY gate held, yet green ≠ bug-free (subtler than v1's MAX_CENTS).** All 8 ARM B steps
   passed smoke on attempt 1 with **zero retries and no budget stop** — the c10764d gate replaced v1's
   weak "non-empty VERDICT" gate. But blind review found arm-b (130/130) ships a latent in-transaction
   rollback gap the 130 hidden tests never exercise. Both the smoke gate *and* a 130-test grader can pass
   a subtly incomplete implementation — the same lesson as v1, one layer deeper.
5. **The blind review inverts the grade on robustness.** The arm the grader ranked lower (arm-a, 129)
   has the *more* defensive transaction/error code. Reinforces that per-stage grader scores, not review
   color, are the arbiter — and that a 1-test grader delta is not a quality verdict.
6. **The $45 ARM B cap had large headroom; even $30 would not have truncated.** Design §8 feared an ARM B
   spend-ceiling stop ($19–35 vs $30). Actual ARM B total was **$8.19** — the cold-agent cache cost was
   real but small because sonnet workers are cheap and each stage was a tight 2–3 turn task. The cap
   decision was sound insurance, but the truncation threat (T-COST) did not materialise.

---

## 7. Threats to validity (restated for v2)

Inherit T1–T9 (`docs/BENCHMARK_DESIGN.md` §12) and the v2 amendments (`BENCHMARK_V2_DESIGN.md` §9):

- **T-SHAPE (openly, this is the point).** v2's task was *chosen* to favour decomposition. A plan-tool
  cost win here is evidence for a *conditional* claim, never a general "plan tool wins." And note it did
  **not** even win via the designed mechanism (Finding 2) — so the conditional is weaker than hoped.
- **T-TIER (new, load-bearing).** v2 changed **two** variables vs v1 at once — task shape *and* model
  policy (opus-both-leaders + tiered agents vs sonnet-both). The cost reversal cannot be cleanly
  attributed to task shape; the tier policy is a co-cause (Finding 1). A clean isolation would run v2's
  task with both arms on one model.
- **T1 n = 1 per cell.** One run per arm. A ±1-test quality delta and an 11% cost delta are point
  estimates inside the noise floor; the cheapest upgrade is 3 runs/arm.
- **Reviewer identity (T7′, amplified).** The blind reviewer is the analyst who ran and graded both arms,
  and diff line counts (1318 vs 915) leaked arm identity. §5 is color only.
- **T-ATTR (compounding) — moot here.** Both arms passed essentially every stage, so no "late score
  caused by an early break" ambiguity arose; the one ARM A miss is isolated in stage 3 with stages 5/6
  above it fully green, confirming the miss is a genuine local B-tree edge, not a compounding artifact.
- **T-VERIFY — no asymmetry realised.** Same public smoke shipped to both; ARM A was told to self-test
  per stage and did (129/130), so the "single-session skips its self-tests under pressure" gap did not
  appear. The gate only enforced what ARM A did voluntarily.
- **T-CF — scope limit.** ARM B's handoffs were **pre-authored** at plan time (inject mode, no runtime
  `write_carry_forward`). v2 tests the plan tool's *authored* web structure, not runtime cross-agent
  discovery; every inter-stage contract was frozen in `spec.md`, so runtime discovery was not needed.
- **T-STUB-LEAK.** Six mandated module paths constrain architecture, so §5 is weighted even lighter than
  v1's review.

---

## 8. Reproduction & artifacts

- Harness: `C:/Users/AI/Documents/bench100/` (`scripts/run-arm-a.sh`, `run-arm-b.sh`, `grade.sh`,
  `metrics.mjs`); design `C:/Users/AI/Documents/plan-ledger/docs/BENCHMARK_V2_DESIGN.md` (commit 2803a91).
- Consolidated metrics (committed): `bench100/metrics/arm-a.json`, `bench100/metrics/arm-b.json`.
- Raw (committed): `bench100/results/arm-{a,b}-grade.json`, `arm-{a,b}-wall.txt`, `arm-b-runner.log`,
  `review/review.json`, `review/mapping.txt`.
- ARM B plan: plan **#101** "stratum ARM B" (8 steps, all done), in plan-ledger project **bench100**
  (id 7), **archived** after metrics capture; active project unchanged (id 5 "plan tool").
- Preflight (2026-07-15): `plan-ledger` `npm test` green (29 + 33 checks, exit 0); runner SHA
  **fca106c** (VERIFY gate `c10764d` + per-step usage `fca106c`); grader gates **reference 130/130,
  stubs 0/130**; task-template SHA **36bc67da**, grader SHA **6aaba7d9**.

*Author: researcher (plan #100 step 525). Model `claude-opus-4-8`, claude CLI 2.1.114. Analyst-reviewer
caveat stated (§5, T7′).*
