# plan-ledger plugin

A Claude Code plugin that puts an ergonomic front door on the **plan-ledger** MCP server:

- **`/plan` command** — `new`, `list`, `open`, `board`, `work`, `next`, `done`.
- **plan-ledger skill** — makes Claude follow the working loop (read the failure log before
  retrying, carry context forward, pull narrow) whenever a plan is in play.

## Design note — where the MCP server is registered

This plugin intentionally ships **commands + skill only**. The MCP server itself stays
registered once, globally, in `~/.claude.json` (`mcpServers.plan-ledger` →
`node C:\Users\AI\Documents\plan-ledger\src\server.mjs`). That avoids a duplicate
registration (same server name from two places) and keeps the proven, working connection
as the single source. The plugin assumes that global entry exists.

> To make the plugin fully self-contained instead, remove the global `plan-ledger` entry
> from `~/.claude.json` and add a `.mcp.json` at this plugin's root registering the server.
> Don't run both at once — pick one home.

## Install

**Quick / dev (load directly):**
```sh
claude --plugin-dir "C:\Users\AI\Documents\plan-ledger\plugin"
```

**Persistent (via the local marketplace):**
```
/plugin marketplace add C:\Users\AI\Documents\plan-ledger
/plugin install plan-ledger@plan-ledger-marketplace
```

Then restart Claude Code. Type `/plan board` to confirm it loaded.

## Usage

```
/plan new Add a sprint-and-dash ability to the Unreal player character
/plan board            # all plans
/plan board 1          # one plan as a tree
/plan work 1           # work the next step, honoring the failure log
/plan done 4           # mark step 4 passed
```
