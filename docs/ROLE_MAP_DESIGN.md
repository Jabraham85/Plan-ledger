# Role-map design — customizable agent roster for role dispatch

Plan #95, step 1 (architect). Status: proposed design, ready for implementation (plan #95 step 2).

## 1. Problem

Every plan-ledger step carries a `role` (free-text, `steps.role`, `src/db.mjs:44`) naming the
specialist that executes it. Today the roster is hardwired: `role` **is** the filename stem of
`~/.claude/agents/<role>.md` **and** the Agent-tool `subagent_type`, in all three consumers:

| consumer | where | hardwired assumption |
|---|---|---|
| /plan skill (interactive dispatch + review gate) | `C:/Users/AI/.claude/commands/plan.md` — "Roles — who executes a step" + work-loop step 4 | `subagent_type = role`; DoD read from "the bottom of its agent file" |
| `next_step` directive | `src/server.mjs:123-128` | `DISPATCH it to the "${step.role}" agent (Agent tool, subagent_type: "${step.role}")` |
| headless runner (adopt-by-reading) | `scripts/runner.mjs:74-79` (`roleLines`, used by `buildPrompt` :85 and `buildDirectPrompt` :128) | `read ~/.claude/agents/${step.role}.md FIRST` |
| reference doc | `docs/ROLES.md` | documents all of the above |

The user cannot: point a role at a different agent (built-ins like `general-purpose`/`Explore`
included), swap in a different charter file (for adopt-by-reading clients: the headless runner,
Cursor rules), override the model per role, add project-specific roles, or disable a role —
without editing three consumers by hand.

## 2. Decision criteria (stated before scoring)

1. **Readable by ALL consumers.** The /plan skill runs in Claude Code with file access; `server.mjs`
   and `runner.mjs` are Node with `fs`; a Cursor rule is a markdown file that can only *instruct*
   the model to read a path — it cannot call MCP tools or open SQLite.
2. **Single source of truth** — one place the user edits; consumers derive, never copy.
3. **No MCP schema churn** — `role` stays a free-text string on `add_step`/`update_step`
   (`src/server.mjs:161,176`); no new tools, no zod changes, no client reconnect requirement
   (the reconnect pain is documented in `docs/ROLES.md` §"Adding or editing a role").
4. **Works headless** — the runner must resolve the map before spawning; `--inject --lean` agents
   (no MCP at all, `scripts/runner.mjs:122-138`) must still get the right charter line.
5. **Discoverable & editable by the user** — findable without tooling, editable in any editor,
   ideally git-versionable alongside the project.

## 3. Options

### Option A — plan-ledger refs-based role map
A ref row (`kind:'tool'`, `name:'role-map'`, project-scoped, JSON body) in the existing `refs`
table (`src/db.mjs:91-96`), edited via `create_ref`/`update_ref` (`src/server.mjs:265,286`).

### Option B — plain JSON config files (recommended)
`~/.claude/plan-roles.json` (user layer, with an optional per-project section) plus an optional
repo-local `<repo>/.plan-roles.json` (project layer, git-versioned with the code it configures).

### Option C — project-local `.claude/agents/` shadowing only
No map at all; rely on Claude Code's native project-level agent directory to shadow user agents.

| Option | all consumers read it | single source of truth | no MCP schema churn | works headless | discoverable/editable | git-versionable | verdict |
|---|---|---|---|---|---|---|---|
| A: refs role-map | ✗ Cursor rule can't reach the DB/MCP; skill+server+runner OK | ✓ (the DB) | ✓ (reuses refs) | ✓ (runner has `Store`) | ✗ hidden in a DB body; edited via MCP calls; JSON-in-a-text-field, no editor support; **leaks into `get_context` blobs** (`src/server.mjs:306-313` folds enabled refs into every handoff) | ✗ | rejected |
| B: JSON files | ✓ fixed paths, `fs`/Read everywhere; a Cursor rule can say "read `.plan-roles.json`" | ✓ per layer, with explicit precedence | ✓ zero | ✓ tiny sync read pre-spawn | ✓ plain file, documented path | ✓ (repo file) | **chosen** |
| C: `.claude/agents/` shadowing | ✗ runner/server/Cursor need path-mirroring logic; interactive-only | ✓ | ✓ | ✗ runner only knows `~/.claude/agents` | ✓ for charters, but cannot express agent remap / model / disable / built-ins | ✓ | rejected as the mechanism; **absorbed** into charter fallback (§5.3) |

