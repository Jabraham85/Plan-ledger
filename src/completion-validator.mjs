// completion-validator.mjs — deterministic local validator for completion payload v2.
// No network/model/process calls; pure normalization + checks.

export const COMPLETION_PAYLOAD_VERSION = 2;

const OUTCOMES = new Set(['success', 'failed', 'partial', 'blocked', 'cancelled']);
const MAX_ARTIFACTS = 128;
const MAX_COMMANDS = 128;
const MAX_LIMITATIONS = 128;

const clamp = (value, max = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const asArray = (value) => (Array.isArray(value) ? value : null);

function pushError(errors, code, detail, field = '') {
  errors.push({ code, detail, field });
}

function parsePayload(payload) {
  if (payload == null || payload === '') return { ok: false, code: 'completion_json_missing', detail: 'completion payload is required' };
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? { ok: true, value: parsed }
        : { ok: false, code: 'completion_json_invalid', detail: 'completion payload must be a JSON object' };
    } catch (error) {
      return { ok: false, code: 'completion_json_invalid', detail: `completion payload is not valid JSON: ${error.message}` };
    }
  }
  if (typeof payload === 'object' && !Array.isArray(payload)) return { ok: true, value: payload };
  return { ok: false, code: 'completion_json_invalid', detail: 'completion payload must be an object or JSON string' };
}

export function validateCompletionPayload(payload, { claimed_pass = false } = {}) {
  const parsed = parsePayload(payload);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: [{ code: parsed.code, detail: parsed.detail, field: 'completion_payload' }],
      normalizedPayload: null,
    };
  }
  const raw = parsed.value;
  const errors = [];
  const contractVersion = raw.contract_version == null ? COMPLETION_PAYLOAD_VERSION : Number(raw.contract_version);
  if (!Number.isInteger(contractVersion) || contractVersion !== COMPLETION_PAYLOAD_VERSION) {
    pushError(errors, 'completion_contract_version_unsupported', `contract_version must equal ${COMPLETION_PAYLOAD_VERSION}`, 'contract_version');
  }

  const outcome = clamp(raw.outcome, 40).toLowerCase();
  if (!OUTCOMES.has(outcome)) {
    pushError(errors, 'completion_verdict_unsupported', 'outcome must be one of success|failed|partial|blocked|cancelled', 'outcome');
  }

  const artifactsInput = asArray(raw.artifacts);
  if (!artifactsInput) pushError(errors, 'completion_artifact_missing', 'artifacts must be an array', 'artifacts');
  const commandsInput = asArray(raw.commands);
  if (!commandsInput) pushError(errors, 'completion_json_invalid', 'commands must be an array', 'commands');
  const limitationsInput = asArray(raw.limitations);
  if (!limitationsInput) pushError(errors, 'completion_json_invalid', 'limitations must be an array', 'limitations');

  const artifacts = (artifactsInput ?? []).slice(0, MAX_ARTIFACTS).map((item, index) => {
    if (typeof item === 'string') {
      const path = clamp(item, 500);
      if (!path) pushError(errors, 'completion_artifact_missing', 'artifact path cannot be empty', `artifacts[${index}]`);
      return { path, kind: 'file', note: '' };
    }
    const path = clamp(item?.path, 500);
    const kind = clamp(item?.kind, 64) || 'file';
    const note = clamp(item?.note, 280);
    if (!path) pushError(errors, 'completion_artifact_missing', 'artifact.path is required', `artifacts[${index}].path`);
    return { path, kind, note };
  }).filter((item) => item.path);

  const commands = (commandsInput ?? []).slice(0, MAX_COMMANDS).map((item, index) => {
    const command = clamp(item?.command, 400);
    const exitCode = Number(item?.exit_code);
    const output = clamp(item?.output ?? item?.output_snippet, 600);
    const outputRedacted = item?.output_redacted === true;
    if (!command) pushError(errors, 'completion_json_invalid', 'command text is required', `commands[${index}].command`);
    if (!Number.isInteger(exitCode)) pushError(errors, 'completion_json_invalid', 'exit_code must be an integer', `commands[${index}].exit_code`);
    if (!output && !outputRedacted) pushError(errors, 'completion_output_missing', 'command requires non-empty output or output_redacted=true', `commands[${index}]`);
    return {
      command,
      exit_code: Number.isInteger(exitCode) ? exitCode : null,
      output,
      output_redacted: outputRedacted,
    };
  }).filter((item) => item.command);

  const limitations = (limitationsInput ?? []).slice(0, MAX_LIMITATIONS).map((item) => clamp(item, 400)).filter(Boolean);

  if (claimed_pass) {
    if (outcome !== 'success') {
      pushError(errors, 'completion_verdict_unsupported', 'pass attempts require completion outcome "success"', 'outcome');
    }
    if (!artifacts.length) {
      pushError(errors, 'completion_artifact_missing', 'pass attempts require at least one artifact', 'artifacts');
    }
    if (!commands.length) {
      pushError(errors, 'completion_pass_unsupported_no_evidence', 'pass attempts require at least one command entry', 'commands');
    }
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      if (cmd.exit_code != null && cmd.exit_code !== 0) {
        pushError(errors, 'completion_command_failed', `command "${cmd.command}" exited with ${cmd.exit_code}`, `commands[${i}].exit_code`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    normalizedPayload: {
      contract_version: COMPLETION_PAYLOAD_VERSION,
      outcome,
      artifacts,
      commands,
      limitations,
    },
  };
}
