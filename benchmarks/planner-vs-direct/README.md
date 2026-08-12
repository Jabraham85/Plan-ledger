# Planner vs Direct — scheduling benchmark

Self-contained A/B benchmark comparing an **explicit-planning** agent with a **direct/no-planning** agent on a difficult hidden deterministic scheduling task.

All artifacts live under `benchmarks/planner-vs-direct/`. The hidden grader is never copied into arm workspaces.

## Protocol

| Control | Value |
|---|---|
| Task | Renewable resource-constrained job scheduling (`solve(instance)` in `src/scheduler.mjs`) |
| Model / tools | **Identical** across arms — orchestration controls recorded by the operator, **not independently auditable** from benchmark artifacts alone |
| Prompt difference | **Only** the planning instruction (`prompts/direct.txt` vs `prompts/planner.txt`); planner arm adds explicit decomposition, staged verification, and reassessment discipline |
| Hidden grader | **Not exposed** to agents; run by orchestrator after each arm completes |
| Runs per arm | **n = 1** (single session each; outcomes are **indicative**, not statistically conclusive) |
| Determinism | Fixed benchmark seed `0x504c414e`; pure `solve()` required; grader calls twice per case |
| Arm roots | `arms/direct/` and `arms/planner/` (created by setup script) |

## Score formula (0–100)

```
overallScore = feasibilityPoints + qualityPoints
```

- **Feasibility (0–50):** `50 × (feasibleCases / totalCases)`. A case is feasible when the schedule is complete, integer starts, dependencies and capacities hold, input is not mutated, output is deterministic across two calls, and combined solve runtime is within the per-case budget.
- **Quality (0–50):** `50 × weightedMean(qualityRatio)` across **all** cases (total weight in denominator). For each feasible case, `qualityRatio = min(1, lowerBound / makespan)` where `lowerBound = max(criticalPathLength, max_r ceil(totalWork_r / capacity_r))`; invalid or timed-out cases contribute `0`. This prevents a solver from inflating quality by skipping difficult cases.
- **Weights:** most cases weight `1`; the hidden calibration gap case weights `5`.

## Per-case timeout (hard, enforceable)

Each hidden case runs in a **fresh worker thread** that:

1. Imports `src/scheduler.mjs` and signals **ready** (module load is **not** charged to the solve budget).
2. Receives the case from the parent; the parent starts a **400ms timer** and sends the instance.
3. Calls `solve()` **twice** on deep-cloned inputs, reporting both outputs, mutation status, and elapsed time.
4. Is **terminated** by the parent if the combined budget is exceeded.

Cases are graded **independently** — there is **no** order-dependent total-budget cascade. Worst-case wall time is roughly `49 × 400ms ≈ 20s` plus worker startup.

## Safe upper bound (< 100, possibly not tight)

Quality is measured against the **theoretical lower bound**, not the true optimum. The hidden suite includes a proven integrality-gap calibration instance:

- One resource, capacity `3`
- Three independent jobs, duration `1`, demand `2` each
- **Lower bound = 2** (critical path `1`, resource work `ceil(6/3) = 2`)
- **Proven optimum = 3** (at most one job fits at a time)

The grader asserts `LB = 2`, `optimum = 3` at startup via exhaustive search. With calibration weight `5` and 48 other cases, a **proven safe upper bound** on the quality fraction is `(48 + 5×⅔) / 53 ≈ 0.9686`, so:

```
safeUpperBound ≈ 50 + 50 × 0.9686 ≈ 98.43
```

This is a **safe upper bound**, not necessarily the tight maximum achievable score. Even an optimum solver may score below it.

## Hidden case groups (49 total)

| Group | Count | Description |
|---|---:|---|
| `chains` | 12 | Long chain dependencies |
| `forks` | 12 | Root → parallel branches → join |
| `packing` | 12 | Resource contention, few deps |
| `mixed-dag` | 8 | Random acyclic mixed graphs |
| `adversarial` | 4 | Multi-resource pinch / greedy traps |
| `calibration` | 1 | Proven LB/optimum gap (weighted ×5) |

Cases are generated deterministically from seed `0x504c414e`.

Group reporting includes both `avgQualityAllCases` (invalid cases count as 0) and `avgQualityFeasibleCases` (mean over feasible cases only).

## Commands

From repository root (`Plan-ledger`):

