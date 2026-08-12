# plan-ledger

External working memory for coding agents (Claude Code, Cursor, anything that
speaks MCP), exposed over the **Model Context Protocol**. It exists to fight the
three things that go wrong in long sessions — **context bloat, lost planning,
and forgotten failures** — by keeping the durable truth in a database instead
of in the model's head.

The core idea is **progressive disclosure**. Plans are surface-indexed: the
agent sees only `title + keywords` until it deliberately opens one. Each step
then carries its *own* self-contained context, tools, acceptance criteria, a
**carry-forward** note for the next step, and a **failure log** of past
attempts. So the agent pulls only what the current step needs and lets
everything else stay on disk — the context "reset" becomes architectural, not
something it has to remember to do.

## What it does, in one page

```
┌──────────────────────┐        ┌──────────────────────────────────────┐
│  Coding agent        │        │  plan-ledger                         │
│  (Claude, Cursor, …) │        │                                      │
│                      │ stdio  │  ┌────────────────────────────────┐  │
│  ┌────────────────┐  │◀──────▶│  │ MCP server (src/server.mjs)    │  │
│  │ MCP client     │──┼─ MCP ──┼──│  53 tools, slim acks,          │  │
│  └────────────────┘  │        │  │  directive fields              │  │
└──────────────────────┘        │  └───────────────┬────────────────┘  │
                                │                  │                   │
       ┌────────────────────────┼──────────────────┼───────────────┐   │
       ▼                        │                  ▼               │   │
┌─────────────────┐             │       ┌──────────────────┐       │   │
│  Web board      │             │       │ Store (db.mjs)   │       │   │
│  (web/server)   │─── read ────┼──────▶│  SQLite WAL,     │       │   │
│  localhost:4319 │             │       │  migrations      │       │   │
└─────────────────┘             │       └────────┬─────────┘       │   │
                                │                │                 │   │
                                │       ┌────────▼─────────┐       │   │
                                │       │ ~/Documents/     │       │   │
                                │       │  plan-ledger/    │       │   │
                                │       │  data/*.db (WAL) │       │   │
                                │       └──────────────────┘       │   │
                                │                                  │   │
                                │       ┌──────────────────┐       │   │
                                │       │ RAG sidecar      │       │   │
                                │       │ (src/rag/…)      │       │   │
                                │       │  6 rag_* tools   │       │   │
                                │       └──────────────────┘       │   │
                                └──────────────────────────────────┘   │
                                                                       │
       ┌───────────────────────────────────────────────────────────────┘
       ▼
┌─────────────────────────────────────┐
│  Headless orchestrator              │
│  scripts/runner.mjs                 │
│   – spawns a FRESH agent per step   │
│   – atomic claim so runners can't   │
│     dispatch the same step twice    │
│   – --live | --inject | --project   │
└─────────────────────────────────────┘
```

Read that in four beats:

1. **Store** — one SQLite file, WAL journaling, numbered migrations. All
   business rules (progressive disclosure, step-index invariants, atomic
   claiming) live here so every entry point behaves the same.
2. **MCP server** — Node stdio process, 53 tools with Zod schemas and short
   directives that keep autonomous loops honest.
3. **Web board** — read/write UI on `http://localhost:4319`, backed by the
   same DB.
4. **Runner** — one process per step for true context reset; only piece that
   speaks to Claude Code today (see the Cursor caveat below).

## Status

Both original phases have shipped, plus the RAG sidecar and Cursor
integration:

- **Core** — SQLite store + stdio MCP server, **53 tools**, tests green
  (`npm test` runs the store, RAG, MCP-protocol, and board-route suites).
- **Orchestrator** — `scripts/runner.mjs` makes plans walk themselves: a fresh
  headless agent per step (true context reset), **role-based dispatch**,
  atomic step-claim so parallel runners can't collide, objective `VERIFY:`
  gates, per-step usage logging, and usage-limit auto-retry
  (`npm run orchestrate`; `--live`, `--inject` flags below).
