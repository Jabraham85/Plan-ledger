# BENCHMARK_DESIGN — Vanilla agent vs plan tool (A/B, plan #97 step 1)

**Status:** design frozen 2026-07-14 · **Author role:** architect · **Executes as:** plan #97 steps 2–3
**Question:** On one identical, objectively-gradable coding task, how does a single vanilla
`claude -p` session (ARM A) compare against the plan tool — architect decomposition +
role-tagged steps executed headless by `scripts/runner.mjs` (ARM B) — on pass rate, tokens,
cost, wall time, and blind-reviewed diff quality?

---

## 1. Controls (both arms, non-negotiable)

| Control | Value |
|---|---|
| Model | The SAME explicit `--model <NAME>` string passed to every agent in both arms; record it and `claude --version` in `results/metrics.md`. |
| Permission mode | `acceptEdits` both arms (runner default, `scripts/runner.mjs:60`). |
| MCP baggage | None in coding agents: ARM A gets `--strict-mcp-config`; ARM B runner gets `--lean` (`runner.mjs:64` → `--strict-mcp-config`, `runner.mjs:138`). |
| Allowed tools | Identical set both arms: `Read,Write,Edit,Bash,Glob,Grep`. ARM B needs this passed explicitly — inject mode defaults to `Write,Read` (`runner.mjs:137`). |
| Baseline | `arm-a/` and `arm-b/` are `git clone`s of the same `task-template` commit; record the SHA. |
| Budget ceiling | $10 per arm (see §7). |
| Network | Task is offline-only; spec forbids network and npm installs; grader asserts zero `node_modules`. |
| Human hands | Zero manual edits between clone and grade. A stalled/budget-stopped run is a RESULT, not a retry excuse. |
| Token counting | `in = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, `out = output_tokens` — exactly the runner's formula (`runner.mjs:115`), mirrored for ARM A so arms are comparable. Report the three input components separately too (§8, threat T6). |

## 2. Corrections to the step brief (grounded in `scripts/runner.mjs`)

These override the literal commands in the step context — the flags below are the ones that
actually exist:

1. **Do NOT use `npm run orchestrate` for ARM B.** npm runs scripts with cwd = the package
   root (`C:/Users/AI/Documents/plan-ledger`), and the runner spawns agents inheriting its
   own cwd (`spawn` with no `cwd` option, `runner.mjs:143`) while the inject prompt says
   "Work in the current directory" (`runner.mjs:132`). Via npm, ARM B agents would code
   inside the plan-ledger repo. Invoke the runner directly from the arm-B working copy:
   `node C:/Users/AI/Documents/plan-ledger/scripts/runner.mjs …`.
2. **`--budget` is the PER-AGENT cap** (`runner.mjs:62`, forwarded as `--max-budget-usd`,
   `runner.mjs:139`). The whole-run ceiling is `--max-total-usd` (`runner.mjs:55`). Both are used.
3. **Inject-mode "pass" is not verification.** The runner marks a step `pass` iff the agent
   exited without error and printed a non-empty result (`runner.mjs:196–200`). Step-level
   quality is therefore enforced by step *contexts* (each must demand a runnable self-check)
   and finally by the hidden grader — the only arbiter that counts.
4. **Inject prompt hard-codes "Use Read/Write only"** (`runner.mjs:132`), contradicting the
   expanded `--allowed-tools`. Step 2 of plan #97 makes the 1-line fix (§10, B2) so ARM B
   agents know they may run `node`/Bash. Only consumer of `buildDirectPrompt` is the runner
   itself plus a mention in `docs/ROLES.md:67` (grep in §11) — blast radius is one file.

## 3. The task — decision first

**Criteria (in priority order):** G1 grading objectivity (exact I/O ⇒ hidden suite is
indisputable) · G2 breadth (3–4 separable concerns so decomposition can matter) · G3
memorization risk (generic solutions from training data must FAIL bespoke rules) · G4 size
(~30–60 min of agent work) · G5 environment fit (Node-only, `node:test`, zero deps, offline,
Windows-safe).

| Option | G1 objectivity | G2 breadth | G3 memorization | G4 size | G5 env | Verdict |
|---|---|---|---|---|---|---|
| **A. `tally` — expense-tracking CLI** | exact stdout/exit codes | 4 concerns: parser / money math / persistence / errors | medium base risk, killed by bespoke rules (integer-cents OVER test, exact formats, exit codes) | right | pure Node | **RECOMMENDED** |
| B. `logstat` — log-file analyzer CLI | exact | 3 concerns (read-only input ⇒ persistence concern is weak) | lower | right | pure Node | **ALTERNATE** |
| C. mini KV store with TTL | good | 3, narrow | low | right | TTL needs time mocking → flaky black-box tests | rejected |

A beats B on the one criterion that decides the experiment: breadth. B has no state-mutation
concern, so a plan decomposition has one fewer distinct axis to exploit; A's four concerns map
1:1 onto plausible plan steps. Evidence that would flip this: if the ARM A agent visibly
pattern-matches a memorized expense-tracker and aces the bespoke rules anyway, rerun on B.

### 3.1 `tally` contract (this section becomes `spec.md` nearly verbatim)

CLI invoked as `node src/cli.mjs <command> [args…]`. **Entry point MUST be `src/cli.mjs`**
(the grader executes exactly that path; anything else grades 0/30). ES modules, Node ≥ 22,
**zero dependencies**, no network. Data file path: env `TALLY_FILE`, else `./tally.json`.

**Money:** input amounts match `^\d+(\.\d{1,2})?$`, value > 0 and ≤ 1000000.00. Stored and
computed as **integer cents**; always printed with exactly 2 decimals. (The hidden suite
contains a float trap: entries 0.10 + 0.20 against a 0.30 budget must be `OK`, not `OVER`.)

**Commands** (all output lines are tab-separated fields; `<2dp>` = 2-decimal string):

| Command | Behavior | stdout (exact) | exit |
|---|---|---|---|
| `add <amount> <category> --date YYYY-MM-DD [--note <text>]` | append entry; ids `e1, e2, …` in creation order; `--date` REQUIRED (determinism) | `added e<N>\t<2dp>\t<category>` | 0 |
| `list [--category c] [--from d] [--to d]` | entries sorted by date asc, then id numeric asc; `--from`/`--to` inclusive | one line per entry: `e<N>\t<date>\t<2dp>\t<category>\t<note-or-empty>`; nothing if none | 0 |
| `report [--month YYYY-MM]` | per-category totals sorted total desc, then name asc; always ends with total line | `<category>\t<2dp>` per category, then `TOTAL\t<2dp>` (`TOTAL\t0.00` when empty) | 0 |
| `budget set <category> <amount>` | upsert limit | `budget\t<category>\t<2dp>` | 0 |
| `budget status [--month YYYY-MM]` | per budgeted category, name asc; `OVER` iff spent **strictly >** limit (integer-cents compare) | `<category>\t<spent-2dp>/<limit-2dp>\t<OK|OVER>`; nothing if no budgets | 0 |

**Validation:** category `^[a-z][a-z0-9-]{0,23}$`; date must be a real calendar date.
**Errors:** usage/validation error → exit **2**, stderr `error: <message>` (spec.md fixes the
exact message per case, e.g. `error: invalid amount`, `error: unknown command <cmd>`);
data-file unreadable-as-JSON → exit **1**, stderr `error: data file corrupt`; `schema !== 1` →
exit **1**, stderr `error: unsupported schema version <v>`. **A failing command must leave the
data file byte-identical** (tested).

**Data file format (exact):**
```json
{"schema":1,"entries":[{"id":"e1","date":"2026-07-01","amountCents":1250,"category":"food","note":""}],"budgets":{"food":5000}}
```

**Worked example (goes in spec.md verbatim; grader replays it):**
```
$ node src/cli.mjs add 12.50 food --date 2026-07-01
added e1	12.50	food
$ node src/cli.mjs add 0.10 tea --date 2026-07-02
added e2	0.10	tea
$ node src/cli.mjs add 0.20 tea --date 2026-07-03 --note "refill"
added e3	0.20	tea
$ node src/cli.mjs budget set tea 0.30
budget	tea	0.30
$ node src/cli.mjs budget status
tea	0.30/0.30	OK
$ node src/cli.mjs report
food	12.50
tea	0.30
TOTAL	12.80
$ node src/cli.mjs add 12.5x food --date 2026-07-01 ; echo $?
error: invalid amount
2
```

## 4. Repo / directory layout

```
C:/Users/AI/Documents/bench97/
  task-template/            # git repo — THE frozen baseline (record HEAD SHA)
    spec.md                  # §3.1 expanded with the exact error-message table
    package.json             # {"name":"tally","type":"module","private":true} — no test script
    src/cli.mjs              # stub: prints "error: unknown command" to stderr, exit 2
  grader/                    # NEVER copied/cloned into an arm; own git repo for pristine restore
    grade.mjs                # see §5 contract
    tests/parser.test.mjs    #  7 tests (usage/exit-2/messages/help-less unknown-flag cases)
    tests/core.test.mjs      #  9 tests (report math, sorting, month/date filters, float trap)
    tests/persist.test.mjs   #  7 tests (round-trip, exact file JSON, corrupt→exit 1, schema 2→exit 1, failed-cmd leaves file untouched)
    tests/edge.test.mjs      #  7 tests (bad category, bad/leap dates, max amount, empty list/report, unicode note, TALLY_FILE honored)
    reference/cli.mjs        # hidden reference solution — validates the suite (30/30)
  prompts/
    arm-a.txt                # frozen ARM A prompt = 3-line preamble + spec.md verbatim
    arm-b-plan.txt           # frozen plan-creation prompt (§6.2)
    review.txt               # frozen blind-review prompt (§9)
  arm-a/                     # git clone of task-template (agents see spec.md + stub ONLY)
  arm-b/                     # git clone of task-template
  results/                   # everything the report is built from (see §8)
