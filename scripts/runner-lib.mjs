// runner-lib.mjs — pure, side-effect-free helpers extracted from runner.mjs so
// they're unit-testable without triggering the script's top-level CLI parsing /
// process.exit / DB-open side effects (runner.mjs runs immediately on import).
// Nothing here touches argv, spawns `claude`, or opens a Store.

import { spawnSync } from 'node:child_process';

// The inject-mode result contract: the agent's final line must be
// "VERDICT: pass|fail|partial — <what_tried>". No marker → FAIL (an agent that
// didn't follow the contract can't be trusted to have finished the step).
export function parseVerdict(text) {
  const lines = String(text || '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*VERDICT:\s*(pass|fail|partial)\s*(?:[—–-]+\s*(.*))?$/i.exec(lines[i]);
    if (m) return { verdict: m[1].toLowerCase(), what_tried: (m[2] || '').trim() || null };
  }
  return { verdict: 'fail', what_tried: null };
}

// VERIFY: <command> — optional first-line convention in step.context, same shape
// as the RAG: line (docs/RAG.md §10): `/^RAG:\s*.../m`. Declares an objective,
// post-hoc check the runner enforces AFTER the agent exits, in both MCP and
// inject modes. Left in step.context verbatim (never stripped) — same "travels
// inside context, forwarded as-is" design as RAG:.
export function parseVerify(context) {
  const m = /^VERIFY:\s*(.+)$/m.exec(String(context || ''));
  if (!m) return null;
  const cmd = m[1].trim();
  return cmd || null;
}

// Run a step's VERIFY command. Guard (per the step brief): VERIFY commands come
// from the step author — trusted user/orchestrator input, the same trust class
// as step context — so shell:true is deliberate (lets `&&`, pipes, etc. work in
// the command string) and not treated as a shell-injection boundary here.
export function runVerify(cmd, { cwd = process.cwd(), timeoutMs = 10 * 60 * 1000 } = {}) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs });
  const combined = `${r.stdout || ''}${r.stderr ? '\n' + r.stderr : ''}`.trim();
  return { ok: r.status === 0, code: r.status, tail: combined.slice(-500) };
}

// The gate: an agent-claimed "pass" with a failing VERIFY is downgraded to
// "fail" and the command's output tail (~500 chars) is appended to resultText.
// No-op (verdict/resultText unchanged) when there's no VERIFY command, or the
// claimed verdict wasn't "pass" in the first place — a claimed fail/partial is
// already not a pass, nothing to override.
export function applyVerifyGate(verdict, resultText, verifyCmd, opts = {}) {
  if (!verifyCmd || verdict !== 'pass') return { verdict, resultText, verified: null };
  const v = runVerify(verifyCmd, opts);
  if (v.ok) return { verdict, resultText: `${resultText} | VERIFY ok: \`${verifyCmd}\``, verified: true };
  return {
    verdict: 'fail',
    resultText: `${resultText} | VERIFY FAILED (\`${verifyCmd}\` exit ${v.code}): ${v.tail}`,
    verified: false,
  };
}

// Per-attempt usage line, persisted into the attempt's `result` field (in
// addition to the runner's existing end-of-run console summary).
export function formatUsageLine({ tin = 0, tout = 0, cost = 0, turns = 0, model } = {}) {
  return `usage: in=${tin} out=${tout} cost=$${Number(cost || 0).toFixed(4)} turns=${turns} model=${model || 'default'}`;
}

// MCP mode has no hook into record_attempt (it runs inside the agent, via MCP
// tools) — so usage is stitched on after the fact: if a NEW attempt landed on
// this step while the agent ran, append the usage line to ITS result column
// directly (db is the Store's public DatabaseSync handle — same direct-access
// pattern test/smoke.mjs already uses for schema checks). If no new attempt
// appeared (agent errored before ever calling record_attempt), there's nothing
// to append to — skip and let the caller log a console note.
export function appendUsageToLatestAttempt(db, stepId, sinceAttemptId, usageLine) {
  const row = db.prepare('SELECT id, result FROM attempts WHERE step_id=? ORDER BY id DESC LIMIT 1').get(stepId);
  if (!row || row.id <= sinceAttemptId) return { appended: false };
  db.prepare('UPDATE attempts SET result=? WHERE id=?').run(`${row.result}\n${usageLine}`, row.id);
  return { appended: true, attemptId: row.id };
}
