// execution-governance.mjs — reusable dispatch governance helpers.
// Keeps preflight/evidence/retry/atomic logic outside runner wiring so tests can
// validate behavior deterministically with fake processes/clocks.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listCursorModels } from '../src/roles.mjs';
import { validateCompletionPayload, COMPLETION_PAYLOAD_VERSION } from '../src/completion-validator.mjs';
import { runVerify } from './runner-lib.mjs';

export const COMPLETION_CONTRACT_VERSION = 1;
export { validateCompletionPayload, COMPLETION_PAYLOAD_VERSION };

const TRANSIENT_RE = /\b(timeout|timed out|temporar(?:y|ily)|rate.?limit|429|econnreset|eai_again|enotfound|network)\b/i;

const normalizeText = (value, max = 220) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const boundedArray = (value, max = 24) => Array.isArray(value) ? value.slice(0, max) : [];

function parseLineList(prefix, text) {
  const out = [];
  const re = new RegExp(`^${prefix}:\\s*(.+)$`, 'gmi');
  let m;
  while ((m = re.exec(String(text || '')))) {
    const line = m[1].trim();
    if (line) out.push(line);
  }
  return out;
}

export function parseGovernanceHints({ context = '', acceptance = '' } = {}) {
  const merged = `${context || ''}\n${acceptance || ''}`;
  const required_paths = parseLineList('REQUIRES_PATH', merged);
  const required_clients = parseLineList('REQUIRES_CLIENT', merged);
  const required_artifacts = parseLineList('REQUIRED_ARTIFACT', merged)
    .flatMap((line) => line.split(',').map((part) => part.trim()).filter(Boolean));
  const declared_verify = parseLineList('VERIFY', merged);
  const declared_ports = parseLineList('PORT', merged)
    .map((line) => Number(line))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  const declared_server = parseLineList('SERVER', merged);
  const declared_browser = parseLineList('BROWSER', merged);
  return {
    required_paths: [...new Set(required_paths)],
    required_clients: [...new Set(required_clients)],
    required_artifacts: [...new Set(required_artifacts)],
    declared_verify: [...new Set(declared_verify)],
    declared_ports: [...new Set(declared_ports)],
    declared_server: [...new Set(declared_server)],
    declared_browser: [...new Set(declared_browser)],
  };
}

export async function runDispatchPreflight({
  cwd = process.cwd(),
  requested_model = '',
  context = '',
  acceptance = '',
  model_catalog = null,
  path_exists = existsSync,
  check_port = async () => true,
} = {}) {
  const hints = parseGovernanceHints({ context, acceptance });
  const checks = [];
  const fail = (name, detail) => checks.push({ name, ok: false, detail });
  const pass = (name, detail) => checks.push({ name, ok: true, detail });

  const repoGit = path_exists(join(cwd, '.git'));
  if (repoGit) pass('workspace_repo', 'git repo detected');
  else fail('workspace_repo', 'missing .git marker in workspace');

  const models = model_catalog || listCursorModels();
  if (!requested_model) pass('assigned_model', 'no explicit model pinned');
  else if ((models.models || []).includes(requested_model)) pass('assigned_model', `model available: ${requested_model}`);
  else fail('assigned_model', `model unavailable: ${requested_model}`);

  for (const rel of hints.required_paths) {
    const abs = resolve(cwd, rel);
    if (path_exists(abs)) pass('required_path', `${rel} exists`);
    else fail('required_path', `${rel} missing`);
  }
  for (const rel of hints.required_clients) {
    const abs = resolve(cwd, rel);
    if (path_exists(abs)) pass('required_client', `${rel} exists`);
    else fail('required_client', `${rel} missing`);
  }
  if (hints.declared_verify.some((cmd) => /\b(npm|pnpm|yarn)\b/i.test(cmd))) {
    if (path_exists(join(cwd, 'package.json'))) pass('verify_dependency', 'package.json present for JS verify command');
    else fail('verify_dependency', 'verify command implies node project but package.json missing');
  }
  for (const p of hints.declared_ports) {
    // Declared ports are optional readiness declarations in step context. If they
    // exist, they are a hard preflight gate before dispatch.
    const open = await check_port(p);
    if (open) pass('declared_port', `port ${p} ready`);
    else fail('declared_port', `port ${p} not ready`);
  }
  if (hints.declared_server.length) pass('declared_server', hints.declared_server.join(' | '));
  if (hints.declared_browser.length) pass('declared_browser', hints.declared_browser.join(' | '));

  return {
    ok: checks.every((c) => c.ok),
    checks,
    hints,
    summary: checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ') || 'preflight ok',
  };
}