```

Grader tests are **black-box**: each test gets a fresh temp dir, sets `TALLY_FILE`, and
`execFile`s `node <TALLY_CLI> …` — internal code structure is never inspected, so neither
arm's file layout is advantaged (only `src/cli.mjs` as entry point is mandated).

## 5. Grader contract

```
node grader/grade.mjs --cli <abs path to an arm's src/cli.mjs> --out <results json>
```
Runs `node --test grader/tests/` with env `TALLY_CLI=<path>`; always exits 0; writes and prints:
```json
{"total":30,"passed":27,"failed":3,"groups":{"parser":[7,7],"core":[8,9],"persist":[6,7],"edge":[6,7]}}
```
**Suite validation gates (step-2 acceptance):** `reference/cli.mjs` → 30/30; the shipped
stub → 0/30. Grading always runs after `git -C grader checkout -- .` (pristine restore) so an
agent that somehow edited tests cannot game the grade — though it never sees them anyway.

## 6. Arm procedures (canonical shell: Git Bash — avoids PS 5.1 BOM-on-redirect and `2>&1` NativeCommandError gotchas)

`MODEL=<the pinned model name>` throughout. Record start/end timestamps for every command.

### 6.1 ARM A — vanilla

```bash
cd /c/Users/AI/Documents/bench97/arm-a
start=$(date +%s)
claude -p "$(cat ../prompts/arm-a.txt)" --output-format json \
  --permission-mode acceptEdits --max-budget-usd 10 --model "$MODEL" \
  --strict-mcp-config --allowedTools "Read,Write,Edit,Bash,Glob,Grep" \
  > ../results/arm-a.json