**Why B wins:** the one consumer that kills A is the adopt-by-reading client — a Cursor rule (a
markdown file) can instruct "read this JSON file" but cannot call `list_refs`; and refs bodies are
folded into every `get_context` handoff, so a config blob would pollute the very context blobs the
tool exists to keep small. C cannot express "route `researcher` to `general-purpose`" or "disable
`game-designer` here" at all. **What would flip it:** if the DB grew a first-class HTTP/file export
that Cursor-class clients could read, and `get_context` learned to exclude config-kind refs, A's
"one queryable store" would become attractive again.

## 4. Contract — file schema

Two files, same `roles` object shape. Both optional; absent files = today's behavior, bit for bit.

### 4.1 `~/.claude/plan-roles.json` (user layer) — **NEW**

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
        "lore-writer": {
          "agent": "general-purpose",
          "charter": "~/.claude/agents/custom/lore-writer.md",
          "model": "sonnet",
          "note": "project-specific role; charter carries its own Report format + DoD"
        },
        "ui-designer": { "charter": "D:/design/frontier-ui-charter.md" }
      }
    }
  }
}
```

### 4.2 `<repo>/.plan-roles.json` (project layer, git-versioned) — **NEW**

```json
{
  "roles": {
    "test-engineer": { "agent": "test-engineer", "model": "haiku" }
  }
}
```

### 4.3 Role-entry value forms (normative)

| form | meaning |
|---|---|
| `"agent-name"` (string) | shorthand for `{ "agent": "agent-name" }` |
| `false` | role **disabled** in this layer → treat the step as untagged (orchestrator decides) |
| object | fields below |

Object fields (all optional; an empty object `{}` is legal and means "defaults, but pin this role
as known" — useful to declare a NEW project role whose charter follows the default path scheme):

| field | type | meaning | default when absent |
|---|---|---|---|
| `agent` | string | Agent-tool `subagent_type` (any: the 12 roster names, `general-purpose`, `Explore`, `claude`, …) | the role name itself |
| `charter` | string | path to the charter markdown for adopt-by-reading clients and for the review gate's Definition of done. `~/` expands to the home dir; relative paths resolve against **the directory of the file that declared it** | first existing of `<repo>/.claude/agents/<role>.md`, `~/.claude/agents/<role>.md` (§5.3) |
| `model` | string | model override. Runner passes it verbatim to `claude --model`; interactive dispatch passes it as the Agent-tool `model` param only when it is one of that tool's accepted aliases, else ignores it with a note | none (inherit) |
| `disabled` | boolean | same as the `false` shorthand | `false` |
| `note` | string | human comment (JSON has none) | — |

Unknown fields are ignored (forward compatibility). The file is read fresh on each resolution —
no caches, no watchers; it is a sub-kilobyte file.

### 4.4 Environment override — **NEW**

`PLAN_LEDGER_ROLES=<path>`: when set, that file is used **instead of** `~/.claude/plan-roles.json`
(the repo-local layer still applies). Purpose: tests never touch the user's real config — same
pattern as the existing `PLAN_LEDGER_DB` (`scripts/runner.mjs:69`).

## 5. Precedence and resolution

### 5.1 Precedence chain (highest first)

1. `step.role` — selects **which role** is wanted (never overridden by the map; reassignment is
   `update_step`, exactly as today).
2. **Project map**, resolving that role: (a) `<repo>/.plan-roles.json` `roles`, then
   (b) user file `projects[<project name>].roles` (project name = `projects.name`,
   `src/db.mjs:16-23`). Layer (a) only exists for consumers that have a repo cwd (§5.4).
3. **User map**: user file top-level `roles`.
4. **Default roster**: `<repo>/.claude/agents/<role>.md`, then `~/.claude/agents/<role>.md`.
5. **Orchestrator decides**: role empty, disabled, or unknown everywhere → the existing untagged
   behavior (`src/server.mjs:128`).

First layer that defines the role key wins **for the whole entry** (no per-field merging across
layers — simpler to reason about; a layer that wants to tweak one field restates the entry).

### 5.2 Resolver contract — **NEW** `src/roles.mjs`

```js
// src/roles.mjs (NEW, ESM, node:fs + node:os + node:path only — no deps)

