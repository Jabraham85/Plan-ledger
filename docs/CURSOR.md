# Using plan-ledger in Cursor

plan-ledger runs in **Cursor** as well as Claude Code. Cursor 3.x (current release 3.11, Jul 2026)
has converged on the same file conventions Claude Code uses and reads several of Claude Code's own
directories natively, so there is **no parallel fork** — the same MCP server, the same 12 agent
charters in `~/.claude/agents/`, and a Cursor-native mirror of the `/plan` loop. This guide covers
the glue: MCP config, how Cursor picks up the roster and the plan skill, the approval UX, the
headless caveat, and what could not be confirmed without a Cursor install.

Findings here are drawn from the research memo `docs/research/cursor-surface-2026-07.md` — read it
for citations and confidence labels.

## 1. Connect the MCP server

Cursor reads MCP config from two locations (root key `mcpServers`, same shape Claude Code uses):

- **Global** — `~/.cursor/mcp.json` — available in every project.
- **Project** — `.cursor/mcp.json` at a repo root — scoped to that workspace; **wins** on a
  name collision with the global file.

This repo ships a ready template at [`.cursor/mcp.json`](../.cursor/mcp.json):

```json
{
  "mcpServers": {
    "plan-ledger": {
      "type": "stdio",
      "command": "node",
      "args": ["${userHome}/Documents/plan-ledger/src/server.mjs"]
    }
  }
}
```

- `"type": "stdio"` — plan-ledger is a local stdio server (Node ESM, `@modelcontextprotocol/sdk`).
- `${userHome}` — Cursor interpolates this (and `${env:NAME}`, `${workspaceFolder}`,
  `${workspaceFolderBasename}`, `${pathSeparator}`) in `command`/`args`/`env`. Adjust the path if
  plan-ledger is installed elsewhere.
- **Where to put it:** copy the block into `~/.cursor/mcp.json` to use plan-ledger everywhere, or
  keep it in a project `.cursor/mcp.json`. If you are editing the plan-ledger repo **itself** in
  Cursor, prefer the workspace-relative form so the server tracks your checkout:
  ```json
  "args": ["${workspaceFolder}/src/server.mjs"]
  ```
- **DB location:** the server writes `./data/plan-ledger.db` relative to its working directory
  (override with the `PLAN_LEDGER_DB` env var — add an `"env": { "PLAN_LEDGER_DB": "…" }` map to
  the server entry to pin it, exactly as with Claude Code).
- The shipped file also carries an inert top-level `"_note"` string documenting the tool count. It
  is not part of the MCP schema; Cursor ignores unknown top-level keys. Delete it if a strict JSON
  parser ever objects.

### Tool count — a 42→47-tool server is fine on Cursor 3.x

plan-ledger registers 42+ tools (and is growing toward ~47). The old **40-tool cap** that produced
"Exceeding total tools limit" warnings was removed when Cursor 2.4 (Jan 2026) moved MCP tools to
lazy/dynamic loading ("agents load MCPs only when needed"); current MCP docs list no tool-count
limit, and users report 80+ tools with no warning. **No clipping in current 3.x.** (Pre-2.3 Cursor
would have clipped this server — irrelevant for anyone on a current build.)

## 2. The agent roster — Cursor reuses `~/.claude/agents/`