echo $(( $(date +%s) - start )) > ../results/arm-a-wall.txt
git add -A && git diff --cached > ../results/arm-a.diff
```
`prompts/arm-a.txt` preamble (frozen): *"Implement the following spec in the current
directory. The entry point must be src/cli.mjs. Zero npm dependencies; you may run node
commands to test your work. Work until the spec is fully implemented."* + blank line + spec.md.

### 6.2 ARM B — plan tool

**Step 0 — plan creation (tokens COUNT toward ARM B):**
```bash
cd /c/Users/AI/Documents/bench97/arm-b
claude -p "$(cat ../prompts/arm-b-plan.txt)" --output-format json \
  --permission-mode acceptEdits --max-budget-usd 3 --model "$MODEL" \
  --allowedTools "Read,mcp__plan-ledger__create_plan,mcp__plan-ledger__add_step" \
  > ../results/arm-b-plan.json
```
`prompts/arm-b-plan.txt` (frozen) instructs: read `spec.md`; create a plan-ledger plan titled
`bench97 ARM B` with role-tagged, dependency-ordered steps; **each step context must be fully
self-contained** (the runner injects title+context+acceptance verbatim and the executing agent
sees nothing else — embed the relevant spec excerpts, exact output formats, and a runnable
self-check command in every context); print `PLAN_ID=<n>` as the final line.
Extract the id: `PLAN=$(node -e "const r=JSON.parse(require('fs').readFileSync('../results/arm-b-plan.json','utf8'));console.log(/PLAN_ID=(\d+)/.exec(r.result)[1])")`.
Note: this session intentionally has plan-ledger MCP (it IS the tool under test); spike S1
(§10) confirms reachability from this cwd, else add `--mcp-config` pointing at
`C:/Users/AI/Documents/plan-ledger/src/server.mjs`.

**Execution (cwd = arm-b, direct node — NOT npm run; see §2.1):**
```bash
cd /c/Users/AI/Documents/bench97/arm-b
start=$(date +%s)
node /c/Users/AI/Documents/plan-ledger/scripts/runner.mjs --plan "$PLAN" --live --inject --lean \
  --budget 2 --max-total-usd 7 --max-attempts 2 --permission-mode acceptEdits \
  --model "$MODEL" --allowed-tools "Read,Write,Edit,Bash,Glob,Grep" \
  2>&1 | tee ../results/arm-b-runner.log