- **Projects** — plans group under a project; `next_plan()` drives continuous
  runs across a whole project.
- **Parallel frontier** — `ready_steps(claim:true)` atomically reserves every
  dependency-ready step so interactive orchestrators can fan independent work
  out safely.
- **Human review trail** — each step has a plain-English `layman` box plus an
  append-only notes thread for reviewer corrections and executor replies.
- **Roles** — each step names the specialist agent that executes it; the role
  map (`~/.claude/plan-roles.json`, per-repo `.plan-roles.json`) lets you
  rebind agents/charters/models per project. See [docs/ROLES.md](docs/ROLES.md).
- **Transparent execution roster (v5)** — activating a plan freezes each step's
  planned dispatch (role, agent, model, charter, resolution source, context
  preview) as an audited revision. Reassignments require a reason;
  `record_attempt` carries the actual agent/model/`model_source`/session so
  planned-vs-actual drift is visible per step. The board's *Execution roster*
  section renders it; MCP callers use `get_plan_roster`, `assign_step`, and
  `redo_step`.
- **RAG sidecar** — deterministic external-corpus retrieval (fs, git, website,
  MediaWiki); lives at its own disposable DB. See [docs/RAG.md](docs/RAG.md).
- **Cursor integration** — the same MCP server, plus a native Cursor Skill
  and workspace-relative MCP config. See [docs/CURSOR.md](docs/CURSOR.md).
- **Planner v2 governance/evidence** — new-plan flows run bounded `planner_start`
  discovery (completed vs related-active separation + consulted-id provenance),
  dispatch preflight gates, `COMPLETION_JSON` evidence validation, deterministic
  dispatch override reasons, one-correction noncompliance reassignment guidance,
  bounded transient retries, and atomic failure on partial publish outcomes.
- **Live activity + chat visibility contract** — execution posts concise lifecycle
  chat updates (dispatch, material phase changes, blockers, verification,
  reassignment, completion, and every 3 minutes during quiet work) while board
  telemetry heartbeats remain at least once per minute. Privacy boundary:
  operational telemetry only, never private reasoning.

## Data model

```
Project  name, status                                 ← plans group under a project
 └ Plan   title, keywords[], summary, status          ← surface-exposed (level 0)
    └ Step  idx (contiguous 1..N, UNIQUE per plan),   ← invariant enforced by db.mjs
            title, status, role,                       ← role = the agent that executes it
            context, tools[], acceptance_criteria,
            carry_forward,                             ← note written FOR this step
            attempts[] { what_tried, result, verdict } ← the failure log
    └ Link  from_step → (plan | step), relation        ← "builds_on" pathways back
```

## The three disclosure levels

| Level | Tool | Returns |
|------|------|---------|
| 0 | `list_plans` | title, keywords, status, counts — **no bodies** |
| 1 | `open_plan` | plan summary + an ordered **step index** (titles/status) |
| 2 | `get_step` | one step's **full** context, attempts log, and links |

## Tools (53)

47 ledger tools registered in [`src/server.mjs`](src/server.mjs) + 6 `rag_*`
tools registered by [`src/rag/tools.mjs`](src/rag/tools.mjs). The exact count
is asserted in [`test/mcp-e2e.mjs`](test/mcp-e2e.mjs):