/**
 * @param {string} role        step.role ('' allowed)
 * @param {object} opts
 * @param {string|null} opts.cwd          repo root for the repo-local layer; null = skip that layer
 * @param {string|null} opts.projectName  plan-ledger project name for the user file's projects section
 * @returns {{ mode: 'dispatch', role: string, agent: string, charter: string|null,
 *             model: string|null, source: 'project-file'|'user-project'|'user'|'default' }
 *         | { mode: 'orchestrator', role: string, reason: 'untagged'|'disabled'|'unknown' }}
 */
export function resolveRole(role, { cwd = null, projectName = null } = {})

/** Read + parse one map file; returns {} on missing file, and on malformed JSON
 *  returns {} after a single console.warn (never throws — dispatch must not crash). */
export function loadRoleMap(path)
```

Pseudocode:

```
resolveRole(role, {cwd, projectName}):
  if role.trim() == ''            → { mode:'orchestrator', reason:'untagged' }
  userPath  = env.PLAN_LEDGER_ROLES ?? ~/.claude/plan-roles.json
  user      = loadRoleMap(userPath)
  layers    = [ cwd ? loadRoleMap(cwd/.plan-roles.json).roles : null,
                projectName ? user.projects?.[projectName]?.roles : null,
                user.roles ]
  entry     = first non-null layer that has own-key `role`   // normalize: string→{agent}, false→{disabled:true}
  if entry?.disabled              → { mode:'orchestrator', reason:'disabled' }
  agent     = entry?.agent ?? role
  charter   = expandTilde(entry?.charter, relativeTo=declaring file's dir)
              ?? firstExisting(cwd/.claude/agents/<role>.md, ~/.claude/agents/<role>.md)
  if !entry && !charter           → { mode:'orchestrator', reason:'unknown' }   // not a roster role at all
  return { mode:'dispatch', role, agent, charter, model: entry?.model ?? null, source }
```

Note the last guard: a default-roster role with no map entry resolves via its charter file
existing — i.e. **today's 12 roles resolve identically with zero config present**.

### 5.3 Charter fallback (absorbs Option C)

Default charter lookup checks `<repo>/.claude/agents/<role>.md` before `~/.claude/agents/<role>.md`,
matching Claude Code's own project-shadows-user agent resolution — so a project that already ships
a project-local charter gets consistent adopt-by-reading behavior with no map entry.

### 5.4 Who passes which `cwd`

| consumer | `cwd` | `projectName` |
|---|---|---|
| /plan skill (interactive) | session cwd (the repo) | current project (`get_project_context`/board header) |
| `runner.mjs` | `process.cwd()` (runner is launched from the working repo; its prompts already say "Work in the current directory", `scripts/runner.mjs:132`) | `store.projectNameForPlan(step.plan_id)` (**NEW** helper, §6.2) |
| `server.mjs` | `null` — an MCP server's cwd is not reliably the working repo, so it **skips the repo-local layer** and serves the user-file layers only; the directive text tells the orchestrator the repo-local file may still override (§6.1) | `store.projectNameForPlan(plan_id)` |

This keeps every consumer truthful about what it can actually see; the interactive skill (which
has full file access) re-resolves with all layers and therefore always applies full precedence.

## 6. Per-consumer integration spec

### 6.1 `src/server.mjs` — `next_step` directive (lines 123-128)

Replace the `const dispatch = step.role ? … : …` block:

```js
import { resolveRole } from './roles.mjs';
// inside the next_step handler, after `const step = store.nextStep(plan_id)`:
const r = resolveRole(step.role, { cwd: null, projectName: store.projectNameForPlan(plan_id) });
const dispatch = r.mode === 'dispatch'
  ? `DISPATCH it to the "${r.agent}" agent (Agent tool, subagent_type: "${r.agent}"` +
    (r.model ? `, model: "${r.model}"` : '') + `) with a brief composed ` +
    `from this step's context + acceptance_criteria + carry_forward + lessons` +
    (r.agent !== r.role && r.charter
      ? `; the brief MUST open with: read + adopt the "${r.role}" charter at ${r.charter}` : '') +
    `; if ./.plan-roles.json in the repo maps "${r.role}" differently, prefer that resolution; ` +
    `when it reports, REVIEW the deliverable against the acceptance_criteria and the role's ` +
    `Definition of done (from ${r.charter ?? 'the acceptance_criteria alone'}; evidence required — ` +
    `claims don't count), send corrections back to the same agent if it falls short (max 3 rounds), `
  : r.reason === 'untagged'
    ? 'work it (or dispatch to the best-fit role agent), '
    : `work it (role "${step.role}" is ${r.reason === 'disabled' ? 'disabled in the role map' :
       'not in the roster or role map'} — pick the best-fit role from docs/ROLES.md yourself, ` +
      `or update_step(${step.id}, role: "<name>")), `;
```

No zod/tool-schema change → no reconnect requirement, satisfying criterion 3. Behavior with no
config files: `r.agent === r.role`, no model, charter = default path → directive text is
semantically identical to today's (plus the repo-local hint clause).

### 6.2 `src/db.mjs` — one **NEW** helper (near `getProject`, `src/db.mjs:225`)

```js
projectNameForPlan(planId) {
  const row = this.db.prepare(
    'SELECT p.name FROM projects p JOIN plans l ON l.project_id = p.id WHERE l.id = ?').get(planId);
  return row?.name ?? null;
}
```

No schema change; `steps.role` stays `TEXT NOT NULL DEFAULT ''` (`src/db.mjs:44,149`). Nothing is
persisted about the resolution — the map is re-read at each dispatch, so edits take effect on the
next step with no migration. **Migration plan: N/A by construction** (no persisted-data change;
the only stored value remains the abstract role name, which is exactly what makes remapping safe).

### 6.3 `scripts/runner.mjs` — `roleLines` (lines 74-79) + model passthrough

```js
import { resolveRole } from '../src/roles.mjs';

function roleLines(step) {
  const r = resolveRole(step.role, { cwd: process.cwd(),
    projectName: store.projectNameForPlan(step.plan_id) });
  if (r.mode !== 'dispatch' || !r.charter) return [];   // untagged/disabled/unknown/charterless → today's untagged prompt
  return [`Adopt the "${r.role}" role: read ${r.charter} FIRST and follow its operating ` +
          `principles, evidence rules, and Definition of done as your own. Your report must use its Report format.`];
}
```

- The emitted charter path is now **absolute and resolved** (today it is the literal string
  `~/.claude/agents/<role>.md`, which the spawned agent must expand itself).
- Model: in `runAgent` (:102) and `runInjected` (:136), where `if (model) args.push('--model', model)`
  — change to `const m = model ?? resolved.model; if (m) args.push('--model', m)` with the per-step
  resolution hoisted so it is computed once per step (CLI `--model` flag wins over the map).
- `r.agent` is intentionally unused headless: a `claude -p` process cannot be spawned *as* a
  subagent type (`scripts/runner.mjs:72-73`); adopt-by-reading is the whole mechanism here.
- Dry-run (`--plan <id>` without `--live`, :239-263) already prints the first pending step's
  prompt — it becomes the free, binary verification for this consumer.

### 6.4 `C:/Users/AI/.claude/commands/plan.md` — "Roles — who executes a step" section

Insert after the roles table (and adjust work-loop step 4 to say "resolve the role per Roster
overrides"):

> **Roster overrides.** Before dispatching, resolve the step's `role` through the role map:
> read `.plan-roles.json` in the repo root and `~/.claude/plan-roles.json` if they exist
> (precedence: repo file → user file `projects.<current project>.roles` → user file `roles` →
> the table above / `~/.claude/agents/`). An entry may rename the executing agent (`agent` =
> any subagent_type, built-ins included), point at a `charter` file, set a `model`, or disable
> the role (`false`). Dispatch with `subagent_type` = the resolved agent (+ `model` if set and
> supported); when the resolved agent differs from the role name and a charter exists, the brief
> MUST open with "read + adopt <charter path>". The review-gate DoD comes from the resolved
> charter; no charter → review against `acceptance_criteria` only. Disabled or unknown role →
> treat the step as untagged: pick from the table (or the map's project roles) and `update_step`.
> Project-specific roles are any extra keys in the map's `roles` — they are valid `role` values
> for `add_step`/`update_step` like the built-in twelve.

### 6.5 `docs/ROLES.md`

New section "Customizing the roster (role map)": both file paths, the §4 schema (verbatim
example), the §5.1 precedence chain, the `PLAN_LEDGER_ROLES` env var, degradation table (§7), and
an **adopt-by-reading template for Cursor-class clients** (a rule file is the consumer we never
execute — we can only document it):

> When a plan step names a role, resolve it: check `.plan-roles.json` (repo root) then
> `~/.claude/plan-roles.json` (`projects.<project>.roles`, then `roles`) for that key; read the
> entry's `charter` (default `.claude/agents/<role>.md`, then `~/.claude/agents/<role>.md`) and
> follow its operating principles, Report format, and Definition of done as your own.

Also update §"Adding or editing a role" to mention that a map entry with a `charter` is now the
lighter-weight alternative to creating a `~/.claude/agents` file for project-local roles.

## 7. Degradation behavior (normative)

| condition | behavior |
|---|---|
| neither config file exists | identical to today: 12 roles, `subagent_type = role`, charter `~/.claude/agents/<role>.md` |
| malformed JSON in a map file | `loadRoleMap` warns once (stderr) and returns `{}` — that layer is skipped; **dispatch never crashes on config** |
| role disabled (`false` / `disabled:true`) | step treated as untagged: orchestrator picks; directive says why |
| unknown role (no map entry, no charter file anywhere) | same untagged fallback; interactive skill should `update_step` a real role (existing backfill rule, `docs/ROLES.md` §"How a step gets its role") |
| `charter` path set but file missing on disk | fall back to the default charter chain (§5.3); if none exists, dispatch agent-only and review against `acceptance_criteria` alone |
| `model` not accepted by the Agent tool (interactive) | ignore the model, note it in the dispatch announcement; headless passes it verbatim and the CLI errors surface normally |
| `agent` names a nonexistent subagent_type | the Agent tool errors at launch → orchestrator falls back to untagged handling and records the lesson (no pre-validation: the tool is the authority on valid types) |
| server (`cwd:null`) vs skill (full layers) disagree | the directive's "if ./.plan-roles.json maps it differently, prefer that" clause makes the skill's fuller resolution win |

## 8. Trust boundary

Map files are user-authored local config, same trust class as `~/.claude/agents/*.md` charters
(which are already injected into prompts verbatim). A repo-local `.plan-roles.json` arriving via
`git pull` can, at worst, point a role at a different charter path or agent — the same power a
pulled `.claude/agents/` file already has in Claude Code's native scheme. `charter` contents are
read by the *agent* at adopt time under the session's normal file permissions; the resolver itself
only ever reads the two well-known paths plus the declared charter path, and executes nothing.

## 9. Implementation step list (dependency-ordered; = plan #95 step 2, split)

All verification commands are PowerShell 5.1-safe. Baseline: `npm test` green at commit `914983e`
(runs `test/smoke.mjs` + `test/mcp-e2e.mjs` via `package.json:15`).

1. **Resolver module (contract skeleton)** — role: implementer.
   Context: create `src/roles.mjs` exporting `resolveRole` + `loadRoleMap` exactly per §5.2
   (incl. `PLAN_LEDGER_ROLES`, tilde/relative-path expansion, string/`false` normalization,
   warn-don't-throw); add `Store.projectNameForPlan` per §6.2. No consumer changes yet.
   Acceptance: with no config files present, `resolveRole('implementer',{cwd:null,projectName:null})`
   returns `mode:'dispatch'`, `agent:'implementer'`, charter ending `.claude\agents\implementer.md`;
   `resolveRole('',{})` returns `mode:'orchestrator', reason:'untagged'`; `npm test` still green.
   Verify: `node -e "const{resolveRole}=await import('./src/roles.mjs');console.log(JSON.stringify(resolveRole('implementer',{})));console.log(JSON.stringify(resolveRole('',{})))" ; npm test`
   (run from the repo root). Depends on: —.
2. **Runner integration** — role: implementer.
   Context: §6.3 changes to `scripts/runner.mjs` (`roleLines` via resolver, absolute charter path,
   per-step model passthrough with CLI-flag priority). Dry run must show the resolved line.
   Acceptance: with `PLAN_LEDGER_ROLES` pointing at a scratch map `{"roles":{"architect":{"charter":"<abs path to any existing .md>"}}}`,
   `node scripts/runner.mjs --plan 95` prints an `Adopt the "architect" role: read <that abs path> FIRST` line; without the env var it prints the default `…\.claude\agents\architect.md`; nothing is spawned (dry run).
   Verify: `$env:PLAN_LEDGER_ROLES='<scratch map path>'; node scripts/runner.mjs --plan 95; Remove-Item Env:PLAN_LEDGER_ROLES; node scripts/runner.mjs --plan 95`. Depends on: 1.
3. **Server directive integration** — role: implementer.
   Context: §6.1 replacement of `src/server.mjs:123-128` + import. No inputSchema changes anywhere.
   Acceptance: `npm test` green (proves no tool-schema regression); a `next_step` call against a
   role-tagged step, with `PLAN_LEDGER_ROLES` mapping that role to `{"agent":"general-purpose"}`,
   returns a directive containing `subagent_type: "general-purpose"`; with the env var unset the
   directive matches today's wording for a default role.
   Verify: `npm test` plus the e2e assertion landed in step 4 (steps 3+4 may run in the same session; 3 is code, 4 is test content). Depends on: 1. Parallel-safe with: 2.
4. **Test coverage** — role: test-engineer.
   Context: extend `test/smoke.mjs` with resolver cases (precedence order across the three layers,
   string/`false` shorthands, disabled, unknown role, malformed JSON warns-and-skips, tilde +
   relative charter expansion, `PLAN_LEDGER_ROLES` substitution, `projectNameForPlan`) and
   `test/mcp-e2e.mjs` with the directive case from step 3 (fixture map via `PLAN_LEDGER_ROLES`
   written to a temp dir; never touch `~/.claude/plan-roles.json`).
   Acceptance: `npm test` green; the new assertions fail if precedence order or the directive
   text regresses (spot-check by temporarily inverting a layer). Verify: `npm test`. Depends on: 1-3.
5. **Docs + skill wiring** — role: tech-writer.
   Context: §6.4 edit to `C:/Users/AI/.claude/commands/plan.md`; §6.5 section in `docs/ROLES.md`
   (schema, precedence, env var, degradation table, Cursor template); note the runner's new
   absolute-path adopt line where ROLES.md currently quotes the `~` form (docs/ROLES.md §"How
   headless runs adopt roles").
   Acceptance: both files contain a "Roster overrides"/"Customizing the roster" section naming
   both file paths and the 5-link precedence chain; every command quoted in ROLES.md still runs.
   Verify: `Select-String -Path 'C:/Users/AI/.claude/commands/plan.md','C:/Users/AI/Documents/plan-ledger/docs/ROLES.md' -Pattern 'plan-roles.json' ; node scripts/runner.mjs --plan 95`. Depends on: 1-4 (documents shipped behavior).

Step sizing: each is one consumer/subsystem, well under 400 LOC, one verification command chain.
No integration mega-step is needed beyond step 4-5 because `npm test` + the runner dry run
exercise all three consumers end to end.

## 10. Blast radius

Everything that reads the dispatch-role concept (grep evidence in the plan-95 step-1 report;
`role` hits in `web/index.html`, `src/context.mjs:158`, and `test/*` are the unrelated
**file-ref** role — `primary|dependency|related|reference` — and are untouched):

- `src/server.mjs:123-128` (directive text — modified), `:161,176` (zod `role` params — untouched).
- `src/db.mjs:44,149,201-203` (role columns/migration — untouched), `:225` region (+1 NEW helper).
- `scripts/runner.mjs:74-79,85,102-106,128,136-139` (roleLines + model flag — modified).
- `~/.claude/commands/plan.md` Roles section + work-loop step 4 (modified).
- `docs/ROLES.md` (modified). `~/.claude/agents/*.md` (12 files — untouched; remain the default roster).
- No MCP tool schemas, no DB schema, no template machinery (`save_as_template`/`instantiate_template`
  copy the abstract role name, which is precisely what stays stable).

## 11. Open risks

1. **Does the interactive Agent tool accept every alias a user might put in `model`?** Falsifiable:
   dispatch one step with `model:"haiku"` via the map and confirm the Agent tool accepts it
   (step 5's doc should record the accepted set). Mitigated by the ignore-with-note rule (§7).
2. **Is `process.cwd()` the working repo for runner invocations in practice?** Falsifiable: run
   `npm run orchestrate -- --plan <id>` from the plan-ledger repo against a step whose work targets
   another repo; if the repo-local layer is then wrong-rooted, promote the user-file `projects`
   section as the canonical project layer for headless runs (already supported; zero schema change).
