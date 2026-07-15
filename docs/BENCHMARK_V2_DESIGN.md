# BENCHMARK_V2_DESIGN — Layered self-building task, opus leaders, tiered agents (plan #100 step 3)

**Status:** design frozen 2026-07-14 · **Author role:** architect · **Executes as:** plan #100 steps 4–5
**Inherits:** `docs/BENCHMARK_DESIGN.md` (v1 protocol — every control, threat, and extraction
technique below is v1's unless amended here) and `docs/BENCHMARK_2026-07.md` (v1 results + the four
improvements this plan lands first).

**Claim under test (the task-shape bias is the point, stated openly):** *decomposition + role
dispatch pays off on layered work too large for one clean context — where a single vanilla session
degrades stage-over-stage.* v1 measured the plan tool's **worst case** (one task, four flat concerns,
one clean session — vanilla won 30/30 vs 29/30 at 5.4× less cost). v2 measures its **home turf**: a
6-stage project where stage N is unbuildable without correct stages 1..N-1, deliberately sized past
one clean context. If the plan tool still loses here, the thesis is wrong and we report that.

**What v2 changes vs v1 (at a glance):** (a) task is layered/self-building, ~4.3× v1's test count;
(b) both leaders (ARM A session, ARM B planner+orchestration) run **`claude-opus-4-8`**; (c) role
agents run the tier policy (`~/.claude/plan-roles.json`); (d) ARM B's plan MUST exploit the web
structure — `builds_on` links, pre-seeded `carry_forward`, `file_refs`/`SPEC:` reference-not-copy,
`VERIFY:` gate lines, decompose-by-concern; (e) grader is **staged** (per-stage + total + cross-stage
integration); (f) metrics add per-stage pass falloff per arm and per-step token attribution.

---

## 1. Controls (both arms) — delta from v1 §1 only

Everything in `docs/BENCHMARK_DESIGN.md` §1 holds. Amendments:

| Control | v2 value |
|---|---|
| Model (leaders) | `--model claude-opus-4-8` on **both** the ARM A session and the ARM B plan-creation session. Record it and `claude --version` in `results/metrics.md`. |
| Model (ARM B role agents) | Resolved by the tier policy `~/.claude/plan-roles.json`: **architect/debugger → opus**, **implementer/test-engineer/build-devops/refactor-surgeon → sonnet** (confirmed at `plan-roles.json:4-15`). The runner passes the map's per-role `model` per step (`runner.mjs:182,225`); **no `--model` flag on the runner** (an explicit `--model` would override the map — `runner.mjs:182`). |
| Budget ceiling | **$30 per arm** as directed — but see §8: on opus at this task size the honest design needs **~$45/arm**. $30 is set in the frozen commands and flagged as a truncation risk for the orchestrator. |
| Permission / MCP / tools | ARM A: `--strict-mcp-config`, `--allowedTools "Read,Write,Edit,Bash,Glob,Grep"`. ARM B execution: runner `--inject --lean` (strips MCP per agent) + identical `--allowed-tools`. Plan-creation session keeps plan-ledger MCP (it is the tool under test). |
| Token counting | v1 formula unchanged (`runner.mjs:162-164`). v2 adds **per-step** attribution from the step-521 runner logging (§7). |

## 2. Prerequisites landed BEFORE either arm runs (plan #100 steps 1–2)

This design *assumes these exist* — they are steps 521–522, which must be green first:

