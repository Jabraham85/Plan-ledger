# Using plan-ledger in Cursor

plan-ledger runs in **Cursor** as well as Claude Code. Cursor 3.x (current release 3.11, Jul 2026)
has converged on the same file conventions Claude Code uses and reads several of Claude Code's own
directories natively, so there is **no parallel fork** — the same 12 agent charters in
`~/.claude/agents/`, a JSON CLI bridge (`src/ledger-cli.mjs`), optional repo-local MCP for extras,
and a Cursor-native `/plan-ledger` Skill. (`/plan` is Cursor's built-in Plan Mode and is
intentionally not reused.) This guide covers the glue: the CLI bridge, optional MCP, how Cursor
picks up the roster and the plan skill, board deep-links, the approval UX, the headless caveat, and
what could not be confirmed without a Cursor install.

Findings here are drawn from the research memo `docs/research/cursor-surface-2026-07.md` — read it
for citations and confidence labels.

## 1. Cross-workspace bridge (primary)

The user-global `/plan-ledger` skill drives ledger I/O through **`src/ledger-cli.mjs`**, not MCP.
Every invocation opens the visual board first (`board` with `"command":"open"`).

### Prerequisites

- **Node.js ≥ 22.5** — the bridge uses `node:sqlite`. Verify with `node --version`.
- **Plan-ledger checkout** — the CLI lives at an absolute path under your install (e.g.
  `~/Projects/Plan-ledger/src/ledger-cli.mjs`).
- **Sync after skill edits** — from the repo:

```sh
npm run sync:global-skill
```

That writes `~/.cursor/skills/plan-ledger/SKILL.md` with resolved absolute Node + repo paths and
`~/.cursor/plan-ledger-bridge.json` so drift is detectable (`test/global-skill.mjs`).

### Bridge invocation

```powershell
& "<node.exe>" "<repo>/src/ledger-cli.mjs" list_plans --input '{}'
& "<node.exe>" "<repo>/src/ledger-cli.mjs" board --input '{"command":"open","plan_id":3}'
```

- Works from **any cwd** — DB location is `defaultDbPath()` / `PLAN_LEDGER_DB`, not cwd-relative.
- Default board port `4319` (`PLAN_LEDGER_WEB_PORT`). Set `PLAN_LEDGER_NO_OPEN=1` in tests only.
- **Do not** add `plan-ledger` to `~/.cursor/mcp.json` for cross-workspace use — MCP approval
  prompts block the tight plan loop. Remove any stale global `mcpServers.plan-ledger` entry.

### DB location

By default the store writes to `~/Documents/plan-ledger/data/plan-ledger.db` (the homedir convention
`defaultDbPath()` in `src/db.mjs` — shared by the CLI bridge, board, runner, and optional MCP).
Override with `PLAN_LEDGER_DB`. The RAG sidecar mirrors this with `PLAN_LEDGER_RAG_DB` (default
`~/Documents/plan-ledger/data/rag.db`, disposable).

## 1b. Optional repo-local MCP (extras)

When the **Plan-ledger repo** is the workspace, `.cursor/mcp.json` can still wire MCP for tools
not on the CLI bridge (templates, recall, file refs, code graph, bundled RAG). Cursor reads MCP
config from:

- **Global** — `~/.cursor/mcp.json` — available in every project.
- **Project** — `.cursor/mcp.json` at a repo root — scoped to that workspace; **wins** on a
  name collision with the global file.

### The shipped project config

This repo ships a ready template at [`.cursor/mcp.json`](../.cursor/mcp.json):

```json
{
  "mcpServers": {
    "plan-ledger": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/src/server.mjs"]
    }
  }
}
```

- Keep this **project-local** only. Do not copy it to `~/.cursor/mcp.json` unless you explicitly
  want MCP everywhere (not recommended — see approval UX §4).
- `${workspaceFolder}` — Cursor interpolates this in `command`/`args`/`env`.

### Tool count — a 53-tool server is fine on Cursor 3.x

