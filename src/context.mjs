// context.mjs — assemble a paste-ready markdown "handoff" for a plan.
// Single source of truth for BOTH the web Copy-context button and the MCP
// get_context tool. Folds in the currently-enabled rules/tools so the pasted
// context reflects exactly what's toggled on right now.

import { homedir } from 'node:os';
import { join } from 'node:path';

// Repo root for the self-install snippet's absolute paths. Derived from the install
// convention (matches the DB-path default), env-overridable. NOTE: must NOT use
// import.meta.url — it's undefined inside the packaged SEA exe and crashes at load.
const REPO = process.env.PLAN_LEDGER_HOME || join(homedir(), 'Documents', 'plan-ledger');
const fwd = (p) => p.replace(/\\/g, '/');
const SERVER_PATH = fwd(join(REPO, 'src', 'server.mjs'));
const CMD_PATH = fwd(join(REPO, 'plugin', 'commands', 'plan.md'));

// The "make this live" header: tells the receiving workspace to USE the live
// plan-ledger tools (not just read the snapshot) and self-installs them if absent.
function usageBlock(planId) {
  return [
    '## ▶ Use this live (don\'t just read the snapshot below)',
    `This is **plan #${planId}** in plan-ledger — a live working-memory store, not a static doc.`,
    'If the `mcp__plan-ledger__*` tools are available here, PREFER them over the snapshot:',
    `- \`get_step(<id>)\` full step detail · \`recall("<query>")\` related history/lessons · \`next_step(${planId})\` work the next step · \`get_context(${planId})\` refresh this handoff · \`record_attempt\`/\`write_carry_forward\` as you work.`,
    '',
    '**If those tools are NOT available here, create the tool first** — register the server, then reload:',
    '```jsonc',
    '// add under "mcpServers" in your MCP config (project .mcp.json or ~/.claude.json)',
    `{ "plan-ledger": { "type": "stdio", "command": "node", "args": ["${SERVER_PATH}"] } }`,
    '```',
    `Optional ergonomic command: copy \`${CMD_PATH}\` → \`.claude/commands/plan.md\` to get \`/plan recall\`, \`/plan work\`, etc.`,
    '',
  ].join('\n');
}

const ICON = { done: '✅', in_progress: '▶', pending: '⬚', failed: '✗', blocked: '⏸', skipped: '⤼' };

// Render a queryGraph result as markdown bullets (node + its outbound edges).
function sliceMarkdown(r) {
  const byId = new Map(r.nodes.map((n) => [n.node_id, n]));
  return r.nodes.map((n) => {
    const outs = r.edges.filter((e) => e.src === n.node_id && byId.has(e.tgt)).slice(0, 4)
      .map((e) => `${e.relation}→${byId.get(e.tgt).label}`);
    const loc = n.source_file ? ` (${n.source_file}${n.source_location ? ':' + n.source_location : ''})` : '';
    return `- **${n.label}**${loc}${outs.length ? ' — ' + outs.join(', ') : ''}`;
  }).join('\n');
}

// The code slice for a step: keyword-ground the plan's graph on the step's title+tools.
export function groundSlice(store, planId, terms, budget = 8) {
  const r = store.queryGraph(planId, terms, budget);
  return r && r.nodes.length ? sliceMarkdown(r) : '';
}

export function buildRefsBlock(store, { plan_id, project_id } = {}) {
  const refs = store.listRefs({ enabled: true, plan_id, project_id });
  if (!refs.length) return '';
  const rules = refs.filter((r) => r.kind === 'rule');
  const tools = refs.filter((r) => r.kind === 'tool');
  const lines = [];
  if (rules.length) {
    lines.push('### Rules (active)');
    for (const r of rules) lines.push(`- **${r.name}**${r.body ? `: ${r.body}` : ''}${r.plan_id == null ? '' : ' _(this plan)_'}`);
  }
  if (tools.length) {
    lines.push('', '### Tools (active)');
    for (const t of tools) lines.push(`- **${t.name}**${t.body ? `: ${t.body}` : ''}${t.plan_id == null ? '' : ' _(this plan)_'}`);
  }
  return lines.join('\n');
}

