# Roles — role-based step dispatch

Reference for anyone (developer or orchestrator session) assigning a `role` to a
plan-ledger step or running the dispatch/review loop.

Every step can name the specialist agent that executes it. The `role` value is the
filename stem of an agent charter in `~/.claude/agents/<role>.md`; the orchestrator
dispatches the step to that agent and reviews its report against the step's
`acceptance_criteria` and the role's own Definition of done. Empty `role` (`''`, the
default) means the orchestrator decides at dispatch time.

## The 12 roles

Derived from each agent file's frontmatter `description` — read the file for the full
charter, Report format, and Definition of done.

| role | use for |
|---|---|
| `architect` | system design before code: module boundaries, API/data contracts, migration-safe schema changes, decomposing epics into ordered steps — never implementation code (writing up an already-chosen decision → tech-writer) |
| `implementer` | implementing code to an existing spec/design across the stack, incl. web dashboards/HTML+JS frontends and the 3D-asset pipeline (Meshy gen, glb→fbx, headless import, sockets, retargeting); hands back when the spec is ambiguous |
| `test-engineer` | test suites, fixtures, and assertions — the content that runs inside a harness — edge cases, coverage gaps, flaky tests caused by test/harness code (product-code causes → debugger; runner machinery → build-devops) |
| `debugger` | reproducing + root-causing a known defect, incl. security defects, product-code flakes, and same-environment behavior divergence (editor vs packaged, host vs client); minimal fix plus a red-then-green regression test |
| `refactor-surgeon` | behavior-preserving restructuring: dedup, dead code, simplification, API/naming cleanup — tests green before and after |
| `build-devops` | build systems, CI-style automation, packaging, dev tooling; the runner/log-parsing machinery that executes headless suites; toolchain/env drift (versions, PATH, encodings, lockfiles); data-migration/backfill scripts with mandatory dry-run |
| `perf-engineer` | profiling, memory, algorithmic cost; optimizes only measured hotspots, proves wins with before/after numbers |
| `researcher` | multi-source technical research, evaluations, prior-art scans; cited, confidence-labeled findings — never code |
| `tech-writer` | design docs, ADRs/design records for decisions whose direction is already chosen (open decisions → architect), READMEs, runbooks, references, player-facing text; verifies every command/path/symbol against the repo |
| `ui-designer` | visual design: layout, typography, color, tokens, mockups, HUD composition; a bare "design screen X" routes here — ux-architect only when the ask is explicitly flows/states/inputs/navigation |
| `ux-architect` | user flows, IA, screen state machines, input mappings, onboarding sequencing, usability audits (not visual styling) |
| `game-designer` | mechanics, progression curves, economies, balance tuning — numbers-first specs mapped to data-driven homes (not gameplay code) |

## Customizing the roster (role map)

The 12-role roster is the **default**, not a hard limit. Two optional JSON files remap,
extend, or disable roles without touching any consumer (design: `ROLE_MAP_DESIGN.md`;
resolver: `../src/roles.mjs`):

- `<repo>/.plan-roles.json` — project layer, git-versioned with the code it configures.
- `~/.claude/plan-roles.json` — user layer, with an optional per-project `projects`
  section. `PLAN_LEDGER_ROLES=<path>` replaces this file's path (tests use it so they
  never touch your real config — same pattern as `PLAN_LEDGER_DB`).

```json
{
  "roles": {
    "researcher": "general-purpose",
    "implementer": { "model": "opus" },
    "game-designer": false
  },
  "projects": {
    "Frontier": {
      "roles": {
        "lore-writer": { "agent": "general-purpose", "charter": "~/.claude/agents/custom/lore-writer.md" }
      }
    }
  }
}
```

Entry forms: `"agent-name"` (shorthand for `{ "agent": … }`), `false` (disable → the
step is treated as untagged), or an object with optional `agent` (Agent-tool
`subagent_type` — built-ins like `general-purpose` and `Explore` included), `charter`
(markdown path for adopt-by-reading clients and the review gate's DoD; `~/` expands to
home, relative paths resolve against the declaring file's directory), `model`, `disabled`,
`note`. `{}` is legal: defaults, but pins the role as known (declares a new project role).

**Precedence** (first layer that defines the role key wins for the whole entry):

1. `step.role` selects *which* role is wanted (reassignment stays `update_step`).
2. `<repo>/.plan-roles.json` `roles` (consumers with a repo cwd only — the MCP server
   skips this layer; its directive tells the client to prefer a repo-local resolution).
3. User file `projects.<plan-ledger project name>.roles`.
4. User file `roles`.
5. Default charter chain: `<repo>/.claude/agents/<role>.md`, then `~/.claude/agents/<role>.md`.
6. Nothing anywhere → orchestrator decides (the untagged behavior).

**Degradation:** no config files → today's behavior, bit for bit. Malformed JSON → one
stderr warning, that layer is skipped — dispatch never crashes on config. Disabled or
unknown role → untagged handling (the `next_step` directive says why). Declared `charter`
missing on disk → the default chain; none exists → dispatch agent-only, review against
`acceptance_criteria` alone. The map is re-read at each resolution — edits apply to the
next dispatch, nothing is persisted.

**Adopt-by-reading template for Cursor-class clients** (a rule file can only *instruct*
the model — it cannot call MCP tools):

> When a plan step names a role, resolve it: check `.plan-roles.json` (repo root) then
> `~/.claude/plan-roles.json` (`projects.<project>.roles`, then `roles`) for that key;
> read the entry's `charter` (default `.claude/agents/<role>.md`, then
> `~/.claude/agents/<role>.md`) and follow its operating principles, Report format, and
> Definition of done as your own.