export function parseCompletionContract(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('COMPLETION_JSON:')) continue;
    const body = line.slice('COMPLETION_JSON:'.length).trim();
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      const verdict = ['pass', 'fail', 'partial', 'blocked'].includes(parsed.verdict) ? parsed.verdict : 'fail';
      const artifacts = boundedArray(parsed.artifacts, 64).map((artifact) => {
        if (typeof artifact === 'string') return { path: artifact, kind: 'file' };
        return {
          path: String(artifact?.path ?? '').trim(),
          kind: String(artifact?.kind ?? 'file').trim() || 'file',
          note: normalizeText(artifact?.note ?? '', 140),
        };
      }).filter((artifact) => artifact.path);
      const commands = boundedArray(parsed.commands, 48).map((cmd) => ({
        command: normalizeText(cmd?.command ?? '', 220),
        exit_code: Number.isInteger(cmd?.exit_code) ? cmd.exit_code : null,
      })).filter((cmd) => cmd.command);
      return {
        ok: true,
        contract: {
          contract_version: Number(parsed.contract_version || COMPLETION_CONTRACT_VERSION),
          verdict,
          summary: normalizeText(parsed.summary ?? '', 260),
          outputs: boundedArray(parsed.outputs, 40).map((x) => normalizeText(x, 220)).filter(Boolean),
          artifacts,
          artifact_count: Number.isInteger(parsed.artifact_count) ? parsed.artifact_count : artifacts.length,
          commands,
          unresolved_gaps: boundedArray(parsed.unresolved_gaps, 24).map((x) => normalizeText(x, 200)).filter(Boolean),
          session_id: normalizeText(parsed.session_id ?? '', 160),
        },
      };
    } catch (e) {
      return { ok: false, reason: `invalid completion JSON: ${e.message}` };
    }
  }
  return { ok: false, reason: 'missing COMPLETION_JSON final line' };
}

export function evaluateCompletionContract({
  completion_parse,
  required_artifacts = [],
  verify_commands = [],
  cwd = process.cwd(),
} = {}) {
  const checked_artifacts = [];
  const checked_commands = [];
  let unsupported_claim = '';

  if (!completion_parse?.ok) {
    return {
      verdict: 'fail',
      noncompliant: true,
      summary: completion_parse?.reason || 'missing completion contract',
      checked_artifacts,
      checked_commands,
      unresolved_gaps: [],
      artifact_count: 0,
      file_count: 0,
    };
  }
  const c = completion_parse.contract;
  const required = [...new Set([...(required_artifacts || []), ...c.artifacts.map((a) => a.path)])];
  for (const rel of required) {
    const abs = resolve(cwd, rel);
    checked_artifacts.push({ path: rel, exists: existsSync(abs) });
  }
  for (const vc of verify_commands) {
    const run = runVerify(vc, { cwd });
    checked_commands.push({ command: vc, exit_code: run.code, ok: run.ok, tail: normalizeText(run.tail, 300) });
  }
  for (const cmd of c.commands) checked_commands.push({ command: cmd.command, exit_code: cmd.exit_code, ok: cmd.exit_code === 0, tail: '' });

  const missingArtifacts = checked_artifacts.filter((x) => !x.exists);
  const failingVerify = checked_commands.filter((x) => x.exit_code != null && !x.ok);
  const supportedPass = checked_artifacts.some((x) => x.exists) || checked_commands.some((x) => x.ok);
  if (c.verdict === 'pass' && !supportedPass) unsupported_claim = 'pass claim has no verifiable artifacts or successful commands';

  let verdict = c.verdict;
  if (verdict === 'pass' && (missingArtifacts.length || failingVerify.length || unsupported_claim)) verdict = 'fail';
  const summary = [
    c.summary || `agent reported ${c.verdict}`,
    missingArtifacts.length ? `missing artifacts: ${missingArtifacts.map((x) => x.path).join(', ')}` : '',
    failingVerify.length ? `failing commands: ${failingVerify.map((x) => `${x.command} (exit ${x.exit_code}) ${x.tail || ''}`.trim()).join(', ')}` : '',
    unsupported_claim ? `unsupported claim: ${unsupported_claim}` : '',
  ].filter(Boolean).join(' | ');

  return {
    verdict,
    noncompliant: false,
    summary,
    checked_artifacts,
    checked_commands,
    unresolved_gaps: c.unresolved_gaps,
    artifact_count: checked_artifacts.filter((x) => x.exists).length,
    file_count: checked_artifacts.filter((x) => x.exists).length,
    session_id: c.session_id || '',
  };
}

