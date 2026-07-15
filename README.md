# plan-ledger

External working memory for Claude, exposed over **MCP**. It exists to fight the
three things that go wrong in long sessions — **context bloat, lost planning, and
forgotten failures** — by keeping the durable truth in a database instead of in
the model's head.

The core idea is **progressive disclosure**. Plans are surface-indexed: Claude
sees only `title + keywords` until it deliberately opens one. Each step then
carries its *own* self-contained context, tools, acceptance criteria, a
**carry-forward** note for the next step, and a **failure log** of past attempts.
So Claude pulls only what the current step needs and lets everything else stay on
disk — the context "reset" becomes architectural, not something it has to
remember to do.

## Status

Both original phases have shipped:

- **Core:** SQLite store + stdio MCP server, **47 tools**, tests green
  (`npm test` runs the store, RAG, and MCP-protocol suites).
- **Orchestrator:** `scripts/runner.mjs` makes plans walk themselves — a fresh
  headless agent per step (true context reset), **role-based dispatch**, and
  usage-limit auto-retry (`npm run orchestrate`; `--live`, `--inject` flags below).

On top of that core: **projects** (plans group under a project), a **roles** system
(each step names the specialist agent that executes it) with an overridable **role
map**, the **RAG sidecar** (deterministic external-corpus retrieval), and a **Cursor**
integration surface (on the `cursor` branch).

## Data model

```
Project  name, status                                 ← plans group under a project
 └ Plan   title, keywords[], summary, status          ← surface-exposed (level 0)
    └ Step  idx, title, status, role,                 ← role = the agent that executes it
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

## Tools (47)

41 ledger tools registered in `src/server.mjs` + 6 `rag_*` tools registered by
`src/rag/tools.mjs`:

**Projects:** `list_projects` · `create_project` · `set_current_project` ·
`set_project_status` · `get_project_context`
**Navigate:** `list_plans` · `open_plan` · `get_step` · `next_step` · `next_plan`
**Author:** `create_plan` · `add_step` · `update_step`
**Working loop:** `record_attempt` · `write_carry_forward` · `link_items`
**Status:** `set_plan_status` · `set_step_status`
**Knowledge:** `get_context` · `get_lessons` · `project_brief` · `recall`
**Code graph:** `import_graph` · `build_graph` · `query_graph` · `graph_stats` · `ground_step`
**Refs:** `list_refs` · `create_ref` · `update_ref` · `delete_ref`
**File refs:** `add_file_ref` · `read_file_ref` · `remove_file_ref` · `suggest_file_refs`
**Templates:** `list_templates` · `get_template` · `create_template` ·
`instantiate_template` · `save_as_template` · `delete_template`
**RAG sidecar:** `rag_ingest` · `rag_status` · `rag_query` · `rag_expand` · `rag_cite` ·
`rag_forget` — deterministic retrieval over external corpora; see [docs/RAG.md](docs/RAG.md).

## The working loop (how Claude should use it)

1. `next_step(plan)` → get the next actionable step **with full context**.
2. Read its `carry_forward` and `attempts` — *don't repeat what already failed*.
3. Do the work using only that step's `context` + `tools`.
4. `record_attempt(step, …)` — log the outcome. `pass` marks it done; `fail`/
   `partial` is preserved so the approach isn't retried blindly.
5. If anything must survive into the next step, `write_carry_forward(next_step, …)`.
6. Back to 1. When `next_step` returns `null`, the plan is complete.

Steps also carry a `role` — which specialist agent executes them and how the
review loop works is documented in [docs/ROLES.md](docs/ROLES.md).

## Run it

```sh
npm install
npm start            # stdio MCP server
npm test             # store + RAG + MCP-protocol suites
npm run eval:rag     # RAG retrieval eval (variant table + ship gate)
```

The ledger DB lives at `./data/plan-ledger.db` (override with `PLAN_LEDGER_DB`); the
RAG index is a **separate, disposable** sidecar at `./data/rag.db` (override with
`PLAN_LEDGER_RAG_DB`) — re-ingesting rebuilds it, so it never risks the ledger.

## Connect to Claude Code

Add to your Claude Code MCP config (`~/.claude.json` under the project, or via
`claude mcp add`):

```json
{
  "mcpServers": {
    "plan-ledger": {
      "command": "node",
      "args": ["C:\\Users\\AI\\Documents\\plan-ledger\\src\\server.mjs"]
    }
  }
}
```

Then in a session: *"Connect to plan-ledger and plan out X."* Claude calls
`list_plans` to orient, `create_plan` + `add_step` to lay out the work, then runs
the loop above.

## Cursor

plan-ledger runs in **Cursor** too — the same MCP server, the same 12 agent
charters in `~/.claude/agents/` (Cursor 3.x reads that directory natively, so
there's no fork), and a Cursor-native copy of the `/plan` loop. The glue ships in
this repo: [`.cursor/mcp.json`](.cursor/mcp.json) (stdio server config) and
[`.cursor/skills/plan-ledger/SKILL.md`](.cursor/skills/plan-ledger/SKILL.md) (the
plan loop as a Cursor Skill). Full setup — global vs project config, the roster
cross-read with its empirical-verify caveat, per-tool approval UX, and the headless
`agent -p` tokens-only note — is in **[docs/CURSOR.md](docs/CURSOR.md)**.

## The orchestrator (shipped)

`scripts/runner.mjs` makes plans walk themselves — a fresh headless agent per step,
so context truly resets between steps:

```
for each step the plan exposes:
  resolve the step's ROLE (role map → charter)
  spawn a FRESH headless agent  (clean context; adopts the role's charter)
    → it pulls just this step from plan-ledger over MCP (or --inject the
      context straight into the prompt, no MCP in the agent)
    → does the work, record_attempt, write_carry_forward
    → exits
  read the outcome from the DB, then spawn the next step
```

Run it (dry-run by default — `--live` actually spawns agents and costs money):

```sh
npm run orchestrate -- --project <id> --live --retry-on-limit
npm run orchestrate -- --plan <id> --inject          # inject step context, no MCP in the agent
```

**True context reset + zero hand-holding** at once: kick off a plan once and the
runner drives every step, dispatching each to the specialist agent its `role` names.
How roles resolve and how the review loop works is documented in
[docs/ROLES.md](docs/ROLES.md).

## Cursor

The same stdio server works in Cursor — anything that speaks MCP gets all 47 tools.
The Cursor integration surface (`.cursor/mcp.json`, a mirror rule/skill, and
`docs/CURSOR.md`) lives on the **`cursor` branch**; the research behind it is on `main`
at [docs/research/cursor-surface-2026-07.md](docs/research/cursor-surface-2026-07.md).