// App/project-level setup prompt: drops a fresh workspace into the right project
// and fully equips it to use plan-ledger (live tools + self-install + the workflow).
// Works even with zero plans — it's an onboarding entry point, not a data dump.
export function buildProjectContext(store, projectId) {
  const proj = store.getProject(projectId);
  const plans = store.listPlans({ project_id: projectId });
  const out = [];
  out.push(`# plan-ledger — workspace setup for project "${proj.name}" (project #${proj.id})`);
  out.push('_Paste into any Claude Code workspace to equip it for this project. plan-ledger is a LIVE working-memory store — use its tools, don\'t just read this._');
  out.push('');
  out.push('## ▶ Get set up (do this first)');
  out.push(`1. **Scope to this project:** call \`set_current_project(${proj.id})\` so plans / recall / lessons stay within "${proj.name}".`);
  out.push('2. **Orient:** `project_brief()` for the current state, then `recall("<anything>")` to ask the project what\'s known/tried.');
  out.push('3. **Work:** `next_step(<plan_id>)` → do it → `record_attempt(...)` → `write_carry_forward(...)`. Slash commands: `/plan brief`, `/plan recall <q>`, `/plan work <id>`, `/plan new <goal>`.');
  out.push('');
  out.push('**If the `mcp__plan-ledger__*` tools are NOT available here, install first** — add to your MCP config and reload:');
  out.push('```jsonc');
  out.push('// under "mcpServers" (project .mcp.json or ~/.claude.json)');
  out.push(`{ "plan-ledger": { "type": "stdio", "command": "node", "args": ["${SERVER_PATH}"] } }`);
  out.push('```');
  out.push(`Optional ergonomic command: copy \`${CMD_PATH}\` → \`.claude/commands/plan.md\` for \`/plan\`.`);
  out.push('');
  out.push(`## Project: ${proj.name}`);
  if (proj.description) out.push(proj.description);
  out.push(`- ${plans.length} plan(s)${proj.plans_done ? `, ${proj.plans_done} done` : ''}.`);
  out.push('');
  const refs = buildRefsBlock(store, { project_id: projectId });
  if (refs) { out.push('## Active rules & tools (this project)'); out.push('_Apply the rules; the tools are what to use._', '', refs, ''); }
  out.push('## Plans in this project');
  if (plans.length) for (const p of plans) out.push(`- **#${p.id} ${p.title}** — ${p.status}, ${p.done}/${p.steps} steps${p.keywords.length ? ` · _${p.keywords.join(', ')}_` : ''}`);
  else out.push('_(none yet — create one with `/plan new <goal>` or `create_plan`)_');
  out.push('');
  out.push('## How to work here');
  out.push('- Work the **lowest uncompleted step**; read its failures + `get_lessons` BEFORE retrying anything.');
  out.push('- Pull narrow — `get_step` only the current step; `recall` for history. Keep your context small.');
  out.push('- Log every attempt (pass AND fail) and carry needed context forward; that\'s what makes the next session smart.');
  return out.join('\n');
}

export function buildPlanContext(store, planId) {
  const plan = store.openPlan(planId); // throws if missing
  const out = [];
  out.push(`# plan-ledger context — ${plan.title} (#${plan.id})`);
  out.push('_Paste into a Claude Code session to ground it in this plan. Generated from plan-ledger._');
  out.push('');
  out.push(usageBlock(plan.id));

  out.push('## Plan');
  out.push(`- **Status:** ${plan.status}    **Progress:** ${plan.steps.filter((s) => s.status === 'done').length}/${plan.steps.length} steps done`);
  if (plan.keywords.length) out.push(`- **Keywords:** ${plan.keywords.join(', ')}`);
  if (plan.summary) out.push('', plan.summary);
  out.push('');

  const refsBlock = buildRefsBlock(store, { plan_id: plan.id, project_id: plan.project_id });
  if (refsBlock) {
    out.push('## Active rules & tools');
    out.push('_Currently toggled ON in plan-ledger. Apply the rules; the tools are what to use._');
    out.push('', refsBlock, '');
  }

  const hasGraph = store.hasGraph(plan.id);
  if (hasGraph) {
    const st = store.graphStats(plan.id);
    out.push('## Code map');
    out.push(`_${st.nodes} nodes · ${st.edges} edges · ${st.communities} communities. Central concepts (god-nodes):_`);
    out.push('', store.godNodes(plan.id, 8).map((n) => `- **${n.label}** (deg ${n.degree}${n.source_file ? `, ${n.source_file}` : ''})`).join('\n'), '');
  }

  out.push('## Steps');
  for (const s of plan.steps) {
    const step = store.getStep(s.id);
    out.push(`### ${step.idx}. ${step.title}  ${ICON[step.status] || ''} ${step.status}`);
    if (step.context) out.push(`- **Context:** ${step.context}`);
    if (step.acceptance_criteria) out.push(`- **Acceptance:** ${step.acceptance_criteria}`);
    if (step.tools?.length) out.push(`- **Tools:** ${step.tools.join(', ')}`);
    if (step.carry_forward) out.push(`- **Carry-forward:** ${step.carry_forward}`);
    const fails = step.attempts.filter((a) => a.verdict !== 'pass');
    if (fails.length) {
      out.push('- **Failures to avoid:**');
      for (const a of fails) out.push(`  - tried: ${a.what_tried}${a.result ? ` → ${a.result}` : ''}`);
    }
    if (step.links?.length) {
      for (const l of step.links) out.push(`- **${l.relation}** → ${l.to_step_id ? `step #${l.to_step_id}` : `plan #${l.to_plan_id}`}${l.note ? ` (${l.note})` : ''}`);
    }
    if (step.file_refs?.length) {
      out.push('- **Cited files** (not read — `read_file_ref(<id>)` to expand only if this step needs it):');
      for (const f of step.file_refs) out.push(`  - [${f.role}] \`${f.path}\`${f.note ? ` — ${f.note}` : ''}  (id ${f.id})`);
    }
    if (hasGraph) {
      const slice = groundSlice(store, plan.id, `${step.title} ${(step.tools || []).join(' ')}`, 8);
      if (slice) { out.push('- **Relevant code:**'); out.push(slice.split('\n').map((l) => '  ' + l).join('\n')); }
    }
    out.push('');
  }

  out.push('## How to work this plan');
  out.push('- If the plan-ledger MCP tools are available, use them: `next_step` to get the lowest uncompleted step, `record_attempt` to log outcomes (always log failures), `write_carry_forward` for the next step.');
  out.push('- Work the **lowest uncompleted step** first. Read its failures-to-avoid before retrying anything.');
  out.push('- Keep context small: focus only on the current step.');
  return out.join('\n');
}