echo $(( $(date +%s) - start )) > ../results/arm-b-wall.txt
git add -A && git diff --cached > ../results/arm-b.diff
```

### 6.3 Grade both

```bash
cd /c/Users/AI/Documents/bench97
git -C grader checkout -- .
node grader/grade.mjs --cli "$(pwd)/arm-a/src/cli.mjs" --out results/arm-a-grade.json
node grader/grade.mjs --cli "$(pwd)/arm-b/src/cli.mjs" --out results/arm-b-grade.json
```

## 7. Budget caps

| Item | Cap | Mechanism |
|---|---|---|
| ARM A session | $10 | `--max-budget-usd 10` |
| ARM B plan creation | $3 | `--max-budget-usd 3` |
| ARM B execution run | $7 total, $2/agent | `--max-total-usd 7 --budget 2` |
| Blind review + spike S1 | ~$2 | `--max-budget-usd 1` each |
| **Experiment total** | **≤ ~$22** | |

Both arms have the same $10 ceiling. A budget stop is recorded as an outcome (grade whatever
exists), never topped up.

## 8. Metric extraction

**ARM A** (fields exactly as the runner parses them, `runner.mjs:113–115`; `duration_ms` is
expected in CLI JSON output — spike S1 verifies, with `arm-a-wall.txt` as the fallback clock):
```bash
node -e "const r=JSON.parse(require('fs').readFileSync('results/arm-a.json','utf8'));const u=r.usage||{};console.log(JSON.stringify({cost:r.total_cost_usd,turns:r.num_turns,tin:(u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0),tin_parts:[u.input_tokens,u.cache_read_input_tokens,u.cache_creation_input_tokens],tout:u.output_tokens,wall_ms:r.duration_ms,err:r.is_error},null,2))"
```
jq equivalent: `jq '{cost:.total_cost_usd,turns:.num_turns,in:(.usage.input_tokens+.usage.cache_read_input_tokens+.usage.cache_creation_input_tokens),out:.usage.output_tokens,wall:.duration_ms,err:.is_error}' results/arm-a.json`

**ARM B execution** — parse the runner's final usage line (format at `runner.mjs:219`;
note `toLocaleString` thousands-commas):
```bash
grep -Eo 'usage: [0-9]+ agents · [0-9]+ turns · in [0-9,]+ tok · out [0-9,]+ tok · \$[0-9.]+' results/arm-b-runner.log | tail -1
```
**ARM B total = plan-creation JSON numbers (same node one-liner on `arm-b-plan.json`) + the
usage line.** Per-step token detail is not persisted by the runner (aggregate only) — totals
suffice for n=1; optional per-step logging is improvement B2b (§10).

**Report table (`results/metrics.md`):** rows = pass rate (primary, N/30 + per-group), $ cost,
tokens in (with 3-way split), tokens out, wall s, turns (A) / agents+turns (B), blind-review
scores, budget-stop flag. Steps/attempts for ARM B come from counting `▶ step` lines in the log.

## 9. Blind quality review (secondary metric)

1. Coin-flip mapping (`bash -c 'echo $((RANDOM%2))'`) → copy `arm-{a,b}.diff` to
   `results/review/{X,Y}.diff`; write the mapping to `results/review/mapping.txt` and do not
   open it until scores are recorded.
2. Fresh reviewer session, no MCP, read-only, same model:
   `claude -p "$(cat prompts/review.txt)" --output-format json --strict-mcp-config --allowedTools "Read" --max-budget-usd 1 --model "$MODEL" > results/review.json` (run from `results/review/`).
3. `prompts/review.txt` (frozen): given spec.md and two anonymous diffs X and Y implementing
   it, score each 1–5 on (a) spec adherence risk, (b) code organization, (c) error-handling
   robustness, (d) maintainability; one-line rationale each; state overall preference X/Y/tie;
   output strict JSON only.
4. Unseal mapping; record. Known weakness: the reviewer may infer the arm from style
   (monolith vs multi-file) — see T7.

## 10. Execution steps (maps onto plan #97's remaining steps)

| # | Step (role) | Digest | Binary acceptance | Verify command | Depends |
|---|---|---|---|---|---|
| S1 | Spike: environment facts (build-devops) | Falsifiable Qs: does installed `claude` accept `--max-budget-usd`/`--strict-mcp-config`/`--allowedTools`? Does `-p … --output-format json` emit `duration_ms`? Is plan-ledger MCP reachable from `bench97/arm-b` cwd? | All Qs answered yes/no with pasted output; fallbacks chosen where "no" | `claude --help` grep + one $0.05 probe run | — |
| B1 | Build task repo + grader (test-engineer) | Author `spec.md` from §3.1 (incl. exact error-message table), stub, 30 hidden tests, `grade.mjs`, `reference/cli.mjs` | reference 30/30 AND stub 0/30, both printed | `node grader/grade.mjs --cli grader/reference/cli.mjs --out /tmp/ref.json` then same for stub | S1 |
| B2 | Runner tweak (implementer) | Replace `runner.mjs:132` "Use Read/Write only." with wording that names the actual `--allowed-tools`; (b, optional) per-step usage console line after `runner.mjs:194` | `npm test` green in plan-ledger; dry-run (`--plan <id> --inject`) shows new prompt line | `cd /c/Users/AI/Documents/plan-ledger && npm test` | — |
| R1 | Run ARM A + grade (build-devops) | §6.1 then §6.3; no manual edits | `results/arm-a.json`, `arm-a.diff`, `arm-a-grade.json` exist; grade JSON parses | `node -e` extractor (§8) exits 0 | B1 |
| R2 | Run ARM B + grade (build-devops) | §6.2 then §6.3 | `arm-b-plan.json`, `arm-b-runner.log` (with usage line), `arm-b.diff`, `arm-b-grade.json` exist | §8 grep finds exactly one usage line | B1, B2 |
| R3 | Blind review (build-devops runs; reviewer = fresh session) | §9 protocol | `review.json` parses; mapping.txt unopened until after | `node -e "JSON.parse(...)"` on review.json | R1, R2 |
| R4 | Findings report (tech-writer) | `results/metrics.md` + interpretation + concrete plan-tool improvement list derived from the data | All §8 table rows filled; every number traceable to a results/ file | manual cross-check of table vs files | R3 |

R1 and R2 are order-independent (no shared state) but run them serially to avoid API
rate-limit interference distorting wall time.

## 11. Blast radius

This design doc is docs-only. The single proposed code change (B2) touches
`buildDirectPrompt`; its full consumer set:
```
grep -rn "buildDirectPrompt\|Use Read/Write only" plan-ledger --include=* (node_modules excluded)
  docs/ROLES.md:67           (prose mention)
  scripts/runner.mjs:125     (definition)
  scripts/runner.mjs:132     (the string)
  scripts/runner.mjs:136     (call site, runInjected)
  scripts/runner.mjs:255     (call site, dry-run print)