**Projects:** `list_projects` · `create_project` · `set_current_project` ·
`set_project_status` · `get_project_context`
**Navigate:** `list_plans` · `open_plan` · `get_step` · `next_step` · `ready_steps` · `next_plan`
**Author:** `create_plan` · `add_step` · `update_step`
**Execution roster:** `assign_step` · `redo_step` · `get_plan_roster`
**Working loop:** `record_attempt` · `write_carry_forward` · `link_items` · `set_layman` · `add_note`
**Status:** `set_plan_status` · `set_step_status`
**Knowledge:** `get_context` · `get_lessons` · `project_brief` · `recall`
**Code graph:** `import_graph` · `build_graph` · `query_graph` · `graph_stats` · `ground_step`
**Refs:** `list_refs` · `create_ref` · `update_ref` · `delete_ref`
**File refs:** `add_file_ref` · `read_file_ref` · `remove_file_ref` · `suggest_file_refs`
**Templates:** `list_templates` · `get_template` · `create_template` ·
`instantiate_template` · `save_as_template` · `delete_template`
**RAG sidecar:** `rag_ingest` · `rag_status` · `rag_query` · `rag_expand` ·
`rag_cite` · `rag_forget`

## The working loop (how the agent should use it)

1. Call `next_plan()` once to get the workable plan (pass `project_id` to scope).
2. For interactive parallel work, call `ready_steps(plan_id, claim:true)` and
   dispatch the returned dependency-ready frontier concurrently. Otherwise call
   `next_step(plan_id, claim:true)` for one lowest-index workable step. Claiming
   flips the returned step(s) to `in_progress` in the same transaction, so two
   orchestrators cannot receive duplicate work.
3. Read its `carry_forward` and `attempts` — *never repeat what already failed*.
4. Do the work using only that step's `context` + `tools`.
5. Persist review corrections and replies with `add_note`. Then
   `record_attempt(step, …)` with a plain-English `layman` summary — `pass`
   finishes it; `fail` / `partial` is preserved so the approach isn't retried
   blindly.
6. If anything must survive into the next step,
   `write_carry_forward(<receiving_step_id>, …)`.
7. Loop to 2. When `next_step` returns `{complete}`, mark the plan done and
   call `next_plan()` again. When *that* returns `{complete}`, the run is over.

Every mutation tool ships a **`directive`** field on its ack that tells the
caller what to do next — follow it. That's how autonomous loops stay on rails
without duplicating logic in every client. Steps also carry a `role` — the
specialist agent that executes them — with a full review-gate protocol
documented in [docs/ROLES.md](docs/ROLES.md).

## Approval-first lifecycle (draft plans)

For every **new multi-step request**, planning and execution are separate phases:

1. Create the **complete plan** as `draft` first (all steps, roles/models, step
   `context`, `acceptance_criteria`, dependencies, and verification commands).
2. Present the **whole** plan, then explicitly ask the user for approval.
   Until approval happens, do **not** claim/dispatch any step.
3. On explicit approval (“approve”, “approved”, “go ahead”, “looks good”, or
   equivalent), activate the plan with `set_plan_status(<id>, "active")`, then
   immediately run the autonomous execution loop until completion with no further
   approvals between steps.
4. If the user requests revisions, treat that as **not approval**: revise the
   draft, present the whole revised plan again, and wait for explicit approval
   again.

In the MCP layer, calling `next_step`/`ready_steps` on a plan whose
`plan.status` is `draft` returns `awaiting_approval: true` and MUST NOT claim or
execute. The MCP server’s draft directive literally instructs you to ask:
**"Approve plan #<id> to begin execution?"** and only after approval to call
`set_plan_status(<id>, "active")` to resume.

## Run it

```sh
npm install               # Node.js >=22.5 required (uses node:sqlite)
npm start                 # stdio MCP server (for stdio MCP clients)
npm run board             # http://localhost:4319 read/write UI
npm test                  # store + RAG + MCP-protocol suites (should print all green)
npm run eval:rag          # RAG retrieval eval (variant table + ship gate)
```

The ledger DB lives at `~/Documents/plan-ledger/data/plan-ledger.db` by default
(the homedir install convention `defaultDbPath()` in
[`src/db.mjs`](src/db.mjs); override with `PLAN_LEDGER_DB`). The RAG index is
a **separate, disposable** sidecar at `~/Documents/plan-ledger/data/rag.db`
(override with `PLAN_LEDGER_RAG_DB`) — re-ingesting rebuilds it, so it never
risks the ledger.