- **VERIFY gate (step 521, improvement #1).** A `VERIFY: <command>` line in a step's context is run
  by the runner (both modes) in the step's working dir *after* the agent exits; a `pass` verdict
  requires exit 0, else the runner records `verdict=fail` with the command's output tail. The inject
  prompt tells the agent the command will be enforced. **This is the fix for the MAX_CENTS class of
  miss** (v1's one failure self-reported `pass` with a latent bug; `docs/BENCHMARK_2026-07.md` §2).
- **Per-step token logging (step 521, improvement #4).** The runner persists per-step usage
  (`usage: in=X out=Y cost=$Z model=M` appended to the attempt `result`, console line kept), enabling
  per-step attribution (§7) that v1 could not produce (aggregate-only, `BENCHMARK_2026-07.md` §1 note¹).
- **Planning guidance (step 522, improvements #2 & #3).** Decompose-by-concern + reference-not-copy
  guidance in the `/plan` flow, so the plan-creation session points steps at `spec.md` in the clone
  instead of re-serialising it into every context.

If step 521 slips, v2 runs **without** the VERIFY gate and the design's fairness answer to T-VERIFY
(§9) collapses — do not run the arms until 521 is green.

## 3. The task — decision first

**Criteria (priority order):** L1 **layering depth** (stage N provably unbuildable without correct
1..N-1 — the experiment's whole premise) · L2 **grading objectivity** (exact I/O per stage ⇒ hidden
suite is indisputable, per-stage scores are partial-creditable) · L3 **context pressure** (total spec
+ code must exceed what one session holds cleanly, so ARM A degrades) · L4 **determinism headless**
(no wall-clock, no RNG, no process-kill; crash/recovery simulated via a public reopen seam) · L5
**memorisation resistance** (a memorised generic solution must fail bespoke on-disk formats / AST
shapes / error taxonomy) · L6 **env fit** (Node ≥ 22, `node:test`, zero deps, offline, Windows-safe).

| Option | L1 layering | L2 objectivity | L3 pressure | L4 determinism | L5 memo-resist | Verdict |
|---|---|---|---|---|---|---|
| **A. `stratum` — mini storage+SQL engine** (pager → WAL/recovery → B-tree → SQL parser → executor → transactions) | **hard physical boundaries**: recovery needs stage-2 WAL *format*; btree needs stage-1 *pager*; executor needs parser+btree; txn needs WAL+executor. Cannot fake a stage. | exact module APIs + on-disk behaviour; per-stage groups + full-stack integration | 6 stages, ~1500 LOC ref, ~130 tests — well past one clean context | crash = public `close({checkpoint:false})`+reopen (no signals); fixed iteration order | bespoke WAL frame + AST JSON + error codes a generic SQLite clone won't match | **RECOMMENDED** |
| B. mini language (lexer → parser → evaluator → closures → stdlib → modules) | softer: evaluator/closures/stdlib share **one AST in memory** — a monolith can ignore stage seams, so "unbuildable without prior stage" is weaker | exact token/AST/eval-result contracts | 6 stages, similar size | fully deterministic | bespoke grammar + builtin set | **ALTERNATE** |
| C. mini regex/VM, mini spreadsheet, mini Git | each has ≤4 genuinely-dependent stages or needs time/FS mocking | good | thinner | mixed | mixed | rejected (fewer hard layers) |

**A wins on L1, the criterion that *is* the experiment.** `stratum` has **physical artefacts between
stages** — a binary page file and a WAL file — so a stage literally cannot be built without its
predecessor's *correct on-disk output*: you cannot write crash-recovery (stage 2) without the pager's
page layout (stage 1); you cannot range-scan a B-tree (stage 3) without pages to store nodes in; the
executor (stage 5) has nothing to execute without the parser's AST (stage 4) and nowhere to put rows
without the B-tree; transactions (stage 6) are meaningless without the WAL and the executor. In B, a
clever single session can write one `eval()` over an AST and satisfy stages 3–6 in one file, blurring
the falloff signal v2 exists to measure. **Evidence that would flip to B:** if a pilot shows ARM A's
`stratum` per-stage scores are *not* monotonically falling (i.e. it does *not* degrade late-stack, so
the layering doesn't create the predicted context pressure), rerun on B where the stages are smaller.

### 3.1 `stratum` — the six stages (this section is the seed for `spec.md`)

Working name **`stratum`** (bespoke, layered — reduces training-data leakage vs "minidb"). Node ≥ 22,
ES modules, **zero dependencies**, offline. **Mandated module entry points** (the grader imports
exactly these paths — like v1 mandated `src/cli.mjs`; anything else scores 0 for that stage). Both
arms get the identical mandate, so neither file layout is advantaged. All numeric encodings
little-endian; all determinism knobs (iteration order, default sort) fixed by the spec so output is
byte-reproducible with no clock/RNG.

| Stage | Module | Public API (exact signatures fixed in spec.md) | Builds on |
|---|---|---|---|
| **1 Pager** | `src/pager.mjs` | `openPager(path,{pageSize=4096})` → `{readPage(n):Buffer, writePage(n,buf), allocatePage():number, pageCount():number, flush(), close()}`. File = header page 0 (`magic "STRM"`, u32 pageSize, u32 pageCount) then fixed-size pages. | — |
| **2 WAL/recovery** | `src/wal.mjs` | `openWal(path)` → `{append(bytes:Buffer), frames():Frame[], checkpoint(pager), truncate(), close()}`. Frame = `[u32 len][u32 crc32][u32 pageNo][payload]`; `crc32` = the IEEE table fixed in spec. **Recovery:** on `openDatabase` reopen, un-checkpointed frames replay into the pager. | 1 |
| **3 B-tree** | `src/btree.mjs` | `openBTree(pager, rootPageNo=1)` → `{insert(key,val), get(key):val\|null, rangeScan(lo,hi):[key,val][], delete(key), root():number}`. Keys = utf8 strings; ordering = bytewise; nodes persisted through the pager; survives reopen. | 1 |
| **4 SQL parser** | `src/sql.mjs` | `parse(sql):AST` for `CREATE TABLE`, `INSERT`, `SELECT` (`WHERE`, `ORDER BY`, `LIMIT`), `DELETE`, `BEGIN/COMMIT/ROLLBACK`. AST is an **exact JSON shape** (fixed in spec). Errors throw `SqlError` with fixed `.code` (e.g. `E_PARSE`, `E_UNEXPECTED_TOKEN`). | — (pure) |
| **5 Executor** | `src/db.mjs` | `openDatabase(path)` → `{exec(sql):{rows:object[],rowCount:number}, close(opts?)}`. Runs the AST over btree-backed tables via the pager. `SELECT` without `ORDER BY` returns **rows in primary-key ascending order** (determinism). | 1,3,4 |
| **6 Transactions** | (in `src/db.mjs`) | `BEGIN/COMMIT/ROLLBACK` via the WAL. `ROLLBACK` discards; `COMMIT` then crash → data survives; crash before `COMMIT` → data gone. Crash simulated by `close({checkpoint:false})` + reopen. | 2,5 |

**Crash-recovery seam (deterministic, headless, no signals):** the grader opens a DB, runs ops, calls
`db.close({checkpoint:false})` (drops in-memory buffers *without* checkpointing the WAL into the page
file), reopens, and asserts recovered vs discarded state. No `SIGKILL`, no timers — same corpus ⇒
byte-identical result.

**Bespoke discriminators (L5 — a memorised engine fails these):** exact WAL frame layout incl. the
fixed crc32 table; the exact AST JSON keys; the `SqlError.code` taxonomy; `SELECT`-default primary-key
ordering; `pageSize=4096` header magic `"STRM"`; recovery replays *only* un-checkpointed frames (an
over-eager replay double-applies and fails). Both arms share any residual leakage equally.

## 4. Repo / directory layout (parallels v1 §4)

```
C:/Users/AI/Documents/bench100/
  task-template/            # git repo — THE frozen baseline (record HEAD SHA)
    spec.md                 # §3.1 expanded: exact signatures, on-disk formats, AST JSON, error table,
                            #   and a per-stage WORKED EXAMPLE the grader replays
    package.json            # {"name":"stratum","type":"module","private":true} — no test script
    src/{pager,wal,btree,sql,db}.mjs   # STUBS: each export throws Error("not implemented: <fn>")
    smoke/stage{1..6}.*.test.mjs        # SHIPPED public smoke — a weaker subset of the hidden suite
  grader/                   # NEVER cloned into an arm; own git repo for pristine restore
    grade.mjs               # §5 contract
    tests/{pager,wal,btree,parser,executor,txn}.test.mjs   # hidden staged suite (~120)
    tests/integration.test.mjs                             # cross-stage / full-stack (~10)
    reference/src/*.mjs     # hidden reference solution — must score 100%
  prompts/{arm-a.txt, arm-b-plan.txt, review.txt}
  arm-a/  arm-b/            # git clones of task-template (agents see spec.md + stubs + smoke ONLY)
  results/                  # everything the report is built from
```

**Public smoke vs hidden grader.** The clone ships `smoke/stageN.*.test.mjs` — a *thin* public
acceptance check per stage (replays the spec's worked example; catches gross breakage, the MAX_CENTS
class). These are what the ARM B `VERIFY:` lines run and what ARM A is told to run. The **hidden
grader is a strict superset** (all the boundary/adversarial cases) and is the **only arbiter**. Both
arms get the identical public smoke, so the VERIFY gate is not a hidden ARM-B advantage (T-VERIFY, §9).

## 5. Grader contract (extends v1 §5 to staged scoring)

```
node grader/grade.mjs --root <abs path to an arm working copy> --out <results json>
```
Runs `node --test grader/tests/` with env `STRATUM_ROOT=<path>`; each test imports
`${STRATUM_ROOT}/src/<module>.mjs`. Always exits 0; writes and prints:
```json
{"total":130,"passed":97,"failed":33,
 "stages":{"pager":[18,18],"wal":[16,20],"btree":[20,22],"parser":[17,18],"executor":[18,24],"txn":[6,18]},
 "integration":[2,10]}
```
- **Per-stage `[passed,total]`** = the falloff curve (§7). **`total`/`passed`** = headline.
- **Compounding is intrinsic and intended:** stage-N groups exercise the arm's *own* stages 1..N (the
  btree tests use the arm's pager, the executor tests use the arm's parser+btree+pager). So a broken
  low stage caps every stage above it — **the first cliff in the falloff curve localises the break.**
  This is the honest reading and must be stated in the R4 report, not smoothed over.
- **`integration`** = end-to-end SQL through txn+crash-recovery, the purest "does the whole stack
  compound" signal.
- **Validation gates (step-524 acceptance):** `reference/` → 130/130; shipped stubs → 0/130. Grading
  runs after `git -C grader checkout -- .` (pristine restore); arms never contain grader files and
  have no network (T9 unchanged).

## 6. Arm procedures — exact frozen commands (canonical shell: Git Bash, per v1 §6)

`MODEL=claude-opus-4-8` throughout. Record start/end timestamps for every command. `B100=/c/Users/AI/Documents/bench100`.

### 6.1 ARM A — one vanilla opus session

```bash
cd $B100/arm-a
start=$(date +%s)
claude -p "$(cat ../prompts/arm-a.txt)" --output-format json --verbose \
  --permission-mode acceptEdits --max-budget-usd 30 --model "$MODEL" \
  --strict-mcp-config --allowedTools "Read,Write,Edit,Bash,Glob,Grep" \
  > ../results/arm-a.json 2> ../results/arm-a.stderr
echo $(( $(date +%s) - start )) > ../results/arm-a-wall.txt
git add -A && git diff --cached > ../results/arm-a.diff
```
`prompts/arm-a.txt` (frozen) — preamble then `spec.md` verbatim. **Fairness clauses (T-VERIFY):** the
preamble states, identically to what ARM B agents learn, that (a) the entry-point modules are
mandated, (b) `smoke/stage{1..6}.*.test.mjs` are in the repo and should be run per stage
(`node --test smoke/`), (c) **a hidden grader will score each stage independently and the full stack,
so test boundary/adversarial cases (recovery of un-checkpointed frames, parse errors, primary-key
ordering) yourself**, and (d) build the stages in dependency order 1→6, verifying each before moving
on. Same information, no hidden advantage.

### 6.2 ARM B — plan tool

**Step 0 — ingest the spec for the planner (reference-not-copy, RAG):**
```bash
# Run inside the plan-creation session via MCP; codename is STABLE (reusable), not plan-scoped:
#   rag_ingest {source:"C:/Users/AI/Documents/bench100/arm-b/spec.md", codename:"stratum-spec"}
```

**Step 0b — plan creation (tokens COUNT toward ARM B; opus):**
```bash
cd $B100/arm-b
claude -p "$(cat ../prompts/arm-b-plan.txt)" --output-format json \
  --permission-mode acceptEdits --max-budget-usd 8 --model "$MODEL" \
  --allowedTools "Read,mcp__plan-ledger__rag_status,mcp__plan-ledger__rag_ingest,mcp__plan-ledger__rag_query,mcp__plan-ledger__rag_cite,mcp__plan-ledger__create_plan,mcp__plan-ledger__add_step,mcp__plan-ledger__add_file_ref,mcp__plan-ledger__link_items,mcp__plan-ledger__write_carry_forward" \
  > ../results/arm-b-plan.json
PLAN=$(node -e "const r=JSON.parse(require('fs').readFileSync('../results/arm-b-plan.json','utf8'));console.log(/PLAN_ID=(\d+)/.exec(r.result)[1])")
```
`prompts/arm-b-plan.txt` (frozen) instructs the planner to produce a plan titled `stratum ARM B`
whose steps **MUST** exhibit the web structure the thesis rests on:
- **decompose-by-concern, NOT one-module-per-step:** step 1 = a **contract-skeleton** (all six module
  stubs that *import and compile*, so later steps have a stable target — architect); stages grouped so
  the shared pager/WAL core is built once; the **last step = a dedicated full-stack integration +
  recovery pass** (debugger), never folded into a feature step.
- **`builds_on` links:** each stage step `link_items(relation:"builds_on")` to its predecessor — a real
  dependency the runner defers on (`db.mjs:551-556`, `server.mjs:317-318`), so the DAG *is* the
  execution order, not just idx.
- **pre-seeded `carry_forward`:** the planner writes each stage step's `carry_forward` pointing at the
  prior stage's produced files + the exact spec section (e.g. *"builds on src/pager.mjs (stage 1)
  readPage/writePage and src/wal.mjs (stage 2) frame format; see spec §Stage-3"*). **Inject-mode agents
  cannot call `write_carry_forward` themselves** (no MCP; §9 T-CF) — so the handoff must be authored at
  plan time. This is sound because every inter-stage contract is *frozen in spec.md* up front; runtime
  discovery isn't required.
- **`file_refs` + `SPEC:`/`RAG:` lines (reference-not-copy):** each step gets
  `add_file_ref(path:"spec.md", role:"spec", note:"§Stage-N …")` and a first context line
  `SPEC: read spec.md §Stage-N in your working directory before coding` (the runner injects file_refs
  verbatim, `runner.mjs:123-129`). **Do NOT copy spec prose into contexts** — the file is in the clone
  (v1 improvement #3). RAG is the *planner's* tool for authoring slim, correct pointers; execution
  agents Read the file section directly.
- **`VERIFY:` line per step:** `VERIFY: node --test smoke/stageN.*.test.mjs` (stage steps) and
  `VERIFY: node grader-less full smoke` → for the integration step, `VERIFY: node --test smoke/`.
  Enforced post-exit by the runner (step 521) — a self-reported pass with failing smoke records fail.
- **role tags per tier policy:** contract-skeleton + integration/recovery → `architect`/`debugger`
  (opus); stage implementations → `implementer` (sonnet); smoke-hardening/edge steps → `test-engineer`
  (sonnet).
- Print `PLAN_ID=<n>` as the final line.

**Execution (cwd = arm-b, direct node — NOT `npm run`; v1 §2.1; NO `--model` so the map's per-role
tiers apply):**
```bash
cd $B100/arm-b
start=$(date +%s)
node /c/Users/AI/Documents/plan-ledger/scripts/runner.mjs --plan "$PLAN" --live --inject --lean \
  --budget 6 --max-total-usd 22 --max-attempts 2 --permission-mode acceptEdits \
  --allowed-tools "Read,Write,Edit,Bash,Glob,Grep" \
  2>&1 | tee ../results/arm-b-runner.log
echo $(( $(date +%s) - start )) > ../results/arm-b-wall.txt
git add -A && git diff --cached > ../results/arm-b.diff
```
`--budget 6` is the per-agent cap (opus steps can each be a few $); `--max-total-usd 22` + plan
creation `$8` = **$30 ARM B total** as directed. See §8: this is tight — a single opus overrun or a
`--max-attempts 2` retry can hit the ceiling and truncate the run (recorded as a *result*, not retried).

**Execution-mode decision (the crux alternatives — see §10):** ARM B runs **inject+lean**, not MCP
mode. Rationale in §10; the web structure lives at plan/runner level (builds_on ordering, pre-seeded
carry_forward, file-ref reference-not-copy, VERIFY gate, per-step tokens) and does not need per-agent
MCP. Inject is the measured-cheaper path (the only one with a prayer of fitting the cap) and the only
mode where the two v2 runner improvements (VERIFY gate, per-step tokens) are exercised.

### 6.3 Grade both
```bash
cd $B100
git -C grader checkout -- .
node grader/grade.mjs --root "$(pwd)/arm-a" --out results/arm-a-grade.json
node grader/grade.mjs --root "$(pwd)/arm-b" --out results/arm-b-grade.json
```

## 7. Metric extraction — v1 set + per-stage + per-step

**ARM A** — v1 §8 one-liner (`total_cost_usd`, `num_turns`, 3-way input split, `output_tokens`,
`duration_ms`, `is_error`) over `results/arm-a.json`.

**ARM A context-degradation indicators (new):**
- **Per-stage falloff** = `arm-a-grade.json .stages` — the headline degradation curve. The thesis
  predicts monotone late-stack decline (aces pager/parser, degrades on executor/txn/integration).
- **Thrash** = `num_turns` and `duration_ms` (vs ARM B agents' per-step turns), **plus** grep the
  `--verbose` transcript (`arm-a.json` / `arm-a.stderr`) for rework signatures: repeated `Edit` of the
  same `src/*.mjs`, re-reads of `spec.md`, and self-correction phrases. Report counts, not vibes:
  `grep -Eoc '"file_path":"[^"]*src/(pager|wal|btree|sql|db).mjs"' results/arm-a.json` per module for
  edit-churn; note any stage it abandoned.

**ARM B execution aggregate** — v1 §8 runner usage line (`runner.mjs:301`).
**ARM B per-step attribution (new, from step 521 logging):** each step's attempt `result` carries
`usage: in=X out=Y cost=$Z model=M`. Extract authoritatively from the DB:
```bash
node -e "import('/c/Users/AI/Documents/plan-ledger/src/db.mjs').then(({Store,defaultDbPath})=>{const s=new Store(defaultDbPath());const p=s.openPlan(Number(process.argv[1]));for(const st of p.steps){const a=(s.getStep(st.id).attempts||[]).map(x=>x.result).join(' | ');console.log(st.idx, st.role, st.title, '::', /usage:[^|]*/.exec(a)?.[0]||'(none)');}})" "$PLAN"
```
(console fallback: `grep -E 'usage: in=' results/arm-b-runner.log`). This is what v1 could not do
(aggregate-only; `BENCHMARK_2026-07.md` note¹) — it lets us attribute the token blow-up to specific
stages and quantify the T6 cache asymmetry per step.

**ARM B per-stage grade** = `arm-b-grade.json .stages`, same shape as ARM A → the two falloff curves
are directly comparable (the core v2 exhibit).

**Report table (`results/metrics.md`):** v1's rows (pass rate + $ + tokens-in-3-way + tokens-out +
wall + turns/agents + budget-stop) **plus**: per-stage `[passed,total]` for **both** arms side by
side, ARM B per-step token/cost table, ARM A edit-churn per module. Every number traceable to a
`results/` file.

## 8. Budget reality check (the orchestrator MUST read this)

The $30/arm cap is inherited from v1, but v1 ran **sonnet** on a **360-LOC** task. v2 is **opus** on a
**~1500-LOC, ~130-test** task. Estimating from v1 empirics (ARM A sonnet single-session = **$1.03**,
674k in / 19k out; ARM B sonnet = **$5.57**) scaled by ~4× work and opus's ~5× input / ~5× output
list price (cache-read much cheaper, which dampens it):

| Arm / phase | v1 actual | v2 estimate | Cap in §6 | Headroom |
|---|---|---|---|---|
| ARM A session | $1.03 (sonnet) | **$12–22** (opus, 4× work, + late-stack thrash) | $30 | thin but OK |
| ARM B plan creation | $1.37 (sonnet) | **$4–7** (opus, larger spec, links+carry_forward) | $8 | OK |
| ARM B execution | $4.20 (sonnet) | **$15–28** (2 opus + ~5 sonnet steps, bigger codebase, cache re-creation per cold agent) | $22 | **can overshoot** |
| **ARM B total** | $5.57 | **$19–35** | **$30** | **TIGHT — may truncate** |

**Recommendation flagged for the orchestrator:** raise both caps to **~$45/arm** (runner
`--max-total-usd 37`, plan-creation `--max-budget-usd 8`, per-agent `--budget 8`) to avoid a
truncation artifact contaminating the comparison. If the $30 cap is held, **expect ARM B to risk a
spend-ceiling stop**, which is a *valid result* (grade whatever exists, per v1's no-top-up rule) but
weakens the head-to-head. Cheaper alternative if the budget is firm: **drop to 5 stages** (fold txn
into the executor stage) and cap opus to the planner + one architect step. Pilot the two leader
sessions once at $5 each before the full run to calibrate (spike S1, §12).

## 9. Threats to validity (report verbatim in R4)

Inherit **T1–T9** from `docs/BENCHMARK_DESIGN.md` §12 (n=1, selection bias, leakage, overhead
accounting, tool asymmetry, cache asymmetry, weak-blind review, weak step gate, grader contamination).
v2 amendments and additions:

- **T-SHAPE — task-shape bias (openly stated, this is the point).** v2's task is *chosen* to favour
  decomposition; the claim under test is literally "layered work is where the plan tool pays." So a
  plan-tool win here is **not** evidence it wins generally — it is evidence for the *conditional*
  claim. Read v1 (flat task, plan tool lost) and v2 (layered task) **as a pair**: together they map
  *where* the crossover is, which is the honest contribution. Never headline v2 alone as "plan tool
  wins."
- **T-VERIFY — VERIFY-gate asymmetry.** ARM B agents get an enforced `VERIFY:` smoke gate; ARM A does
  not have a runner enforcing anything. **Fairness answer:** (a) the *same* public smoke tests ship in
  both clones; (b) ARM A's prompt explicitly tells it the smoke exists, to run it per stage, that a
  hidden grader scores per stage, and to test boundary cases (§6.1) — identical information; (c) the
  gate only *enforces* what ARM A is *told to do voluntarily*. Any residual gap (ARM A may skip its
  self-tests under context pressure) is **itself a finding about single-session discipline**, not an
  unfair advantage — report it as such. If step 521's VERIFY gate is not landed, this answer collapses
  and the run must not proceed (§2).
- **T-CF — carry_forward is pre-authored, not runtime.** Inject-mode agents can't `write_carry_forward`
  (no MCP). The handoff is authored at plan time from the frozen spec (§6.2). **Consequence:** v2 tests
  the plan tool's *authored* web structure (builds_on + pre-seeded carry_forward + reference-not-copy),
  **not** runtime cross-agent discovery. State this scope limit; runtime carry_forward is only
  exercisable in MCP mode (rejected in §10) and would be a separate experiment.
- **T-COST — opus overshoot vs the cap (see §8).** Expected ARM B total $19–35 against a $30 cap; a
  ceiling stop truncates and is recorded, not retried. Mitigate by raising caps to ~$45 or dropping to
  5 stages; flagged for the orchestrator.
- **T-ATTR — per-stage attribution is confounded by compounding (§5).** A late-stage low score may be
  *caused* by an early-stage break, not late-stage difficulty. Read the **first cliff** as the causal
  break; do not claim "arm X is bad at transactions" when its pager was already broken.
- **T-STUB-LEAK — mandated module paths.** v2 mandates six module paths (vs v1's one), constraining
  architecture more. Both arms get the identical mandate, so it is not differentially unfair, but it
  *does* reduce the design freedom the blind review (§ v1 9) can reward — weight the review even more
  lightly than v1 did (it was already "color only").

## 10. Key decision — ARM B execution mode (inject vs MCP)

The thesis is about the plan tool's *web structure*, so "does inject mode strip the very thing under
test?" is the load-bearing decision.

| Option | web structure exercised | per-agent RAG / carry_forward-write | VERIFY gate + per-step tokens (the v2 improvements) | cost vs the cap | cold-agent reliability | Verdict |
|---|---|---|---|---|---|---|
| **inject + lean** | builds_on ordering ✓, pre-seeded carry_forward ✓, file-ref reference-not-copy ✓ | ✗ (no MCP per agent) | ✓ both only work here | **cheapest** (measured 5× cheaper input pattern in v1) | high (no MCP schema to fumble — `runner.mjs:188-189`) | **RECOMMENDED** |
| MCP (non-inject) | all of the above **+ runtime rag_query + write_carry_forward** | ✓ | VERIFY gate applies both modes (521); **per-step token logging** designed for inject flow | **most expensive** (get_step/record_attempt overhead per cold agent) | lower ("indirection that makes cold agents fumble", `runner.mjs:188-189`) | rejected |
| hybrid (MCP only for the integration step) | mixed | partial | mixed | middle | mixed | rejected (adds a confound: two modes in one arm) |

**Inject wins** because (a) every inter-stage contract is *frozen in spec.md*, so runtime
carry_forward-writes and rag_queries buy little the authored web structure doesn't already carry; (b)
it is the only mode cheap enough to have a chance under the cap (§8); (c) the two v2 runner
improvements this whole plan front-loaded (VERIFY gate, per-step tokens) are exercised in the inject
flow — running MCP mode would leave them untested; (d) v1 proved inject works end-to-end. **Evidence
that flips it:** a pilot where execution agents demonstrably need a fact discovered *during* an earlier
stage that is *not* derivable from spec.md + the produced files (i.e. genuine runtime handoff) — then
MCP mode's `write_carry_forward` earns its cost and we rerun ARM B in MCP mode.

## 11. Blast radius

This design doc is **docs-only** (adds `docs/BENCHMARK_V2_DESIGN.md`; touches no code). The code
changes it *depends on* are steps 521–522, already scoped in plan #100 — their blast radius is owned
there, not here. No schema or persisted-data change in this design; the plan-ledger DB is only
appended to via its normal API (a new plan `stratum ARM B` + its steps/links/attempts, and a
`stratum-spec` RAG source), no migration. New filesystem tree `C:/Users/AI/Documents/bench100/` is
created fresh (parallels `bench97/`; no collision — `ls` shows only `bench97` exists today).

```
grep of docs/ for BENCHMARK_V2_DESIGN → only this new file (no prior reference to collide)
existing bench dirs: /c/Users/AI/Documents/bench97   (bench100 is new)
```

## 12. Execution steps (maps onto plan #100 steps 4–5)

| # | Plan step | Step (role) | Digest | Binary acceptance | Verify command | Depends |
|---|---|---|---|---|---|---|
| S1 | (part of 524) | Spike: leader calibration + env facts (build-devops) | Falsifiable: does `claude` accept the §6 flags on `claude-opus-4-8`? Ingest `spec.md` OK? One $5-capped ARM-A-style pilot on stages 1–2 only — does opus fit the token/$ envelope in §8? | All Qs answered yes/no with pasted output; pilot $ recorded; cap decision ($30 vs $45) made | `claude --help` grep + one `--max-budget-usd 5` probe | 521, 522 green |
| B1 | **524** | Build task repo + staged grader (test-engineer) | Author `spec.md` from §3.1 (signatures, on-disk formats, AST JSON, error table, per-stage worked examples), stubs, `smoke/stage{1..6}`, ~130 hidden tests in 6 stage groups + integration, `grade.mjs`, `reference/` | `reference/` → 130/130 AND stubs → 0/130, both printed; per-stage groups non-empty | `node grader/grade.mjs --root grader/reference --out /tmp/ref.json` then same for `task-template` | S1 |
| B2 | **524** | Freeze prompts + clones (build-devops) | Write `prompts/{arm-a,arm-b-plan,review}.txt` per §6 (incl. the T-VERIFY fairness clauses); `git clone` task-template → arm-a, arm-b; record all SHAs | 3 prompt files exist; arm-a/arm-b are clones at the recorded SHA; arm-a.txt contains the "hidden grader scores per stage" clause | `diff <(git -C arm-a rev-parse HEAD) <(git -C task-template rev-parse HEAD)` = equal; `grep -c 'hidden grader' prompts/arm-a.txt` ≥ 1 | B1 |
| R1 | **525** | Run ARM A + grade (build-devops) | §6.1 then §6.3; no manual edits | `arm-a.json`, `arm-a.diff`, `arm-a-grade.json` exist; grade JSON parses with a `.stages` map | v1 §8 `node -e` extractor exits 0; `node -e "JSON.parse(require('fs').readFileSync('results/arm-a-grade.json')).stages"` prints 6 keys | B2 |
| R2 | **525** | Run ARM B + grade (build-devops) | §6.2 (ingest → plan → run) then §6.3 | `arm-b-plan.json` (with `PLAN_ID=`), `arm-b-runner.log` (usage line + per-step `usage: in=` lines), `arm-b.diff`, `arm-b-grade.json` exist | §7 grep finds ≥1 aggregate usage line AND ≥6 per-step `usage: in=` lines; grade `.stages` has 6 keys | B2, S1 (cap decided) |
| R3 | **525** | Blind review (build-devops runs; reviewer = fresh session) | v1 §9 protocol, **independent** reviewer session (fix v1's T7′ analyst-is-reviewer flaw) | `review.json` parses; `mapping.txt` unopened until scores recorded | `node -e "JSON.parse(require('fs').readFileSync('results/review.json'))"` | R1, R2 |
| R4 | **525** | Findings report v1-vs-v2 (tech-writer) | `results/metrics.md` + `docs/BENCHMARK_V2_2026-07.md`: both falloff curves, per-step token table, ARM A thrash, T-SHAPE framing, v1↔v2 crossover reading, plan-tool improvement list | Every §7 table row filled; both per-stage curves present; v1↔v2 comparison paragraph present; every number traceable to a `results/` file | manual cross-check of table vs files | R3 |

R1 and R2 are order-independent (no shared state — separate clones, separate DBs is not required since
ARM B only appends its own plan) but run **serially** to avoid API rate-limit interference distorting
wall time (v1 §10).

## 13. Contracts implementers code against (for step 524)

The **source of truth is `spec.md`** (authored in B1 from §3.1). Key contracts, at code precision:

```js
// src/pager.mjs
export function openPager(path, { pageSize = 4096 } = {});
//   → { readPage(n) /*:Buffer*/, writePage(n, buf), allocatePage() /*:number*/,
//       pageCount() /*:number*/, flush(), close() }
//   file byte layout: page 0 = header [magic "STRM"(4B) | u32 pageSize | u32 pageCount], then pages.

// src/wal.mjs
export function openWal(path);
//   → { append(bytes /*:Buffer*/), frames() /*:Frame[]*/, checkpoint(pager), truncate(), close() }
//   Frame on disk: [u32 len | u32 crc32 | u32 pageNo | payload];  crc32 = IEEE table fixed in spec.

// src/btree.mjs
export function openBTree(pager, rootPageNo = 1);
//   → { insert(key /*utf8*/, val), get(key) /*:val|null*/, rangeScan(lo, hi) /*:[key,val][]*/,
//       delete(key), root() /*:number*/ }   ordering: bytewise; persists through pager across reopen.

// src/sql.mjs   (pure; no I/O)
export function parse(sql); // → AST (exact JSON shape in spec); throws SqlError with fixed .code.
export class SqlError extends Error { code; } // E_PARSE | E_UNEXPECTED_TOKEN | ... (taxonomy in spec)

// src/db.mjs   (executor + transactions)
export function openDatabase(path);
//   → { exec(sql) /*:{rows:object[], rowCount:number}*/, close(opts) }
//   close({ checkpoint:false }) drops buffers WITHOUT checkpointing the WAL (crash-sim seam).
//   SELECT without ORDER BY → rows in primary-key ascending order (determinism).
```

Grader entry (B1): `node grader/grade.mjs --root <arm> --out <json>` → the §5 JSON. Stub modules throw
`Error("not implemented: <fn>")` so `grade.mjs` scores them 0/130 without crashing the harness.

---

## 14. Self-check (Definition of done)

- [x] **Design doc at a stated repo path; diff docs-only.** `C:/Users/AI/Documents/plan-ledger/docs/BENCHMARK_V2_DESIGN.md`; no code/tests/scripts added (steps 521/524 own those).
- [x] **Every referenced existing symbol cited with a real path.** `runner.mjs` (inject/lean/model/usage lines 60-66,162-164,182,225,301; reference-not-copy fileRefLines 123-129; cold-agent note 188-189), `db.mjs:551-556` (builds_on defers), `server.mjs:317-318` (builds_on is a real dependency), `plan-roles.json:4-15` (tiers). New items tagged (`stratum` modules, `bench100/` tree, `stratum-spec` RAG source).
- [x] **2–3 alternatives vs criteria stated first, one recommendation.** Task table §3 (A/B/C on L1–L6 → A); execution-mode table §10 (inject/MCP/hybrid → inject).
- [x] **Cross-component contracts at code precision.** §13 signatures + on-disk layouts + §5 grader JSON + §3.1 stage APIs; not prose.
- [x] **Blast radius enumerated with grep evidence.** §11 (docs-only; `bench100` new vs existing `bench97`; no schema/migration).
- [x] **Schema/persisted-data change plan.** None — §11 states the DB is append-only via normal API, no migration.
- [x] **Step list dependency-ordered, self-contained, binary acceptance + runnable PS/Bash verify.** §12 (S1→B1→B2→R1..R4), each with a command; maps to plan #100 steps 524–525.
- [x] **Report format incl. self-check with proof pointers.** This section + the final assistant message.
- [x] **Task-shape bias stated openly.** §0 claim, §3 criteria, §9 T-SHAPE.
- [x] **VERIFY fairness + opus-cost overshoot answered.** §9 T-VERIFY; §8 cost table + $45 recommendation flagged for the orchestrator.

*Author: architect (plan #100 step 523). Depends on steps 521–522 (runner VERIFY gate + per-step
tokens + planning guidance) being green before R1/R2 run.*