```bash
# 1. Prepare arm workspaces (no grader)
node benchmarks/planner-vs-direct/scripts/setup-arms.mjs

# 2. Visible smoke (expected to fail on stubs)
node benchmarks/planner-vs-direct/arms/direct/public-smoke.mjs

# 3. Hidden grade (stub should score low, not crash)
node benchmarks/planner-vs-direct/grader/grade.mjs \
  --root benchmarks/planner-vs-direct/arms/direct \
  --out benchmarks/planner-vs-direct/results/direct-stub.json

# 4. After both arms are run by agents:
node benchmarks/planner-vs-direct/grader/grade.mjs \
  --root benchmarks/planner-vs-direct/arms/direct \
  --out benchmarks/planner-vs-direct/results/direct.json

node benchmarks/planner-vs-direct/grader/grade.mjs \
  --root benchmarks/planner-vs-direct/arms/planner \
  --out benchmarks/planner-vs-direct/results/planner.json

node benchmarks/planner-vs-direct/scripts/summarize.mjs \
  --direct benchmarks/planner-vs-direct/results/direct.json \
  --planner benchmarks/planner-vs-direct/results/planner.json \
  --out benchmarks/planner-vs-direct/results/summary.json
```

### Optional orchestration treatments

`scripts/setup-orchestrated-arm.mjs` creates only `arms/orchestrated` and leaves the two original
implementations untouched. Run fresh agent contexts in sequence: architect (read-only brief),
implementer, test engineer/reviewer (including correction rounds), then performance engineer.
Grade with the same hidden suite and produce the three-arm comparison:

```bash
node benchmarks/planner-vs-direct/scripts/setup-orchestrated-arm.mjs
node benchmarks/planner-vs-direct/grader/grade.mjs \
  --root benchmarks/planner-vs-direct/arms/orchestrated \
  --out benchmarks/planner-vs-direct/results/orchestrated.json
node benchmarks/planner-vs-direct/scripts/summarize-three.mjs \
  --direct benchmarks/planner-vs-direct/results/direct.json \
  --planner benchmarks/planner-vs-direct/results/planner.json \
  --orchestrated benchmarks/planner-vs-direct/results/orchestrated.json \
  --out benchmarks/planner-vs-direct/results/summary-three-arm.json
```

This treatment is **not cost-normalized**: it uses four fresh agent contexts and therefore more
model compute than either single-agent arm. It measures the effect of specialist handoffs and
review, not a controlled planning-only variable.

The cost-aware treatment corrects that limitation. `scripts/setup-adaptive-arm.mjs` creates
`arms/adaptive` with lean project-local charters and a role map. It uses a lightweight model for
the short architecture and black-box test passes, a code-specialized model for implementation,
and dispatches correction or performance work only from measured evidence. The hidden grader is
still run once, after all public gates close; its output never drives an agent correction.

```bash
node benchmarks/planner-vs-direct/scripts/setup-adaptive-arm.mjs
node benchmarks/planner-vs-direct/grader/grade.mjs \
  --root benchmarks/planner-vs-direct/arms/adaptive \
  --out benchmarks/planner-vs-direct/results/adaptive.json
```

The exact dispatch record is saved as `results/adaptive-dispatch.json`. Exact token usage was not
available from the subagent runtime, so this treatment records model choice, dispatch count, and
correction rounds rather than claiming measured token-cost normalization.

## Agent instructions

Give each agent:

- Its prompt file (`prompts/direct.txt` or `prompts/planner.txt`)
- Its arm root (`arms/direct` or `arms/planner`)
- Instruction to read `task-spec.md` and `public-smoke.mjs` and edit only `src/scheduler.mjs`

Do **not** share `grader/` contents with agents.

## Interpretation caveat

A higher score on the planner arm does **not**, by itself, establish that explicit planning caused the improvement. With n=1, confounds (session variance, tool use, luck) are uncontrolled. Treat comparisons as indicative.

## Directory layout

```
benchmarks/planner-vs-direct/
├── README.md
├── task-spec.md
├── task-template/
│   ├── public-smoke.mjs
│   └── src/scheduler.mjs      # stub
├── arms/                       # created by setup
│   ├── direct/
│   ├── planner/
│   ├── orchestrated/
│   └── adaptive/
├── grader/
│   ├── grade.mjs               # hidden
│   └── worker.mjs              # hidden per-case executor
├── prompts/
│   ├── direct.txt
│   └── planner.txt
├── scripts/
│   ├── setup-arms.mjs
│   ├── setup-adaptive-arm.mjs
│   ├── setup-orchestrated-arm.mjs
│   ├── summarize.mjs
│   └── summarize-three.mjs
├── specialists/                # lean adaptive-arm role charters
└── results/                    # grade outputs
```

## Requirements

- Node.js **>= 22**
- No npm dependencies for the benchmark itself