The MCP server, the board, and the packaged exe all read that same default,
so a single ledger stays consistent across every entry point unless you
deliberately pin per-workspace overrides via env vars.

## R1 release validation and flags

Run the final C1-C4 release lane with one reproducible command:

```sh
npm run validate:r1-release
```

This writes machine-readable artifacts under `docs/audits/`:

- `r1-release-validation-report.json`
- `r1-release-readiness-matrix.json`
- `r1-rollout-rollback-runbook.md`

Feature flags used by C1-C4:

- `PLAN_LEDGER_COMPLETION_GATE=off|warn|enforce`
- `PLAN_LEDGER_AUTO_TERMINALIZE=off|shadow|enforce`
- `PLAN_LEDGER_AUTO_REASSIGN=off|advisory|enforce`
- `PLAN_LEDGER_BOARD_HEALTH_BADGES=off|on`

Read-only assessment commands (no state mutation):

```sh
node src/ledger-cli.mjs assess_plan_reconciliation --input '{"plan_id":1}'
node src/ledger-cli.mjs assess_plan_terminalization --input '{"plan_id":1}'
node src/ledger-cli.mjs assess_completion_backfill --input '{}'
node src/ledger-cli.mjs assess_activity_backfill --input '{}'
```

Board health states exposed by activity APIs/UI:

- `healthy`
- `awaiting_artifact`
- `stale_lease`
- `needs_manual_verification`

## Connect to Claude Code

Add to your Claude Code MCP config (`~/.claude.json` under the project, or via
`claude mcp add`). Use an absolute path — Claude Code does not interpolate
`${workspaceFolder}`:

```json
{
  "mcpServers": {
    "plan-ledger": {
      "command": "node",
      "args": ["/absolute/path/to/plan-ledger/src/server.mjs"]
    }
  }
}
```

Then in a session: *"Connect to plan-ledger and plan out X."* Claude calls
`list_plans` (or `project_brief`) to orient, `create_plan` + `add_step` to lay
out the work, then runs the loop above.

## Connect to Cursor

Cross-workspace `/plan-ledger` uses the **JSON CLI bridge** (`src/ledger-cli.mjs`) and the
**visual board** — not a global MCP server. The repo-local `.cursor/mcp.json` still wires MCP when
this checkout is the workspace (optional extras: RAG, templates, recall, code graph).

The Cursor-native Skill lives at
[`.cursor/skills/plan-ledger/SKILL.md`](.cursor/skills/plan-ledger/SKILL.md). After changing it,
run `npm run sync:global-skill` to refresh the user-global copy at
`~/.cursor/skills/plan-ledger/SKILL.md` and `~/.cursor/plan-ledger-bridge.json` (absolute Node +
repo paths). Every `/plan-ledger` invocation opens the board via `board command:"open"`.

Full Cursor setup — bridge invocation, board deep-links, role-charter fallback, the
runner-is-Claude-only caveat, and the tokens-only `agent -p` note — lives in
**[docs/CURSOR.md](docs/CURSOR.md)**.

## The orchestrator

`scripts/runner.mjs` makes plans walk themselves — a fresh headless agent per
step, so context truly resets between steps:

```
loop while nothing_stops_us:
  next_plan(project) → plan
  for each next_step(plan, claim:true):
    resolve the step's ROLE (role map → charter)
    spawn a FRESH headless agent  (clean context; adopts the role's charter)
      → it pulls just this step from plan-ledger over MCP (or --inject the
        context straight into the prompt, no MCP in the agent)
      → does the work, record_attempt, write_carry_forward
      → exits
    read the outcome from the DB, then next_step(claim:true)
  mark the plan done, next_plan again
```

Dry-run is the default; `--live` actually spawns agents and costs money:

```sh
npm run orchestrate -- --project <id> --live --retry-on-limit
npm run orchestrate -- --plan <id> --inject         # inject step context, no MCP in the agent
npm run orchestrate -- --plan <id> --live --parallel --max-workers 2   # bounded parallel dispatch
npm run orchestrate -- --plan <id> --live --parallel --skip-worktrees  # parallel without git worktrees
```

Parallel mode peeks the ready frontier, claims non-conflicting steps up to
`--max-workers` (default 2, max 8), and refills slots when a worker finishes.
Declare ownership via `OWNED_PATH:` / `OWNED_GLOB:` in step context or write-role
`file_refs`. Use `--repo-root` and `--worktree-base` for isolated git worktrees.

The runner uses the **atomic claim** (`next_step({ claim: true })`) so two
runners on the same DB can never receive the same step; orphaned
`in_progress` steps from a dead agent are swept back to `pending` on
pause/stop. Today it spawns `claude -p`; adapting it to Cursor's `agent -p`
needs a small executor swap (see [docs/CURSOR.md](docs/CURSOR.md) §5).

## Web board

`npm run board` starts a read/write UI at `http://localhost:4319` backed by
the same SQLite file. It's useful for spot-checking what the agent is doing,
editing step context by hand, and rendering plan graphs. Binds to
`127.0.0.1` — the board is a solo-dev tool, not a shared service.

### CLI launch + deep-link contract (for automation)

`src/ledger-cli.mjs` now supports:

- `board` `command:"open"` (alias: `"launch"`) to open/reuse the board.
- It first health-checks `http://127.0.0.1:$PLAN_LEDGER_WEB_PORT/api/plans`
  (default `4319`), starts `web/server.mjs` detached only when absent, waits
  until ready, then opens the OS browser unless `PLAN_LEDGER_NO_OPEN=1`.
- It always launches with the same DB convention as every other entry point:
  `defaultDbPath()` (`PLAN_LEDGER_DB` override respected), so cwd does not
  change which ledger is used.
- Optional deep-link args: `project_id`, `plan_id`, `step_id` (positive
  integers only). Invalid IDs are ignored and reported in
  `result.ignored_query_params`.
- Result contract for callers:
  `mode`, `url`, `port`, `db_path`, `reused_existing`, `started_server`,
  `server_pid`, `opened_browser`, `open_suppressed`,
  `ignored_query_params`.

The board front-end honors `?project_id=&plan_id=&step_id=` at initial load,
switching to the plan's project before opening the plan/step. Invalid or
mismatched IDs are ignored safely.

## Filesystem trust boundary

plan-ledger is a **trusted single-user local tool**. Several tools cross the
local filesystem boundary — `read_file_ref`, `import_graph`, `build_graph`,
and the RAG ingesters (`rag_ingest` fs/git/website/wiki) all read whatever
paths or URLs the agent supplies. That's the intended power of a local agent
memory, but if you allow prompt-injected content into your workflow, treat
those tools like a shell:

- `read_file_ref` refuses to load files above 5 MB by default. Raise or
  disable with `PLAN_LEDGER_MAX_FILE_BYTES` (bytes, or `0` to disable).
- The Cursor allowlist tiers in [docs/CURSOR.md](docs/CURSOR.md) §4 group
  reads/writes so you can auto-run the safe surface and keep prompts on
  anything that touches disk.

## More docs

- [docs/ROLES.md](docs/ROLES.md) — role dispatch and the review gate
- [docs/ROLE_MAP_DESIGN.md](docs/ROLE_MAP_DESIGN.md) — role-map resolver
- [docs/RAG.md](docs/RAG.md) — RAG sidecar agent guide
- [docs/RAG_DESIGN.md](docs/RAG_DESIGN.md) — RAG design and evaluation
- [docs/CURSOR.md](docs/CURSOR.md) — Cursor integration setup
- [docs/BENCHMARK_DESIGN.md](docs/BENCHMARK_DESIGN.md) — measurement plan
