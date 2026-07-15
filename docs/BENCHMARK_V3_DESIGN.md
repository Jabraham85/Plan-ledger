# BENCHMARK_V3_DESIGN — Property-graded, difficulty-gated benchmark (plan #102 step 534)

**Status:** design frozen 2026-07-14 · **Author role:** architect · **Executes as:** plan #102 build/gate/run steps
**Inherits:** `docs/BENCHMARK_DESIGN.md` (v1 protocol — every control, threat, extraction technique below
is v1's unless amended), `docs/BENCHMARK_V2_DESIGN.md` (layered task, opus leaders, tier policy, staged
grader), `docs/BENCHMARK_2026-07.md` + `docs/BENCHMARK_V2_RESULTS.md` (the two results this design exists
to fix).

**The failure being fixed (root cause, from the two prior results).** v1 saturated: ARM A **30/30** vs
ARM B **29/30** (`BENCHMARK_2026-07.md` §1). v2 saturated worse: ARM A **129/130** vs ARM B **130/130**
(`BENCHMARK_V2_RESULTS.md` §1). In **both**, the quality axis measured *nothing* — every arm scored at or
one test below the ceiling, so the benchmark could not discriminate between a strong and a weak session.
The mechanism is identical in both: **the hidden tests were fixed instances derivable from a complete
spec.** The spec fixed exact I/O (`added e1\t12.50\tfood`), exact on-disk layouts (`magic "STRM"`), exact
AST JSON, and an exact error taxonomy; the hidden suite just replayed *more* instances of those same
fixed rules. Any single strong opus session that read the spec carefully reproduced the rules and aced
the instances. Decomposition bought nothing on the quality axis because there was no quality *headroom* —
the ceiling was reachable by spec-following alone.

**The v3 thesis (what must be true for the benchmark to work).** A benchmark discriminates on quality
only if **the ceiling is not reachable by spec-following**. v3 attacks this on two axes at once:
1. **The spec states PROPERTIES, not instances.** "recovery restores a consistent committed state after a
   crash at ANY WAL frame boundary"; "invariants I1..In hold under any operation sequence"; "no malformed
   input crashes the process." The spec cannot be "completed" into a lookup table because the property
   quantifies over an infinite instance space.
2. **The grader probes each property with seeded deterministic generators and scores granular partial
   credit** (fraction of 300–500 probe seeds survived per property). A subtle flaw in an early subsystem
   costs a measurable, non-zero, non-full fraction across every late property that exercises it. Perfect
   is statistically implausible for a hand-written implementation under ~4000 adversarial seeds; zero
   requires a dead subsystem. **Both arms are expected to land in a discriminating mid-band.**
3. **Difficulty is MEASURED before the real arms run.** A mandatory **no-ceiling gate** (§4) runs one
   $10-capped vanilla opus pilot on the full task; if it scores ≥ 65% the task is REJECTED, hardened by
   principled levers, and the gate re-runs. The benchmark is not allowed to proceed until an unaided
   strong session provably *cannot* ace it.

**What v3 changes vs v2 (at a glance):** (a) **property-stated spec** — no instance enumeration; (b)
**fuzz grader** — seeded generators + granular per-property survived-fraction + deterministic resource
budgets; (c) **no-ceiling gate** — measured-difficulty protocol phase with ≤3 hardening iterations before
either arm runs; (d) **5–10× scale** — 4–8k-LOC reference (`stratum-mvcc`: v2's engine + MVCC snapshot
isolation + concurrent transactions + constraints + compaction + a durability torture suite); (e) new
metrics — per-property survived-fraction table per arm (the discrimination exhibit) + score-vs-spend if a
cap binds. Arms, tier policy, inject+lean, VERIFY gate, builds_on/carry_forward/SPEC-reference all carry
over from v2 unchanged.

---

## 1. Controls (both arms) — delta from v2 §1 only

Everything in `docs/BENCHMARK_V2_DESIGN.md` §1 and `docs/BENCHMARK_DESIGN.md` §1 holds. Amendments:

| Control | v3 value |
|---|---|
| Model (leaders) | `--model claude-opus-4-8` on the ARM A session **and** the ARM B plan-creation session **and the no-ceiling gate pilot** (§4). Record it + `claude --version`. |
| Model (ARM B role agents) | Tier policy `~/.claude/plan-roles.json` (verified `plan-roles.json` `roles`: architect/debugger → opus, implementer/test-engineer/build-devops → sonnet). Runner passes per-role model (`runner.mjs:203,241`); **no `--model` on the runner** (would override the map — `runner.mjs:203`). |
| Budget ceiling | See §8 — v3 is 5–10× v2's scale on opus; honest caps are **~$60 ARM A / ~$65 ARM B / $10 gate pilot**. |
| Grader | **Property fuzz grader** (§5), not the fixed-instance staged grader. Seeded PRNG everywhere; deterministic resource budgets; `--twice` determinism gate. |
| Determinism enforcement (NEW) | Grader loads each arm with `Math.random` stubbed to throw and `Date.now` frozen; any arm depending on wall-clock/RNG fails loudly. Spec forbids both (§3.3). |
| Fairness disclosure (NEW) | Both arms' prompts carry the identical clause that the grader fuzzes the property space with hundreds of seeds per property (crash sweeps, op-sequence fuzzing, malformed-input generators) and enforces stated resource budgets — **same information, no instance enumeration** (§6, §9 T-VERIFY). |

## 2. Prerequisites already landed (no new runner code in this plan)

Unlike v2 (which had to build the VERIFY gate + per-step logging first), **v3 needs no new runner code** —
both prerequisites are already in `main`:
- **VERIFY gate** — `runner.mjs:24-25,224,294-346` (commit `c10764d`). A `VERIFY: <cmd>` context line is
  re-run post-exit; a claimed pass with a failing command is overridden to fail (both inject and MCP mode).
- **Per-step usage logging** — `runner.mjs:31,360` (commit `fca106c`): `usage: in=… out=… cost=$… turns=…
  model=…` appended per attempt, enabling per-step attribution (§7).