export function buildCompletionPayloadV2({
  evaluated,
  outcome = null,
  limitations = [],
} = {}) {
  const artifacts = (evaluated?.checked_artifacts || [])
    .filter((a) => a.exists)
    .map((a) => ({ path: a.path, kind: 'file', note: '' }));
  const commands = (evaluated?.checked_commands || []).map((c) => {
    const tail = normalizeText(c.tail || '', 600);
    return {
      command: c.command,
      exit_code: Number.isInteger(c.exit_code) ? c.exit_code : (c.ok ? 0 : 1),
      output: tail,
      output_redacted: !tail,
    };
  }).filter((c) => c.command);
  const gaps = [...new Set(evaluated?.unresolved_gaps || [])].map((g) => normalizeText(g, 400)).filter(Boolean);
  const resolvedOutcome = outcome
    || (evaluated?.verdict === 'pass' ? 'success'
      : evaluated?.verdict === 'blocked' ? 'blocked'
      : evaluated?.verdict === 'partial' ? 'partial'
      : 'failed');
  const payload = {
    contract_version: 2,
    outcome: resolvedOutcome,
    artifacts,
    commands,
    limitations: [...new Set(limitations)].map((l) => normalizeText(l, 400)).filter(Boolean),
  };
  if (gaps.length) payload.unresolved_gaps = gaps;
  return payload;
}

export function detectNoncomplianceEscalation({ attempts = [], nextNoncompliant = false } = {}) {
  if (!nextNoncompliant) return { escalate: false, prior_noncompliance: 0 };
  const prior = attempts.filter((a) => /\[governance:noncompliance\]/i.test(String(a.what_tried || ''))).length;
  return {
    escalate: prior >= 1,
    prior_noncompliance: prior,
    recommendation: prior >= 1
      ? 'Repeated completion-contract noncompliance; reassign to a different role/agent instead of another resume.'
      : '',
  };
}

export async function withBoundedRetry(operation, {
  retries = 2,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  isTransient = (e) => TRANSIENT_RE.test(String(e?.message || e || '')),
  onRetry = () => {},
  base_delay_ms = 100,
  max_delay_ms = 1500,
} = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await operation({ attempt });
    } catch (e) {
      if (attempt >= retries || !isTransient(e)) throw e;
      attempt++;
      const wait = Math.min(max_delay_ms, base_delay_ms * 2 ** (attempt - 1));
      onRetry({ attempt, wait, error: e });
      await sleep(wait);
    }
  }
}

export function atomicOutcome(results = [], { label = 'operation' } = {}) {
  const okCount = results.filter((x) => !!x?.ok).length;
  if (okCount === 0 || okCount === results.length) return { ok: okCount === results.length, label };
  throw new Error(`${label} produced a partial outcome (${okCount}/${results.length})`);
}

export async function runWithHeartbeat(work, {
  interval_ms = 60_000,
  on_heartbeat = () => {},
  now = () => Date.now(),
  set_interval = setInterval,
  clear_interval = clearInterval,
} = {}) {
  const started = now();
  const timer = set_interval(() => {
    on_heartbeat({ elapsed_ms: now() - started });
  }, Math.max(1, Number(interval_ms) || 60_000));
  try {
    return await work();
  } finally {
    clear_interval(timer);
  }
}

export function safeActivitySummary(value, max = 220) {
  const text = normalizeText(value, max);
  if (!text) return '';
  // Guardrail: never persist hidden "thinking" blobs in activity summaries.
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '[redacted]')
    .replace(/\b(chain[- ]of[- ]thought|internal reasoning)\b/gi, '[redacted]');
}