plan-ledger registers **53 tools** (47 ledger + 6 RAG sidecar; `test/mcp-e2e.mjs` asserts the exact
count). The old **40-tool cap** that produced "Exceeding total tools limit" warnings was removed
when Cursor 2.4 (Jan 2026) moved MCP tools to lazy/dynamic loading ("agents load MCPs only when
needed"); current MCP docs list no tool-count limit, and users report 80+ tools with no warning.
**No clipping in current 3.x.** (Pre-2.3 Cursor would have clipped this server — irrelevant for
anyone on a current build.)

## 2. The agent roster — full Cursor sessions, explicit models

Plan-ledger's Cursor path uses the standalone **Cursor Agent CLI** for model-assigned work, not
opaque IDE subagents. Each step launches a fresh full session with an account-validated model:

```powershell
agent models
agent -p --output-format json --model "<staff model>" --trust --force `
  --workspace "<repo>" "<self-contained step brief>"
```

On native Windows the installer places the executable at
`%LOCALAPPDATA%\cursor-agent\agent.cmd`; run `agent login` once if needed. The JSON result includes
the real `session_id`, request ID, usage, and outcome. Record the session ID, requested model, and
`model_source:"cursor-cli"` in the step attempt. Separate invocations are independent `/new`-style
sessions. The role's persistent Staff context and optional charter are included in each brief.

Do not use Cursor Subagent/Task calls for model-assigned plan work: the orchestrator cannot
authoritatively verify which backend model they used. The role table, Staff model overrides, and
review gate are documented in [`ROLES.md`](ROLES.md).

## 3. The plan skill

The plan-ledger loop is shipped as a Cursor-consumable **Skill** at
[`.cursor/skills/plan-ledger/SKILL.md`](../.cursor/skills/plan-ledger/SKILL.md). Cursor reads Skills
from `.cursor/skills/<name>/SKILL.md`, `.agents/skills/`, and the legacy-compat `.claude/skills/`
(project), plus the user-level equivalents — so the same skill file can serve both clients if placed
in `.claude/skills/`. SKILL.md frontmatter: `name` (must match the folder), `description` (required),
optional `paths`/`disable-model-invocation`/`metadata`.

Invoke it as **`/plan-ledger`** (for example, `/plan-ledger work` or
`/plan-ledger new authentication refactor`). Do not invoke it as `/plan`: Cursor reserves `/plan`
for built-in Plan Mode. The skill opens the visual board on every invocation and uses the CLI bridge
for ledger I/O. After editing the skill, run `npm run sync:global-skill`.

The Skill carries the same plan-ledger discipline as the Claude Code plugin — same loop, roles
table, and review gate — with **Cursor-appropriate dispatch wording**:

- **Claude Code:** `Agent` tool with `subagent_type = <role>`.
- **Cursor:** launch a fresh full `agent -p` session with the Staff model and capture its JSON
  `session_id`.
- **Fallback (either client, e.g. headless):** read `~/.claude/agents/<role>.md`, adopt that charter
  yourself, and self-review against its `## Definition of done` before recording the attempt.

The server itself emits a client-neutral `directive` on `next_step` (and `next_plan`,
`record_attempt`, `set_plan_status`, `set_step_status`) that names **both** dispatch paths, so the
guidance is consistent whether you drive from the skill or straight off the tool output. **Treat
those `directive` fields as ground truth** on any ambiguity — including the outer loop, which is
`next_plan()`-driven, not a hand-rolled `list_plans → pick` heuristic.

### Planner-start + consulted provenance (required for new plans)

For every new plan draft:

1. Run `planner_start` with a bounded keyword set (`max_keywords <= 8`).
2. Keep `completed` matches (done plans) separate from `related_active` matches (in-flight plans).
3. Persist discovered consulted ids onto the draft (`draft_plan_id`) so `open_plan` surfaces
   `consulted_plans` for durable provenance.
4. Only treat completed matches as finished evidence.

### Active chat updates + telemetry cadence

During execution, keep both chat and board visibility healthy:

- Send concise chat updates at dispatch, material phase changes, blockers, verification,
  reassignment, and completion.
- When work is quiet, send a concise status heartbeat at least every **3 minutes**.
- Keep board activity telemetry heartbeats at least once per **minute**.
- Privacy boundary: operational telemetry only (status/phase/progress/files/artifacts/commands,
  dispatch rationale, blockers, verification/outcome). Never emit chain-of-thought/private reasoning.
- Exact operational fields: `plan_id`, `step_id`, `run_id`, `session_ref`, `role`, `agent`,
  `requested_model`, `actual_model`, `model_source`, `phase`, `action_summary`,
  `command_summary`, `status`, `outcome`, `verification_state`, `blocker`,
  `progress_completed`, `progress_total`, `file_count`, `artifact_count`,
  `recent_artifacts`, `metadata`, `updated_at`, `ended_at`.

### Governed completion contract

For injected/headless governed execution:

- Preflight gates (`runDispatchPreflight`) must pass before work starts.
- Completion must end with final-line `COMPLETION_JSON` evidence.
- Unsupported `pass` claims (no verifiable artifact/successful command) are rejected.
- Repeated completion-contract noncompliance recommends reassignment after one correction cycle.
- Material dispatch-policy mismatch requires explicit deterministic override reason.
- Transient retry is bounded; partial publish outcomes fail atomically.

For autonomous batch runs (e.g. Cursor CLI processes or the shipped runner) pass `claim: true` to
`next_step` so the returned step is atomically flipped to `in_progress` in one transaction — two
concurrent dispatchers can never receive the same step. The default (peek) preserves the
idempotent behavior humans expect when they call `next_step` twice while chatting.

For interactive parallel work, **peek first** — `ready_steps(plan_id, claim:false, limit:N)` —
then count free worker slots, exclude path-conflicting write steps (`OWNED_PATH:` / `OWNED_GLOB:`),
and **claim only the selected non-conflicting steps** (`claim:true, limit:N`). Refill each slot
immediately when a worker finishes; never claim the whole frontier before slot/path checks. Parallel
write mode uses isolated Git worktrees and serialized cherry-pick integration. Headless parallel:
`node scripts/runner.mjs --plan <id> --live --parallel --inject --max-workers 4` (sequential is
default without `--parallel`). Release gate: `npm run validate:r1-release`. Full contract:
`docs/audits/parallel-supervisor-design.md`.

Invoke the skill by name in Agent chat (`/plan-ledger`), or attach it manually for plan work.

### RAG sidecar (optional)

Six extra tools — `rag_ingest`, `rag_status`, `rag_query`, `rag_expand`, `rag_cite`, `rag_forget` —
give agents deterministic retrieval over external corpora (filesystem trees, git repos, websites,
MediaWiki). The RAG index lives at its own disposable DB (default
`~/Documents/plan-ledger/data/rag.db`, override with
`PLAN_LEDGER_RAG_DB`), so re-ingesting a corpus never risks the plan ledger. Full agent guide:
[`docs/RAG.md`](RAG.md).

## Approval-first plan lifecycle (draft plans)

In Cursor, plan-ledger’s approval boundary is explicit and consistent:

1. Every **new multi-step request** creates the **complete** plan first as `draft`
   (all steps, role/model assignments, per-step `context`, `acceptance_criteria`,
   dependency wiring, and verification commands).
2. The plan is presented in full (board), and execution is paused until explicit approval.
3. Requested revisions do **not** count as approval: you must re-present the revised draft
   and wait again.
4. On explicit approval (“approve”, “approved”, “go ahead”, “looks good”, or equivalent),
   the skill activates the plan via `set_plan_status(<id>, "active")` and then runs
   autonomously through completion without asking between steps.

Exact draft-gate behavior in the MCP server (and enforced by tests):

- If the plan is `draft`, `next_step` / `ready_steps` return `awaiting_approval: true`.
- The draft directive states you MUST not execute and MUST ask:
  **"Approve plan #<id> to begin execution?"**
- Step claiming/execution do not occur until after you activate the plan.

After activation, follow tool results’ `directive` fields: keep calling `next_step` /
`ready_steps` / `next_plan` until the plan is `done` (or the user explicitly scoped the run).

## 4. Approval / allowlist UX

Cursor asks for approval **before every MCP tool call by default**, and MCP tools follow the same
Run-Mode / allowlist system as terminal commands (arguments are shown for inspection before a call
runs). For a 50-tool server driven in a tight loop this means a prompt per call unless you
**allowlist** plan-ledger's tools (or enable auto-run for the server) in Cursor's MCP settings.

**Suggested tiers** (widen as trust grows):

- Auto-run — pure reads: `list_plans`, `open_plan`, `get_step`, `next_step` (peek only),
  `ready_steps` (peek only),
  `next_plan`, `project_brief`, `recall`, `list_projects`, `get_project_context`, `list_refs`,
  `list_templates`, `graph_stats`, `query_graph`, `rag_status`, `rag_query`,
  `rag_cite`, `rag_expand`.
- Prompt — mutations to the ledger: `create_plan`, `add_step`, `update_step`, `record_attempt`,
  `set_layman`, `add_note`, `write_carry_forward`, `link_items`, `set_plan_status`,
  `set_step_status`, `set_current_project`, `next_step`/`ready_steps` with `claim:true`,
  `create_project`, `set_project_status`, `instantiate_template`, `save_as_template`,
  `create_template`, `delete_template`.
- Prompt firmly — anything that reads real files or writes to the RAG sidecar: `read_file_ref`,
  `import_graph`, `build_graph`, `rag_ingest`, `rag_forget`. `read_file_ref` cannot exceed a size
  gate (default 5 MB, set `PLAN_LEDGER_MAX_FILE_BYTES=0` to disable, or a byte count to raise it).

## 5. Headless CLI

Cursor's headless binary is `agent` (installed via `curl https://cursor.com/install -fsS | bash`,
or `irm 'https://cursor.com/install?win32=true' | iex` on native Windows). A per-step run:

```sh
agent -p "<step brief>" --output-format json
```

Modes: `--mode=plan|ask` (default agent), `--force`/`--yolo` to actually apply edits in print mode,
`--continue` / `--resume="<id>"` to resume sessions, `CURSOR_API_KEY` for CI auth. Claude Code hooks
are compatible as of 2.4.

> **Tokens-only caveat.** The headless JSON `usage` object reports **`inputTokens`, `outputTokens`,
> `cacheReadTokens`, `cacheWriteTokens` — token counts only, no dollar cost** (per Cursor staff, Jul
> 2026; the public output-format doc does not yet document the `usage` object, so verify the exact
> shape empirically at integration time). Dollar cost is a backlog item; Teams/Enterprise can pull
> per-request cost from the Admin API instead.
>
> **Runner is Claude-only today.** `scripts/runner.mjs` spawns `claude -p` and parses its
> `total_cost_usd`; it does not yet know how to spawn `agent -p` or read Cursor's `usage` shape.
> If you want the orchestrator to walk plans headless in Cursor, either drive Cursor's `agent -p`
> yourself in a shell loop that calls `record_attempt`/`write_carry_forward` between calls, or add
> a small executor swap alongside `resolveClaude()` in the runner.

### Live Activity troubleshooting

When the board shows stale or missing activity:

1. Query `/api/activity/current` and `/api/activity/recent` for the same plan/step scope.
2. Confirm run identity consistency (`plan_id`, `step_id`, `run_id`, `session_ref`).
3. Check `updated_at` against stale threshold (`stale_after_ms`) and heartbeat cadence.
4. Verify terminal events were appended on completion/failure.
5. If state is stale with no active owner, recover or reassign before redispatch.

### R1 release-validation lane

Run the final C1-C4 release lane from the repo root:

```sh
npm run validate:r1-release
```

The lane is fail-closed and emits machine-readable artifacts under `docs/audits/`,
including `r1-release-validation-report.json` and `r1-release-readiness-matrix.json`.

### C1-C4 flags and diagnostics

Actual runtime flags:

- `PLAN_LEDGER_COMPLETION_GATE=off|warn|enforce`
- `PLAN_LEDGER_AUTO_TERMINALIZE=off|shadow|enforce`
- `PLAN_LEDGER_AUTO_REASSIGN=off|advisory|enforce`
- `PLAN_LEDGER_BOARD_HEALTH_BADGES=off|on`

Read-only diagnostics (CLI bridge operations):

```powershell
& "<node.exe>" "<repo>/src/ledger-cli.mjs" assess_plan_reconciliation --input '{"plan_id":1}'
& "<node.exe>" "<repo>/src/ledger-cli.mjs" assess_plan_terminalization --input '{"plan_id":1}'
& "<node.exe>" "<repo>/src/ledger-cli.mjs" assess_completion_backfill --input '{}'
& "<node.exe>" "<repo>/src/ledger-cli.mjs" assess_activity_backfill --input '{}'
```

Health-state vocabulary surfaced by `/api/activity/current` and rendered by the board:

- `healthy`
- `awaiting_artifact`
- `stale_lease`
- `needs_manual_verification`

## 6. Honest "could not confirm without a Cursor install" list

The research memo (`docs/research/cursor-surface-2026-07.md`) verified the surface against Cursor's
live 3.x docs, changelog, and forum, and the server itself is exercised end-to-end by
`test/mcp-e2e.mjs` (50-tool contract, slim acks, role directives, atomic single-step/frontier
claim semantics). The
following were **not** exercised on a running Cursor — confirm them once, then trust them:

1. **User-level `~/.claude/agents/` and `~/.claude/skills/` cross-read** — official-docs-only claim;
   verify with the throwaway-agent test in §2. (Project-level `.cursor/*` and `.claude/*` reads are
   corroborated.)
2. **`.cursorrules` (legacy root file) still loading in 3.x** — third-party "still works for now"
   claim (Apr 2026); the current rules doc no longer mentions it. plan-ledger does not rely on it.
3. **`cursor-agent` binary alias** — the pre-2.4 name; current docs only mention `agent`. Scripts
   should call `agent`. Verify whether `cursor-agent` still resolves before hard-coding it anywhere.
4. **`.cursor/mcp.json` strict-JSON tolerance of the `_note` key** — Cursor reads only `mcpServers`
   and should ignore unknown top-level keys, but this was not run against a live parser; drop the
   `_note` if you see a config-parse warning.

Everything the plan-ledger integration actually *depends on* (stdio MCP config, `${workspaceFolder}`
interpolation, the roster read, the plan skill, full-session `agent -p` dispatch) is backed
by Cursor's official docs; the caveats above are the places to spot-check first.