Cursor subagents are markdown + YAML frontmatter, invoked by `/<name>`, by natural-language
mention, by automatic delegation from the `description`, or via the **Task tool** (parallel fan-out,
just like Claude Code's Agent tool). Cursor discovers them in project `.cursor/agents/`,
`.claude/agents/`, `.codex/agents/`, and **user** `~/.cursor/agents/`, `~/.claude/agents/`,
`~/.codex/agents/`.

**So the 12 plan-ledger role charters already in `~/.claude/agents/` are picked up by Cursor with no
duplication.** Nothing in this repo re-authors them. The role table, roster overrides
(`.plan-roles.json` / `~/.claude/plan-roles.json`), and dispatch/review gate are documented once in
[`ROLES.md`](ROLES.md) and apply to both clients.

> **Empirical-verify caveat.** The **user-level** `~/.claude/agents/` cross-read rests on Cursor's
> official docs alone (no independent second source at research time). Project-level `.cursor/agents/`
> and `.claude/agents/` and all frontmatter semantics are corroborated. Before relying on the
> user-level roster in Cursor, confirm empirically: drop a throwaway agent in `~/.claude/agents/`,
> open Cursor, and check it appears in the subagent list. If it does not, copy or symlink the
> charters into `~/.cursor/agents/` (or a project `.cursor/agents/`) as a fallback — the charter
> content is identical.

## 3. The plan skill

The `/plan` loop is shipped as a Cursor-consumable **Skill** at
[`.cursor/skills/plan-ledger/SKILL.md`](../.cursor/skills/plan-ledger/SKILL.md). Cursor reads Skills
from `.cursor/skills/<name>/SKILL.md`, `.agents/skills/`, and the legacy-compat `.claude/skills/`
(project), plus the user-level equivalents — so the same skill file can serve both clients if placed
in `.claude/skills/`. SKILL.md frontmatter: `name` (must match the folder), `description` (required),
optional `paths`/`disable-model-invocation`/`metadata`.

The skill body is the same plan-ledger discipline as the Claude Code `/plan` command — same loop,
same roles table, same dispatch + review gate — with **Cursor-appropriate dispatch wording**:

- **Claude Code:** `Agent` tool with `subagent_type = <role>`.
- **Cursor:** invoke the `/<role>` subagent or issue a **Task tool** call.
- **Fallback (either client, e.g. headless):** read `~/.claude/agents/<role>.md`, adopt that charter
  yourself, and self-review against its `## Definition of done` before recording the attempt.

The server itself emits a client-neutral `directive` on `next_step` that names **both** dispatch
paths, so the guidance is consistent whether you drive from the skill or straight off the tool
output.

Invoke the skill by name in Agent chat, or let it auto-attach when plan-ledger tools are in play.

## 4. Approval / allowlist UX

Cursor asks for approval **before every MCP tool call by default**, and MCP tools follow the same
Run-Mode / allowlist system as terminal commands (arguments are shown for inspection before a call
runs). For a 42-tool server driven in a tight loop this means a prompt per call unless you
**allowlist** plan-ledger's tools (or enable auto-run for the server) in Cursor's MCP settings.
Read-only navigation tools (`list_plans`, `open_plan`, `get_step`, `next_step`, `project_brief`,
`recall`) are the safe ones to auto-run first; leave state-changing tools (`record_attempt`,
`set_*_status`, `create_plan`, `add_step`) prompting until you trust the flow.

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
> per-request cost from the Admin API instead. plan-ledger's own orchestrator
> (`npm run orchestrate`) already assumes token-based accounting, so this is compatible.

## 6. Honest "could not confirm without a Cursor install" list

The research memo verified the surface against Cursor's live 3.x docs, changelog, and forum, but the
following were **not** empirically exercised on a running Cursor (no install available at build
time). Confirm these before depending on them:

1. **User-level `~/.claude/agents/` and `~/.claude/skills/` cross-read** — official-docs-only claim;
   verify with the throwaway-agent test in §2. (Project-level `.cursor/*` and `.claude/*` reads are
   corroborated.)
2. **`.cursorrules` (legacy root file) still loading in 3.x** — third-party "still works for now"
   claim (Apr 2026); the current rules doc no longer mentions it. plan-ledger does not rely on it —
   this repo uses AGENTS.md / `.cursor/rules/*.mdc` conventions, not `.cursorrules`.
3. **`cursor-agent` binary alias** — the pre-2.4 name; current docs only mention `agent`. Scripts
   should call `agent`. Verify whether `cursor-agent` still resolves before hard-coding it anywhere.
4. **Exact Cursor version that removed the 40-tool cap** (2.3 vs 2.4) — immaterial for current
   builds, but the 42-tool server is the natural empirical test if you want to pin it.
5. **`.cursor/mcp.json` strict-JSON tolerance of the `_note` key** — Cursor reads only `mcpServers`
   and should ignore unknown top-level keys, but this was not run against a live parser; drop the
   `_note` if you see a config-parse warning.

Everything the plan-ledger integration actually *depends on* (stdio MCP config, `${userHome}`
interpolation, the roster read, the plan skill, Task-tool dispatch, headless `agent -p`) is backed
by Cursor's official docs; the caveats above are the places to spot-check first.