The only build work in plan #102 is the benchmark artifacts themselves (spec + reference + fuzz grader +
prompts + the gate loop), all under `C:/Users/AI/Documents/bench102/` — **zero plan-ledger code changes**
(§11). This design doc's diff is docs-only.

## 3. The task — decision first

**Criteria (priority order):** C1 **property richness under seeded generators** — can we state ≥10
*independent-ish* properties, each probeable by 300–500 seeds with granular partial credit, and is a
mid-band the *expected* per-property outcome? (this IS the experiment). C2 **early-flaw-surfaces-late** —
subsystem interaction depth: does a subtle stage-1 bug manifest *only* in a late property probe? (the
discrimination mechanism). C3 **reference reaches the ≥95% floor** under aggressive fuzzing — if the
reference can't validate the grader, the grader is untrustworthy (grader-bug risk, §10). C4 **determinism
headless** — seeded PRNG everywhere, no wall-clock, no real threads (crash/concurrency *simulated*). C5
**memorization resistance** — bespoke formats/taxonomy a training-data solution fails. C6 **build cost /
reuse** — can we reuse the *validated* v2 stratum base to keep grader-bug risk tractable at 4–8k LOC.

| Option | C1 richness | C2 late-surfacing | C3 ref floor | C4 determinism | C5 memo-resist | C6 reuse | Verdict |
|---|---|---|---|---|---|---|---|
| **A. `stratum-mvcc` — extend v2's engine** (+ MVCC snapshot isolation, concurrent txns via a seeded interleaver, UNIQUE/CHECK/NOT NULL/PK constraints, compaction/vacuum, crash-sweep torture) | **10 properties**, each seed-fuzzable; MVCC + crash-sweep + constraints + budgets span the difficulty band naturally | **high** — a WAL/pager off-by-one surfaces *only* under the crash-frame sweep; a version-chain bug *only* under specific interleavings; physical layering already proven in v2 | **high** — reference is a controlled superset of the *validated* 757-LOC v2 reference; floor reachable | **high** — concurrency = seeded logical interleaver (no threads); crash = `close({checkpoint:false})`+reopen (no signals) | **high** — bespoke on-disk WAL frames + MVCC version-chain format + error taxonomy | **high** — reuse v2 pager/wal/btree/sql/db | **RECOMMENDED** |
| B. fresh domain — bespoke **replicated log + leader election** (deterministic discrete-event sim, seeded network partitions/drops/reorders) | high — consensus safety properties are natively property-stated | medium — consensus bugs tend to surface *broadly*, not late-only | **LOW** — liveness under partition isn't guaranteed in bounded steps; the **reference may not clear 95%** on aggressive fault seeds → grader unvalidatable | medium — sim is deterministic but subtle (message-order seeding) | medium — Raft is heavily memorized unless deeply bespoke | low — throws away the validated stratum base | ALTERNATE |
| C. fresh mini-OLTP from scratch (no reuse) | high | high | medium | high | high | **none** | rejected (dominated by A — same richness, no reuse, higher grader-bug risk) |