```
No other file in the repo references it. `docs/` previously contained only `ROLES.md`
(no filename collision). No schema or persisted-data changes anywhere in this design; the
plan-ledger DB is only appended to via its normal API (plan + attempts), no migration needed.

## 12. Threats to validity (report these verbatim in R4)

- **T1 n=1.** One task, one run per arm. Report point estimates; no significance claims.
  If budget allows, the cheapest upgrade is 3 runs per arm on the same task (seeds the
  variance estimate) before adding tasks.
- **T2 task-selection bias.** Task authored by the same model family being tested and by an
  author invested in the plan tool. Mitigations: spec + grader frozen and committed BEFORE
  either arm runs; black-box grading; alternate task (§3, option B) pre-registered here.
- **T3 spec/training leakage.** Expense CLIs are common training data. Mitigations: bespoke
  discriminating rules (integer-cents OVER test, exact tab-separated formats, exit-code map,
  schema-version rejection, failed-command-file-untouched) that a memorized generic solution
  fails; both arms share any residual leakage equally.
- **T4 orchestrator overhead accounting.** ARM B totals INCLUDE plan-creation tokens
  (`arm-b-plan.json`) and the runner's injected prompt overhead (inside per-agent usage).
  Runner node-process time is free but its wall time is inside `arm-b-wall.txt`. Not counted
  anywhere: the local plan-ledger MCP server (no API tokens).
- **T5 tool asymmetry.** Without B2, ARM B agents are told "Use Read/Write only"
  (`runner.mjs:132`) and cannot self-test — a handicap the vanilla arm doesn't have. B2 +
  identical `--allowed-tools` closes it; if B2 is skipped, this must be reported as a known
  ARM B handicap.
- **T6 caching asymmetry.** ARM A's single session reuses its prompt cache; ARM B's fresh
  process per step re-pays `cache_creation`. The in-token formula counts all components in
  both arms (consistent), and the 3-way split is reported so readers can separate "real" input
  from cache mechanics. This asymmetry is intrinsic to the designs being compared — it is
  signal, not noise, but must be visible.
- **T7 blind review is weakly blind.** Diff style may reveal the arm. Labels randomized and
  sealed; treat review scores as secondary color, never the headline.
- **T8 weak step-level verification in inject mode.** Runner "pass" = non-empty output
  (`runner.mjs:196–200`); a plan could "complete" with broken code. The hidden grade is the
  only outcome metric; plan completion status is reported separately as a plan-tool diagnostic.
- **T9 grader gaming / contamination.** Arms never contain grader files; grading runs from a
  pristine `git checkout` of `grader/`; arms are independent clones so no cross-contamination;
  agents have no network.

---
*Evidence base: `scripts/runner.mjs` (flags :49–64, spawn/cwd :109/:143, inject prompt
:125–139, pass gate :196–200, usage line :219, JSON fields :113–115), `package.json:13`
(`orchestrate` script), plan-ledger step 507 context, plan #97 step index (507–509).*
