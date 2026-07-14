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

- **Phase 1 — core (done):** SQLite store + MCP server, 12 tools, tests green.
- **Phase 2 — orchestrator (next):** a runner that spawns a fresh headless agent
  per step so plans walk themselves with no hand-holding. See the bottom.

## Data model

```
Plan   title, keywords[], summary, status            ← surface-exposed (level 0)
 └ Step  idx, title, status,
         context, tools[], acceptance_criteria,
         carry_forward,                               ← note written FOR this step
         attempts[] { what_tried, result, verdict }   ← the failure log
 └ Link  from_step → (plan | step), relation          ← "builds_on" pathways back
```

## The three disclosure levels

| Level | Tool | Returns |
|------|------|---------|
| 0 | `list_plans` | title, keywords, status, counts — **no bodies** |
| 1 | `open_plan` | plan summary + an ordered **step index** (titles/status) |
| 2 | `get_step` | one step's **full** context, attempts log, and links |

## Tools (12)

**Navigate:** `list_plans` · `open_plan` · `get_step` · `next_step`
**Author:** `create_plan` · `add_step` · `update_step`
**Working loop:** `record_attempt` · `write_carry_forward` · `link_items`
**Status:** `set_plan_status` · `set_step_status`

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
node test/smoke.mjs  # store-level tests (20 checks)
node test/mcp-e2e.mjs# full MCP protocol test
```

The DB lives at `./data/plan-ledger.db` (override with `PLAN_LEDGER_DB`).

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

## Phase 2 — the orchestrator (planned)

`runner.mjs` will use the Claude Agent SDK to make plans walk themselves:

```
for each step the plan exposes:
  spawn a FRESH headless agent  (claude -p, clean context)
    → it pulls just this step from plan-ledger over MCP
    → does the work, record_attempt, write_carry_forward
    → exits
  read the outcome from the DB, then spawn the next step
```

This gives **true context reset + zero hand-holding** at once: you kick off a
plan once and the app drives every step. Phase 1's DB and tools are the shared
substrate — nothing here gets thrown away.