**A wins on C3 and C6 — the two criteria that make the grader *trustworthy at this scale*.** The v3
grader is 5–10× the code v1/v2 shipped, and a grader bug at that size is the dominant risk (§10, T-GRADER).
Reusing the *already-validated* stratum reference (v2 gates: reference 130/130, stubs 0/130 —
`BENCHMARK_V2_RESULTS.md` §8) means the new properties are bolted onto a known-good core, so a property
that scores the reference < 95% localises cleanly to the new subsystem. Option B's fatal flaw is C3: a
consensus reference under seeded partition-fuzz can legitimately fail to make progress within a bounded
step budget, so "reference ≥ 95%" may be *unachievable for a correct reference* — you cannot tell a grader
bug from real protocol behaviour, and the whole validation protocol (§10) collapses. **Evidence that flips
to B:** if the S1 spike (§12) shows the `stratum-mvcc` reference *cannot* clear the ≥95% floor on the
crash-sweep or interleaver property even after loosening budgets to their fairness limit (i.e. the domain
is ungradeable), fall back to B with a bespoke (non-canonical) consensus variant and a *safety-only*
property set (drop liveness, which is what makes B's floor unreachable).

### 3.1 `stratum-mvcc` — subsystems (seed for `spec.md`)

Working name **`stratum-mvcc`**. Node ≥ 22, ES modules, **zero dependencies**, offline. Mandated module
entry points (the grader imports exactly these — anything else scores 0 for the properties that touch it):
v2's `src/{pager,wal,btree,sql,db}.mjs` **plus** the extended `db.mjs` API below. Little-endian
throughout; all determinism knobs (iteration order, default sort, version-chain order) fixed by the spec.

| Subsystem | Module | Adds over v2 | Builds on |
|---|---|---|---|
| Pager / WAL / B-tree / SQL parser | v2 modules | (carried over; v2 formats frozen) | — |
| **MVCC store** | `src/mvcc.mjs` (NEW) | per-row **version chains** keyed by writer txn id + commit sequence; snapshot visibility rule fixed in spec | pager, btree |
| **Transactions** | `src/db.mjs` (extended) | `begin()` → `Txn` snapshot at begin; `commit()` = first-committer-wins (`E_CONFLICT`); `rollback()` = byte-identical revert | mvcc, wal |
| **Constraints** | `src/db.mjs` + `src/sql.mjs` | `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, `CHECK(<expr>)` — enforced atomically per statement | mvcc, parser |
| **Compaction** | `src/db.mjs` `compact()` (NEW) | reclaim dead versions; preserve every live row + all invariants; shrink on-disk file | mvcc, pager |
| **Durability torture** | grader-driven | crash at ANY WAL frame boundary via `close({checkpoint:false})` + reopen (v2 seam, swept) | wal, txn |

### 3.2 The properties (this section is the seed for the `spec.md` property list)

Ten properties. Each has a seeded generator `G_i`, a deterministic oracle `O_i`, a seed count `N_i`, a
weight `w_i` (Σ w_i = 1), and a resource budget (§5.2). **Weights front-load the layered core** (recovery,
snapshot, atomicity) so that early-subsystem correctness dominates — the "early flaw surfaces late" signal.

| id | Property (spec states this; grader probes it) | Generator `G_i(seed)` | N_i | w_i |
|---|---|---|---|---|
| **P1 recovery** | committed state survives a crash at ANY WAL frame boundary; un-checkpointed frames replay exactly once | random committed workload × crash frame offset (sweeps every frame boundary) | 500 | 0.15 |
| **P2 snapshot** | a txn's reads reflect a consistent snapshot as of `begin()`; concurrent commits are invisible to it | seeded interleaving of K open txns | 400 | 0.12 |
| **P3 conflict** | first-committer-wins: the later of two overlapping writers aborts `E_CONFLICT`; non-overlapping both commit | conflicting/disjoint write-set schedules | 300 | 0.10 |
| **P4 atomicity** | a rolled-back or failed txn leaves the store byte-identical to its pre-`begin` image | txn that fails/rolls back at a random statement | 400 | 0.12 |
| **P5 constraints** | UNIQUE/CHECK/NOT NULL/PK never violated by an accepted op; a violating op rejects atomically | random constraint-stressing op sequence | 500 | 0.12 |
| **P6 compaction** | after `compact()`: every live row identical, all invariants hold, file ≤ size cap, dead versions unreadable | workload then compaction | 300 | 0.09 |
| **P7 scan** | ordered SELECT / rangeScan returns exactly the snapshot-visible live rows in PK-ascending order | mixed insert/update/delete then scan | 400 | 0.10 |
| **P8 safety** | no malformed SQL, corrupt frame, or truncated file crashes the process — typed error or consistent success only | structured-fuzz SQL + byte-flip corruption of the on-disk file | 500 | 0.08 |
| **P9 budgets** | snapshot read ≤ L page-ops; compaction ≤ K page-ops for N live rows; commit ≤ M frames | sized workloads; oracle = deterministic page-op counter vs cap | 300 | 0.07 |
| **P10 determinism** | recovering the same crash image twice yields byte-identical state; replay is idempotent | crash image, recovered twice | 300 | 0.05 |
| | | **Σ ≈ 3900 seeds** | | **1.00** |

### 3.3 Bespoke discriminators & determinism rules (C5, C4)

- Bespoke on-disk: v2's WAL frame `[u32 len | u32 crc32 | u32 pageNo | payload]` + IEEE crc32 table, plus
  the **NEW version-chain record layout** (fixed in spec: `[u32 txnId | u32 commitSeq | u8 tombstone | payload]`),
  and the `E_CONFLICT/E_UNIQUE/E_CHECK/E_NOTNULL/E_CORRUPT` code taxonomy. A memorized generic engine
  fails these bespoke formats.
- **No wall-clock, no RNG in the arm.** The spec forbids `Date.now`, `performance.now`, `Math.random`; the
  grader stubs them to throw/freeze so any dependency fails loudly (a determinism violation is a bug, not a
  flaky test). All ordering (version chains, snapshot visibility, default SELECT) is fixed by commit
  sequence + PK, so output is byte-reproducible.
- **Concurrency is simulated, not threaded.** `begin()` returns a `Txn` object; the grader drives an
  interleaving of several open `Txn`s in a seed-determined statement order. No timers, no async races.

## 4. THE NO-CEILING GATE (mandatory protocol phase — runs BEFORE either real arm)

The gate is what makes v3's difficulty **measured, never assumed**. It is a phase, not a step you can skip.

### 4.1 Gate procedure
```
G0  Freeze a candidate (spec vN + reference + grader) and validate: reference ≥ 95% on EVERY property,
    stubs ≤ 5% overall, grader --twice identical (§10). If any property scores the reference < 95%,
    that is a BLOCKER (grader bug or unfair budget) — fix and re-validate before piloting.
G1  Gate pilot: ONE vanilla claude-opus-4-8 session, $10 cap, the FULL task, in a THROWAWAY fresh clone
    gate/pilot-<k>/  (identical prompt to ARM A's, §6.1). Grade with the frozen hidden grader.
G2  Decision:
      pilot_score ≥ 0.65  →  REJECT. Harden by a principled lever (§4.3), bump spec/grader version,
                             re-run G0 validation, then re-run G1 with a NEW pilot clone gate/pilot-<k+1>/.
      pilot_score < 0.65  →  ACCEPT. Freeze spec/reference/grader at this SHA. Proceed to §6 (real arms).
    Budget: 2–3 hardening iterations (k = 0,1,2). If still ≥ 0.65 after iteration 2, escalate to the
    orchestrator (the domain may be too memorable — consider option B, §3).
```

### 4.2 Leakage control (T-GATE-LEAK, §9)
- Each gate pilot runs in **its own throwaway clone** `gate/pilot-<k>/`, made fresh from `task-template`.
- **All pilot artifacts — diff, transcript, JSON, the pilot's source tree — are moved to `gate/quarantine/`
  and NEVER copied into `arm-a/`, `arm-b/`, `prompts/`, the reference, or the spec.** The pilot tells us
  *whether the task is hard enough*, never *how to solve it*.
- **Real-arm clones (`arm-a/`, `arm-b/`) are cut fresh from `task-template` at the FINAL frozen SHA, after
  the gate closes** — so no pilot state can seed a real arm. Acceptance check in §12 verifies
  `arm-*/` HEAD == the post-gate `task-template` HEAD and that `gate/` is not an ancestor.

### 4.3 Hardening levers (principled only — T-HARDEN, §9)
Each hardening iteration must use one of these and **document it in a before/after table** (§7):
1. **Add a property** (a new invariant or subsystem interaction).
2. **Widen a generator's probe space** — more seeds, deeper difficulty tiers (e.g. crash sweep at sub-frame
   byte offsets; larger interleaving depth K; longer op sequences).
3. **Tighten a resource budget** (lower a page-op or file-size cap toward — never below — the reference's own cost).
4. **Add a bespoke discriminator** (a new on-disk format detail or error code).

**FORBIDDEN lever (this is the whole point of the rule):** blacklisting the specific seeds the pilot
failed, or reverse-engineering the pilot's particular bug and adding a targeted probe for it. Hardening
must make the task *categorically* harder for *any* session, not tuned against one pilot's mistakes.
The hardening log records: iteration, lever used, pilot score before/after, reference re-validation result.

## 5. Grader contract — the fuzz grader (the big build)

```
node grader/grade.mjs --root <abs path to an arm working copy> --out <results json> [--seedbase 0xB102] [--twice]
```
Loads a harness that, per property `P_i`, runs seeds `seedbase ⊕ i·offset + (0..N_i-1)` through a seeded
PRNG (mandated `mulberry32` fixed in the grader), builds an instance with `G_i`, drives the arm's modules
(imported from `${root}/src/*.mjs`) with `Math.random`/`Date.now` stubbed (§3.3), computes the oracle `O_i`,
and counts survivals. **Always exits 0** (a low score is a *result*, not infra failure); arg errors exit 2.

### 5.1 Scoring math (designed so mid-band is the EXPECTED outcome for both arms)

For property `P_i` with `N_i` seeds and survival count `s_i`:
```
survived(seed) := O_i(seed) == pass                       # correctness oracle
             AND pageOps(seed)   <= cap_i                 # deterministic time proxy (§5.2)
             AND peakPages(seed) <= mem_i                 # deterministic memory proxy (§5.2)
f_i    := s_i / N_i                        ∈ [0,1]        # granular per-property partial credit
Score  := Σ_i  w_i · f_i                                  # weighted total, reported as %
```
Three design choices make a **mid-band the expected result, and informative for BOTH arms**:

1. **Difficulty-stratified seeds.** Each `G_i` partitions its `N_i` seeds into tiers — ≈40% *nominal*
   (most correct impls pass), ≈35% *boundary* (exact frame offsets, tie schedules), ≈25% *adversarial*
   (pathological interleavings, deep corruption). A correct-but-unhardened impl clears nominal, loses a
   chunk of boundary+adversarial → `f_i ≈ 0.45–0.75`. A hardened impl → `0.85–0.98`. A broken subsystem →
   `< 0.30`. This spreads `f_i` across the band **by construction**, not by luck.
2. **Compounding amplifies dispersion (the discrimination engine).** Late properties run on the arm's *own*
   pager/wal/btree/mvcc. A subtle P1 recovery edge (one frame offset) simultaneously depresses P2, P4, P6,
   P10 — every property that reopens the store. So a *single* early flaw the arm's own smoke never caught
   costs fractional credit across ~half the properties. This is precisely the "early subtle flaws surface
   only in late property probes" mechanism, and it is why continuous `f_i` (not binary) is essential.
3. **Continuous credit forbids the ceiling.** With ~3900 adversarial seeds, `Score = 1.0` requires *every*
   seed on *every* property to pass — statistically implausible for a hand-written 4–8k-LOC engine. `Score
   = 0` requires a dead subsystem. **Neither arm can saturate; both are pushed into a discriminating band.**

**Expected bands (design targets; the gate MEASURES the pilot):**

| Actor | Expected `Score` | Rationale |
|---|---|---|
| Reference (validation) | 0.95–0.99 | correct + budget-tuned; **must be ≥ 0.95 each property** (§10) |
| Shipped stubs | ≤ 0.05 | throw not-implemented |
| **Gate pilot (must MEASURE < 0.65 to accept)** | target < 0.65 | one unaided opus session cannot harden every property |
| **Real arms (the exhibit)** | **≈ 0.45–0.85, dispersed** | mid-band by construction; the A/B gap is the signal |

### 5.2 Resource budgets (declared in spec — fairness) and why they are deterministic

Budgets are **deterministic proxies**, never wall-clock (which would break reproducibility, §3.3):
- **Time proxy = page-op count.** The grader reads the arm's mandated `db._pagerStats()` →
  `{reads, writes, peakPages}` (or wraps the arm's `openPager` handle) before/after each probe. Page I/O is
  the real cost driver in a storage engine and is fully deterministic. Caps (stated per property in spec):
  e.g. *"a snapshot read of a table with R rows must touch ≤ 2·⌈R/keysPerPage⌉ + 4 pages"*; *"compact() of
  a store with V live rows must run in ≤ 6·V page-ops."* A naive O(R²) visibility scan or a full-file-rewrite
  compaction **blows the cap deterministically → sheds P9 (and P6/P2) credit** even while correct. This is
  req 4: naive-but-correct implementations shed points.
- **Memory proxy = `peakPages` + on-disk file size.** After `compact()`, the file must be ≤ a stated
  fraction of the pre-compaction size; `peakPages` caps the page cache. Both deterministic.

Both proxies are **declared in the spec per property**, so budgets are fair (both arms know the exact caps,
just not the seeds). `_pagerStats()` is a mandated public method — both arms implement it (spec contract).

### 5.3 Grader output JSON
```json
{"score": 0.612,
 "properties": {
   "P1_recovery":   {"weight":0.15,"seeds":500,"survived":362,"fraction":0.724,"oracleFails":121,"budgetFails":17},
   "P2_snapshot":   {"weight":0.12,"seeds":400,"survived":250,"fraction":0.625,"oracleFails":140,"budgetFails":10},
   "…": {}
 },
 "determinism": {"ranTwice": true, "identical": true},
 "meta": {"seedbase":"0xB102","specVersion":"v3.2","refFloorOK":true}}
```
`fraction` per property is the **discrimination exhibit** (§7). `oracleFails` vs `budgetFails` separates
"wrong" from "too slow" — a correct-but-slow arm shows high `budgetFails`, low `oracleFails`.

## 6. Arm procedures — frozen commands (canonical shell: Git Bash). `B102=/c/Users/AI/Documents/bench102`

`MODEL=claude-opus-4-8` for the gate pilot, ARM A, and ARM B plan creation. Procedures mirror v2 §6; only
the fairness clause and caps change.

### 6.1 ARM A — one vanilla opus session
```bash
cd $B102/arm-a
start=$(date +%s)
claude -p "$(cat ../prompts/arm-a.txt)" --output-format json --verbose \
  --permission-mode acceptEdits --max-budget-usd 60 --model "$MODEL" \
  --strict-mcp-config --allowedTools "Read,Write,Edit,Bash,Glob,Grep" \
  > ../results/arm-a.json 2> ../results/arm-a.stderr
echo $(( $(date +%s) - start )) > ../results/arm-a-wall.txt
git add -A && git diff --cached > ../results/arm-a.diff
```
`prompts/arm-a.txt` (frozen) = preamble + `spec.md` verbatim. **Fairness clauses (identical to what ARM B
agents learn, and to the gate pilot):** the preamble states that (a) the entry-point modules are mandated;
(b) `smoke/*.test.mjs` ship in the repo and should be run; (c) **the hidden grader probes each stated
property with hundreds of seeded deterministic generators — crash-point sweeps across every WAL frame
boundary, seeded transaction interleavings, and malformed-input/corruption generators — and scores granular
partial credit per property, so harden every property against boundary and adversarial cases yourself**;
(d) **stated resource budgets (page-op and file-size caps, per property in the spec) are enforced — a
correct-but-slow implementation loses points**; (e) build in dependency order and verify each subsystem.
Same information, no instance enumeration.

### 6.2 ARM B — plan tool
Identical structure to v2 §6.2 (ingest spec via RAG → opus plan creation → runner `--inject --lean`).
Deltas only:
```bash
# plan creation (opus; tokens COUNT toward ARM B)
claude -p "$(cat ../prompts/arm-b-plan.txt)" --output-format json \
  --permission-mode acceptEdits --max-budget-usd 15 --model "$MODEL" \
  --allowedTools "Read,mcp__plan-ledger__rag_status,mcp__plan-ledger__rag_ingest,mcp__plan-ledger__rag_query,mcp__plan-ledger__rag_cite,mcp__plan-ledger__create_plan,mcp__plan-ledger__add_step,mcp__plan-ledger__add_file_ref,mcp__plan-ledger__link_items,mcp__plan-ledger__write_carry_forward" \
  > ../results/arm-b-plan.json
PLAN=$(node -e "const r=JSON.parse(require('fs').readFileSync('../results/arm-b-plan.json','utf8'));console.log(/PLAN_ID=(\d+)/.exec(r.result)[1])")
# execution — NO --model (tier map applies); inject+lean; VERIFY gate + per-step usage already in runner
node /c/Users/AI/Documents/plan-ledger/scripts/runner.mjs --plan "$PLAN" --live --inject --lean \
  --budget 10 --max-total-usd 50 --max-attempts 2 --permission-mode acceptEdits \
  --allowed-tools "Read,Write,Edit,Bash,Glob,Grep" 2>&1 | tee ../results/arm-b-runner.log
```
`prompts/arm-b-plan.txt` (frozen) instructs the planner to produce a plan `stratum-mvcc ARM B` exhibiting
the v2 web structure — decompose-by-concern (step 1 = contract skeleton of all modules incl. `_pagerStats`,
last step = a dedicated full-stack property-hardening + crash-sweep integration pass), `builds_on` links,
pre-seeded `carry_forward`, `add_file_ref(spec.md)` + `SPEC: read spec.md §<Property> before coding`
(reference-not-copy), a `VERIFY: node --test smoke/<subsystem>.test.mjs` per step, and role tags per the
tier policy. **The planner's `arm-b-plan.txt` carries the same fairness clause as ARM A** (it must plan
against the property/seed/budget reality, without instance enumeration).

### 6.3 Grade
```bash
cd $B102; git -C grader checkout -- .
node grader/grade.mjs --root "$(pwd)/arm-a" --out results/arm-a-grade.json --twice
node grader/grade.mjs --root "$(pwd)/arm-b" --out results/arm-b-grade.json --twice
```

## 7. Metric extraction — v2 set + the discrimination exhibit

- **Discrimination exhibit (headline):** per-property `fraction` for **both arms side by side** + the
  reference column, from `arm-{a,b}-grade.json .properties[*].fraction`. Mid-band expected; **the per-property
  A−B delta is the quality signal v1/v2 could not produce.** Include `oracleFails` vs `budgetFails` split.
- **v1/v2 cost/token/turns set:** ARM A one-liner over `arm-a.json` (`total_cost_usd`, `num_turns`, 3-way
  input split, `output_tokens`, `duration_ms`, `is_error`); ARM B runner aggregate usage line
  (`runner.mjs:360`).
- **ARM B per-step attribution:** from the DB `attempts.result` `usage: in=… out=… cost=$… model=…` lines
  (`runner.mjs:31`), via the v2 §7 DB one-liner. Per-step sum must equal the runner aggregate.
- **Score-vs-spend if a cap binds (NEW):** if either arm hits its ceiling (`is_error`/spend stop), grade the
  truncated tree, record per-property `fraction` **at truncation** + the spend, and flag it a truncation
  artifact (not a clean comparison). For ARM B also record which plan steps were `done` vs unreached.
- **ARM A thrash:** `num_turns`, `duration_ms`, and `grep -Eoc` of repeated `Edit` of the same `src/*.mjs`
  in `arm-a.json` (v2 §7) — a single-session-discipline indicator on a task now hard enough to induce rework.
- **The gate hardening log:** the before/after pilot-score table (§4.3), included in the report as the
  evidence that difficulty was measured, not assumed.

## 8. Budget reality check (orchestrator MUST read)

v2 actuals: ARM A **$9.17**, ARM B **$8.19** at ~1500-LOC nominal (arm diffs 915 / 1318 lines; reference
757 LOC — `wc -l` of `bench100/grader/reference/src`). v3 targets a **4–8k-LOC reference** (5–10×) and a
*harder* task that induces more thrash. Scaled estimate:

| Arm / phase | v2 actual | v3 estimate | Cap (§6) | Headroom |
|---|---|---|---|---|
| Gate pilot (×1–3 iterations) | — | **$5–9 each** | **$10** (mandated) | OK; ×3 = ≤ $30 gate budget |
| ARM A session | $9.17 | **$30–55** (opus, 5× code + hard-task thrash) | **$60** | OK |
| ARM B plan creation | $4.63 | **$8–14** (bigger spec, more links/carry_forward) | **$15** | OK |
| ARM B execution | $3.56 | **$25–45** (2 opus bookends + ~8–12 sonnet stages, bigger codebase, per-cold-agent cache) | **$50** (`--max-total-usd`) | thin — may bind |
| **ARM B total** | $8.19 | **$33–59** | **$65** | OK if execution ≤ $50 |

**Recommended ceilings:** ARM A `--max-budget-usd 60`; ARM B plan `--max-budget-usd 15` + runner
`--max-total-usd 50` + per-agent `--budget 10`; gate pilot `--max-budget-usd 10` (mandated). A spend stop is
a valid result (grade whatever exists, no top-up) but weakens the head-to-head — §7 records it as a
score-vs-spend artifact. **Calibrate first** in spike S1 (§12): one $5-capped opus pilot on the MVCC+txn
subsystems only, to check the envelope before committing the full-run caps.

## 9. Threats to validity (report verbatim in the results doc)

Inherit **T1–T9** (`BENCHMARK_DESIGN.md` §12) and v2's **T-SHAPE, T-TIER, T-CF, T-ATTR, T-VERIFY,
T-STUB-LEAK** (`BENCHMARK_V2_DESIGN.md` §9). New/amended for v3:

- **T-GATE-LEAK (new, load-bearing).** The gate pilot could seed the real arms with a solution.
  **Control:** throwaway pilot clones, `gate/quarantine/` for all pilot artifacts, real-arm clones cut
  fresh from the post-gate `task-template` SHA (§4.2). The report must show `arm-*/` HEAD == post-gate
  template HEAD and that no pilot file appears in the arm trees.
- **T-HARDEN (new, load-bearing).** Hardening could be tuned against the pilot's specific failures,
  producing a task that's hard *for that pilot* but not categorically. **Control:** principled levers only
  (§4.3), a documented per-iteration hardening log, and an explicit ban on blacklisting the pilot's failing
  seeds or targeting its specific bug. The report publishes the hardening log so the difficulty is auditable.
- **T-GRADER (new, dominant at this scale).** A 4–8k-LOC reference + ~3900-seed fuzz grader is where a
  grader bug hides. **Control (§10):** reference must score **≥ 95% on EVERY property** (not 100% — justified
  in §10); stubs ≤ 5%; `--twice` byte-identical. Any property with reference < 95% is a BLOCKER (oracle bug
  or unfair budget) — fixed before freeze. This is the reference-vs-grader validation protocol.
- **T-PROP-DEP (new).** Properties are not independent — compounding (§5.1 point 2) means one early flaw
  depresses several `f_i`. This is *intended* (it's the discrimination engine) but confounds per-property
  attribution: read the **first heavily-depressed property in dependency order** as the causal break, not
  each low `f_i` as an independent weakness (same caution as v2 T-ATTR, one layer up).
- **T-SHAPE′ (amended).** v3's task is chosen to be *hard*, not just decomposition-favouring. But hardness
  is **symmetric** — both arms face the identical property grader — so it does not bias the A/B comparison;
  it only restores quality-axis headroom that v1/v2 lacked. The task-shape bias (layered → favours
  decomposition) is unchanged from v2 and still means v3 measures a *conditional* claim, read as a triplet
  with v1/v2.
- **T-TIER (carried).** The cost comparison still confounds decomposition with the role→model tier map
  (v2 Finding 1). A clean isolation would run ARM B with all agents on one model; out of scope here, noted.
- **T-DETERMINISM (new).** Any residual arm non-determinism breaks reproducibility. **Control:** grader
  stubs `Math.random`/`Date.now`, and `--twice` asserts byte-identical grades; a non-identical `--twice` is
  a BLOCKER for that arm's result.
- **T1 n=1.** One task, one run per arm (plus 1–3 gate pilots). Point estimates; cheapest upgrade is 3
  runs/arm. The gate pilot is **not** an arm and its score is reported only as the difficulty measurement.

## 10. Reference-vs-grader validation — and why the floor is 95%, not 100%

Before the gate and before either arm, the grader is validated against the hidden reference:
```
node grader/grade.mjs --root grader/reference --out results/ref-grade.json --twice
node grader/grade.mjs --root task-template     --out results/stub-grade.json      # shipped stubs
```
**Gates:** every property `fraction ≥ 0.95` for the reference; overall `≤ 0.05` for stubs; reference
`--twice` identical.

**Why ≥ 95% and not 100% (justification of the floor).** Requiring the reference to be *perfect* would
force the grader's generators and budgets to be *loose enough that a correct reference never loses a
single seed* — which is exactly the pressure that produced v1/v2's saturation (loosen until nothing
discriminates). v3 deliberately sets some resource budgets **near the reference's own cost** (§5.2) and
lets generators reach genuinely-pathological tail instances the spec permits an implementation to *reject*
(a rejection the oracle may or may not count as "survived"). Under that design, a legitimately-correct
reference can drop a few seeds at the extreme tail. So:
- **100% floor → forces an under-discriminating grader** (the v1/v2 failure). Rejected.
- **95% floor → the grader is trustworthy** (a property where the *reference* scores < 95% signals a real
  grader bug or an unfair budget, caught and fixed) **while preserving discriminating difficulty** (budgets
  and tails stay aggressive). A 5-percentage-point reference margin is small enough to catch oracle/budget
  bugs and large enough to keep the task hard.
- **Any property with reference < 95% is a BLOCKER**: either the oracle is wrong, or the budget is set below
  the reference's honest cost (unfair) — diagnose via the `oracleFails`/`budgetFails` split (§5.3) and fix
  before freezing. The reference floor is thus both a grader-correctness gate and a fairness gate.

## 11. Blast radius

This design doc is **docs-only** (adds `docs/BENCHMARK_V3_DESIGN.md`; touches no code). Evidence:
```
grep -rl "BENCHMARK_V3|bench102" plan-ledger/docs  →  (none — no prior reference to collide)
existing bench dirs: /c/Users/AI/Documents/{bench97, bench100}   (bench102 is new)
```
- **No plan-ledger code change.** The runner features v3 relies on (VERIFY gate `runner.mjs:294-346`,
  per-step usage `runner.mjs:31,360`, inject/lean/tier `runner.mjs:203,241`) are already in `main`
  (`c10764d`, `fca106c`) — v3 changes none of them, unlike v2 which had to build them (v2 §2).
- **No schema / persisted-data change.** The plan-ledger DB is only appended to via its normal API (a new
  plan `stratum-mvcc ARM B` + its steps/links/attempts, and a `stratum-mvcc-spec` RAG source) — no
  migration; expand→migrate→contract not applicable.
- **New filesystem tree** `C:/Users/AI/Documents/bench102/` created fresh (parallels `bench97`/`bench100`;
  no collision — `ls -d bench*` shows only 97 and 100 exist today).

## 12. Execution steps (maps onto plan #102's build/gate/run steps)

| # | Step (role) | Digest (self-contained context carries: the cited §, the contracts in §13, the fairness clause) | Binary acceptance | Verify command (PS 5.1 / Git Bash safe) | Depends |
|---|---|---|---|---|---|
| **S1** | Spike: env + reference-floor feasibility (architect + build-devops) | Falsifiable: (a) does installed `claude` accept the §6 flags on `claude-opus-4-8`? (b) can a **2-property prototype grader** (P1 recovery + P5 constraints) validate a stratum-mvcc reference-subset ≥ 95% while stubs ≤ 5%? (c) does a $5 opus pilot on MVCC+txn fit the §8 envelope? (d) confirm extend-stratum over replicated-log per §3 flip condition | all Qs answered yes/no with pasted output; prototype reference ≥ 0.95 on both props; stub ≤ 0.05; $5 pilot cost recorded; domain decision recorded | `node grader-proto/grade.mjs --root grader-proto/reference` → both fractions ≥ 0.95; `--root stub` → ≤ 0.05 | — |
| **B1** | Author `spec.md` (architect + tech-writer) | Property-stated spec from §3.2 + contracts §13 + per-property resource budgets §5.2 + fairness clause §6.1 + per-subsystem worked examples; **NO instance tables** | spec states ≥ 10 properties each with a probe description + a numeric budget; contains the "seeded generators / granular partial credit / enforced budgets" clause; contains zero fixed test-vector tables | `grep -c '^## Property P' spec.md` ≥ 10; `grep -c 'seeded deterministic generators' spec.md` ≥ 1 | S1 |
| **B2** | Build reference `stratum-mvcc` (implementer ×N by subsystem; ≤ ~400 LOC/step) | Extend v2 modules + `src/mvcc.mjs`, txn/constraints/compaction in `db.mjs`, `_pagerStats()`; each subsystem step compiles + passes its smoke | `node --check src/*.mjs` clean; per-subsystem smoke green; `_pagerStats()` returns `{reads,writes,peakPages}` | `node --test smoke/` exits 0; `node -e "import('./src/db.mjs')…_pagerStats()"` prints the 3 keys | B1 |
| **B3** | Build the fuzz grader (test-engineer + build-devops; the big one) | Generators `G_1..G_10`, oracles `O_i`, `mulberry32` PRNG, instrumented page-op/mem budgets, `Math.random`/`Date.now` stubs, `grade.mjs` §5.3 JSON, `--twice` | **reference ≥ 0.95 EVERY property AND stubs ≤ 0.05 AND `--twice` identical** (§10) | `node grader/grade.mjs --root grader/reference --out /tmp/ref.json --twice` → every `.properties[*].fraction ≥ 0.95` & `determinism.identical==true`; `--root task-template` → `score ≤ 0.05` | B2 |
| **B4** | Stubs + smoke + prompts + arm clones (build-devops) | `task-template` stubs (throw not-implemented), public smoke subset, `prompts/{arm-a,arm-b-plan,review}.txt` with the §6.1 fairness clause; record SHAs | 3 prompt files exist with the fairness clause; `arm-a`/`arm-b` are clones at template SHA | `grep -c 'seeded deterministic generators' prompts/arm-a.txt` ≥ 1; `diff <(git -C arm-a rev-parse HEAD) <(git -C task-template rev-parse HEAD)` equal | B3 |
| **G1** | **No-ceiling gate loop** (build-devops; ≤ 3 iterations) | §4 protocol: fresh `gate/pilot-<k>/`, $10 opus full-task pilot, grade; if ≥ 0.65 harden by a §4.3 lever (logged), bump version, re-validate reference ≥ 0.95, re-pilot fresh; quarantine all pilot artifacts | final `pilot_score < 0.65` AND reference still ≥ 0.95 every property AND hardening log has one row per iteration AND no `gate/` file appears under `arm-*/` | `node -e "process.exit(JSON.parse(require('fs').readFileSync('results/pilot-final-grade.json')).score < 0.65 ? 0 : 1)"`; `grep -rl gate/ arm-a arm-b` → empty | B4 |
| **R1** | Run ARM A + grade (build-devops) | §6.1 then §6.3; no manual edits; arm-a cut fresh post-gate | `arm-a.json`, `arm-a.diff`, `arm-a-grade.json` exist; grade parses with a `.properties` map of 10; `determinism.identical==true` | v1 §8 extractor exits 0; `node -e "Object.keys(JSON.parse(require('fs').readFileSync('results/arm-a-grade.json')).properties).length"` == 10 | G1 |
| **R2** | Run ARM B + grade (build-devops) | §6.2 (ingest → plan → runner inject+lean) then §6.3 | `arm-b-plan.json` (`PLAN_ID=`), `arm-b-runner.log` (aggregate + ≥ 8 per-step `usage: in=` lines), `arm-b.diff`, `arm-b-grade.json` (10 properties) exist | §7 grep finds the aggregate usage line AND ≥ 8 per-step `usage: in=` lines; grade `.properties` has 10 keys | G1 |
| **R3** | Blind review (build-devops runs; reviewer = fresh independent session) | v1 §9 protocol, **independent** reviewer (fixes v1/v2 analyst-is-reviewer flaw) | `review.json` parses; `mapping.txt` unopened until scores recorded | `node -e "JSON.parse(require('fs').readFileSync('results/review.json'))"` | R1, R2 |
| **R4** | Findings report v1↔v2↔v3 (researcher + tech-writer) | `results/metrics.md` + `docs/BENCHMARK_V3_RESULTS.md`: per-property survived-fraction table both arms (the exhibit), gate hardening log, v1/v2/v3 comparative, per-step ARM B attribution, score-vs-spend if a cap bound, all threats §9 | every §7 metric present; both per-property `fraction` columns filled; hardening log included; every number traceable to a `results/` file | manual cross-check of table vs `results/` files | R3 |

R1/R2 run serially (avoid API rate-limit wall-time distortion, v1 §10). B2 splits across several
implementer steps (one subsystem each) to stay ≤ ~400 LOC/session; B3 may split generators from oracles if
either exceeds a session.

## 13. Contracts implementers code against (for B1–B3). Source of truth = `spec.md`.

```js
// src/db.mjs  (extended — NEW members tagged)
export function openDatabase(path, { pageSize = 4096 } = {});
//  → { exec(sql): {rows, rowCount},          // auto-commit single statement (v2)
//      begin(): Txn,                          // NEW — snapshot taken at begin()
//      compact(): {reclaimedPages:number},    // NEW — vacuum dead versions; preserve live rows + invariants; shrink file
//      close(opts?),                          // close({checkpoint:false}) = crash-sim seam (v2)
//      _pagerStats(): {reads:number, writes:number, peakPages:number} }  // NEW — deterministic budget oracle (§5.2)

// Txn (NEW)
//   txn.exec(sql): {rows, rowCount}   // reads see txn's snapshot; writes buffered in the txn's version
//   txn.commit()                       // first-committer-wins: throws SqlError E_CONFLICT if a concurrent
//                                       //   commit wrote an overlapping key after this txn's snapshot
//   txn.rollback()                     // discard buffered writes; store byte-identical to pre-begin
//   txn.id: number

// src/mvcc.mjs  (NEW)  — version chains keyed by (txnId, commitSeq); visibility rule fixed in spec.
//   version record on disk: [u32 txnId | u32 commitSeq | u8 tombstone | payload]  (little-endian)

// src/sql.mjs  (extended) — CREATE TABLE constraints: PRIMARY KEY, UNIQUE, NOT NULL, CHECK(<expr>).
export class SqlError extends Error { code; } // v2 codes + E_CONFLICT | E_UNIQUE | E_CHECK | E_NOTNULL | E_CORRUPT

// Grader entry (B3):
// node grader/grade.mjs --root <arm> --out <json> [--seedbase 0xB102] [--twice]  → §5.3 JSON, exit 0.
```
v2's `pager.mjs`/`wal.mjs`/`btree.mjs` signatures and on-disk formats carry over unchanged (`BENCHMARK_V2_DESIGN.md`
§13). Stub modules throw `Error("not implemented: <fn>")` so the grader scores them ≤ 5% without crashing.

---

## 14. Self-check (Definition of done)

- [x] **Design doc at a stated repo path; diff docs-only.** `C:/Users/AI/Documents/plan-ledger/docs/BENCHMARK_V3_DESIGN.md`; no code/tests/scripts (B2/B3 own those; runner already has the features — §11).
- [x] **Every referenced existing symbol cited with a real path.** `runner.mjs` (VERIFY gate 294-346, per-step usage 31,360, inject/lean/tier 203,241, buildDirectPrompt 211-235, usageLine 360); `plan-roles.json` `roles`; v2 grader pattern (`bench100/grader/grade.mjs`, reference 757 LOC via `wc -l`). NEW items tagged (`stratum-mvcc` modules, properties P1–P10, `bench102/` tree, `stratum-mvcc-spec` RAG source, `_pagerStats`/`Txn`/`mvcc.mjs`).
- [x] **2–3 alternatives vs criteria stated first, one recommendation.** Task table §3 (A extend-stratum / B replicated-log / C from-scratch on C1–C6 → A); the no-ceiling-vs-assumed-difficulty decision is embodied in §4; grader-floor 95-vs-100 decided in §10.
- [x] **Cross-component contracts at code precision.** §13 (extended `db.mjs`/`Txn`/`mvcc.mjs`/`SqlError` codes + version-record layout) + §5 grader JSON + §5.1 scoring math + §5.2 budget formulas.
- [x] **Blast radius enumerated with grep evidence.** §11 (docs-only; no v3/bench102 refs; `bench102` new vs `bench97`/`bench100`; no runner code change; no schema/migration).
- [x] **Schema/persisted-data change plan.** None — §11: DB append-only via normal API; expand→migrate→contract N/A.
- [x] **Step list dependency-ordered, self-contained, binary acceptance + runnable verify.** §12 (S1→B1→B2→B3→B4→G1→R1..R4), each with a command.
- [x] **No-ceiling gate is a mandatory phase with leakage control + ≤3 hardening iterations.** §4 (procedure, quarantine, principled levers, forbidden lever); step G1.
- [x] **Property-based grading that can't be saturated by spec-following + mid-band scoring math.** §3.2 (10 properties), §5.1 (continuous `f_i` + difficulty strata + compounding → mid-band expected), §5.2 (deterministic budgets so naive-but-correct sheds points).
- [x] **Reference-vs-grader validation with a justified reference floor.** §10 (≥95% every property, 100% rejected with reasoning, <95% is a BLOCKER).
- [x] **Fairness: identical property-stated spec + seeded-generator disclosure to both arms.** §1, §6.1, §6.2 (same clause to ARM A, ARM B planner, and the gate pilot).
- [x] **Caps estimated from v2 actuals + gate pilot $10.** §8 (v2 $9.17/$8.19 → v3 $60/$65 + $10 pilot), §1.

*Author: architect (plan #102 step 534). No plan-ledger code change required — v3 rides the runner's
existing VERIFY gate (`c10764d`) and per-step usage (`fca106c`). The one hard prerequisite is the
no-ceiling gate closing (§4/G1) before R1/R2 run.*

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
</content>
</invoke>