## How a step gets its role

- **Storage:** `steps.role` (`TEXT NOT NULL DEFAULT ''`) in `../src/db.mjs`; the
  2026-07 migration adds it to existing DBs (`steps` and `template_steps`).
- **Plan creation:** `add_step` takes a `role` param (`../src/server.mjs`). The `/plan new`
  flow requires one per step — pick the specialist whose discipline the step's core
  difficulty lives in.
- **Backfill:** if a step reaches dispatch untagged, pick a role from the table and
  `update_step(step_id, role: "<name>")`. Passing an empty string clears it.
- **Templates:** `template_steps` carry `role` too — `save_as_template` copies it out and
  `instantiate_template` copies it back in.

## Dispatch + review gate (interactive sessions)

Source of truth: the **"Roles — who executes a step"** section of
`~/.claude/commands/plan.md`. Summary:

- **Dispatch, don't do.** The orchestrator briefs the step's role agent (Agent tool,
  `subagent_type` = the role) with the step's `context` + `acceptance_criteria` +
  `carry_forward` + `lessons`. Self-execute only trivial mechanical steps; never
  delegate ledger bookkeeping.
- **Review gate, every dispatch (4 points):** (1) evidence first — quoted build/test
  output, real paths, screenshots; claims without evidence are an automatic send-back;
  (2) check `acceptance_criteria`, then the role's `## Definition of done` box by box;
  (3) unmet → `SendMessage` the same agent a numbered correction list, **max 3
  send-back rounds**, then finish it yourself or `record_attempt` fail with the lesson;
  (4) `record_attempt` always notes `role=<name>, review_rounds=<n>` in `what_tried`.
- `next_step` bakes this into its `directive` field: role-tagged steps come back with an
  explicit "DISPATCH it to the \"<role>\" agent … max 3 rounds" instruction
  (`../src/server.mjs`, `next_step` handler).

## How headless runs adopt roles

Headless `claude -p` agents can't be spawned *as* a subagent type, so
`../scripts/runner.mjs` (`roleLines`, used by both `buildPrompt` and
`buildDirectPrompt`/`--inject`) resolves the role through the role map
(`cwd = process.cwd()`, so a `.plan-roles.json` in the launch directory applies) and
prepends the **resolved, absolute** charter path to the step prompt:

> Adopt the "\<role\>" role: read `C:\Users\...\.claude\agents\<role>.md` FIRST and
> follow its operating principles, evidence rules, and Definition of done as your own.
> Your report must use its Report format.

A map entry's `model` is passed per step as `claude --model` (an explicit `--model`
flag on the runner command wins). The map's `agent` field is unused headless —
adopt-by-reading is the whole mechanism. Disabled/unknown/charterless roles fall back
to the untagged prompt.

Run headless (per `/plan`'s project loop):

```sh
npm run orchestrate -- --project <id> --live --retry-on-limit
```

Preview a step's prompt — role line included — without spawning anything (dry run is
the default):

```sh
node scripts/runner.mjs --plan <id>
```

Expected output includes the plan's pending steps and, for a role-tagged step, the
`Adopt the "<role>" role: read <absolute charter path> FIRST …` line.

## Adding or editing a role

For a project-local or one-off role, a role-map entry (see "Customizing the roster")
with a `charter` path is the lighter-weight alternative to the full procedure below —
no `~/.claude/agents` file needed, and it ships with the repo.

1. Create `~/.claude/agents/<role>.md` with YAML frontmatter: `name`, `description`
   (the routing text — say what to *use it for* and what it's *NOT for*), optional
   `tools:` allowlist (only `researcher` uses one today). The body is the charter and
   **must** end with `## Report format` and `## Definition of done` sections — the
   review gate checks the DoD box by box, and the headless prompt tells agents to
   report in the Report format.
2. Add the role to the table in `~/.claude/commands/plan.md` and in this file.
3. Pickup: the headless runner sees the file immediately (it just tells agents to read
   the path). New/edited agent files are picked up by the interactive session too —
   observed to hot-load within minutes, no restart needed (a restart guarantees it).
   The piece that DOES need a reconnect is the **plan-ledger MCP server**: the `role`
   param is validated by the zod schema loaded at server start (`../src/server.mjs`),
   so sessions connected before the field existed must reconnect the server before
   `add_step`/`update_step` accept `role`.
