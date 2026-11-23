// Supported task-output evidence. No remote calls, raw/private logs or acceptance grants.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { normalizeResultEvidenceContract } from './result-evidence-contract.mjs';
import { readCloudDispatch } from './cloud-dispatch.mjs';

export const RESULT_CRITERIA = ['observable_artifact_result', 'observed_task_identity', 'declared_scope_and_visibility_limits'];
export const RESULT_VISIBILITY = Object.freeze({ result_match: 'independently_verified', task_identity_and_completion: 'trusted_parent_platform_observation',
      allowed_scope: 'declared_authorization_and_packet_constraints', raw_worker_tool_trace: 'not_observed',
      unseen_side_effects: 'not_verified', proof_of_worker_read_mechanism: 'not_established_by_result_match' });
export const CAPTURE_LIMITATIONS = Object.freeze([
      'Result bytes/hash/marker match independently read input; this does not prove how the worker produced its result.',
      'Supported parent task outputs provide identity/status/result data, not raw worker execution calls/results.',
      'Allowed scope is recorded. Absence of all filesystem, network or other side effects is not asserted.',
      'Parent authenticates platform observation references. Local receipt hashes and caller fields are not a machine security boundary.',
      'This capture is evidence submission preparation; independent orchestrator acceptance remains required.',
    ]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = data => hash(JSON.stringify(data));
const required = (v, name) => {
  if (typeof v !== 'string' || !v.trim() || v.length > 4096) throw new Error('result_' + name + '_required');
  return v;
};
const inside = (root, path) => {
  const base = realpathSync.native(root), actual = realpathSync.native(path), rel = relative(base, actual);
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('result_path_outside_workspace');
  return actual;
};
function verifyInputs(store, args) {
  const dispatch = readCloudDispatch(store, { request_id: args.request_id });
  if (dispatch.phase !== 'completed' || dispatch.remote_outcome !== 'completed') throw new Error('result_remote_completion_unconfirmed');
  const contract = normalizeResultEvidenceContract(dispatch.packet.result_evidence_contract);
  const step = store.getStep(dispatch.step_id);
  if (step.context !== dispatch.packet.step.context || JSON.stringify(step.acceptance_contract) !== JSON.stringify(dispatch.packet.step.acceptance_contract)) throw new Error('result_packet_stale');
  if (step.acceptance_epoch !== dispatch.work_epoch) throw new Error('result_work_generation_stale');
  if (!RESULT_CRITERIA.every(id => step.acceptance_contract?.criteria.some(c => c.id === id && c.mandatory))
    || step.acceptance_contract.criteria.some(c => c.mandatory && !RESULT_CRITERIA.includes(c.id))) throw new Error('supported_result_criteria_required');
  const { digest: packetDigest, ...packetBody } = dispatch.packet;
  if (digest(packetBody) !== packetDigest) throw new Error('result_packet_digest_invalid');
  if (!dispatch.identity.thread_id || !dispatch.identity.turn_id || !dispatch.identity.source_ref || dispatch.identity.verification !== 'trusted-parent-platform-observation') throw new Error('result_task_identity_unobserved');
  if (args.visibility?.mode !== 'task_outputs_only' || args.visibility.raw_worker_trace_available !== false) throw new Error('result_visibility_limits_required');
  const result = args.result_data;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('result_data_invalid');
  required(args.result_source_ref, 'source_ref'); required(args.result_message_id, 'message_id');
  if (!dispatch.packet.scope.owned_paths.includes(contract.input_path) || !dispatch.packet.authorization?.granted_actions?.length
    || !dispatch.packet.scope.excluded_actions?.length) throw new Error('result_declared_scope_missing');
  const root = store.getProjectRoot(dispatch.packet.project_id);
  if (root !== dispatch.packet.scope.workspace) throw new Error('result_workspace_stale');
  const input = inside(root, resolve(root, contract.input_path));
  if (!statSync(input).isFile() || statSync(input).size > 10 * 1024 * 1024) throw new Error('result_input_invalid');
  const bytes = readFileSync(input), expected = { sha256: hash(bytes), byte_count: bytes.length,
    content_marker: bytes.toString('utf8').split(/\r?\n/).find(line => line.startsWith('marker='))?.slice(7) };
  if (!expected.content_marker) throw new Error('result_fixture_marker_missing');
  if (inside(root, resolve(root, required(result.source_path, 'source_path'))) !== input
    || String(result.sha256 || '').toLowerCase() !== expected.sha256 || result.byte_count !== expected.byte_count
    || result.content_marker !== expected.content_marker) throw new Error('result_independent_comparison_failed');
  const reported = { source_path: result.source_path, sha256: String(result.sha256).toLowerCase(),
    byte_count: result.byte_count, content_marker: result.content_marker,
    limitations: Array.isArray(result.limitations) ? result.limitations.filter(x => typeof x === 'string').map(x => x.slice(0, 4096)).slice(0, 32) : [] };
  return { dispatch, contract, root, expected, reported };
}

export function captureCloudResultEvidence(store, args) {
  const { dispatch, contract, root, expected, reported } = verifyInputs(store, args);
  const evidenceDir = resolve(root, 'evidence');
  if (!existsSync(evidenceDir)) mkdirSync(evidenceDir);
  inside(root, evidenceDir);
  const relativePath = 'evidence/cloud-result-' + dispatch.request_id + '.json';
  const destination = resolve(root, relativePath);
  const capture = {
    receipt_version: 1, kind: 'supported_task_output_result', request_id: dispatch.request_id,
    work_epoch: dispatch.work_epoch, packet_id: dispatch.packet.packet_id, packet_digest: dispatch.packet.digest,
    result_contract: contract, result_source_ref: args.result_source_ref, result_message_id: args.result_message_id,
    result_data: reported, independently_compared_file_facts: expected, observed_task: dispatch.identity,
    parent_observed_status: 'completed', declared_scope: dispatch.packet.scope,
    authorization: dispatch.packet.authorization,
    visibility: { ...RESULT_VISIBILITY },
    limitations: [...CAPTURE_LIMITATIONS],
  };
  let reused = false;
  if (existsSync(destination)) {
    inside(root, destination);
    const old = JSON.parse(readFileSync(destination, 'utf8'));
    if (digest(old) !== digest(capture)) throw new Error('result_capture_already_exists_with_different_evidence');
    reused = true;
  } else writeFileSync(destination, JSON.stringify(capture, null, 2), { flag: 'wx' });
  const sha256 = hash(readFileSync(destination));
  if (!reused) store.addNote(dispatch.step_id, { author: 'parent-result-capture', body: JSON.stringify({
    event: 'supported_result_evidence_captured', request_id: dispatch.request_id, result_source_ref: args.result_source_ref,
    receipt: { path: relativePath, sha256 }, criterion_acceptance: false, visibility: capture.visibility,
  }) });
  const completion_payload = { outcome: 'success', artifacts: [relativePath],
    commands: [{ command: 'Parent independent local file comparison: SHA256/byte count/marker', exit_code: 0,
      output: JSON.stringify(expected), classification: 'local_result_verification_not_worker_execution_trace' }],
    limitations: capture.limitations,
    criteria: RESULT_CRITERIA.map(id => ({ id, status: 'verified', reviewer: 'capture-checks-not-acceptance', evidence: [{ path: relativePath, sha256 }] })) };
  return { request_id: dispatch.request_id, reused, receipt: { path: relativePath, sha256 },
    evidence_status: 'captured_awaiting_submission_and_independent_review', verified_facts: expected,
    visibility: capture.visibility, completion_payload, criterion_acceptance: false };
}

// Independent review helper rechecks stored receipt against current input/identity/packet.
// Calling it never accepts the step and never trusts a worker's reviewer name.
export function verifyCloudResultEvidence(store, { request_id, receipt_path, receipt_sha256 }) {
  const dispatch = readCloudDispatch(store, { request_id });
  const root = store.getProjectRoot(dispatch.packet.project_id);
  const actualPath = inside(root, resolve(root, required(receipt_path, 'receipt_path')));
  if (statSync(actualPath).size > 1024 * 1024) throw new Error('result_receipt_too_large');
  const bytes = readFileSync(actualPath);
  if (hash(bytes) !== receipt_sha256) throw new Error('result_receipt_hash_mismatch');
  const receipt = JSON.parse(bytes.toString('utf8'));
  const checked = verifyInputs(store, { request_id, result_data: receipt.result_data, result_source_ref: receipt.result_source_ref,
    result_message_id: receipt.result_message_id, visibility: { mode: 'task_outputs_only', raw_worker_trace_available: false } });
  // Submission advances the work generation; packet/result identity stays fixed.
  if (receipt.kind !== 'supported_task_output_result' || receipt.request_id !== request_id || receipt.packet_digest !== checked.dispatch.packet.digest
    || digest(receipt.observed_task) !== digest(checked.dispatch.identity) || digest(receipt.declared_scope) !== digest(checked.dispatch.packet.scope)
    || receipt.visibility?.raw_worker_tool_trace !== 'not_observed' || receipt.visibility?.unseen_side_effects !== 'not_verified'
    || receipt.visibility?.proof_of_worker_read_mechanism !== 'not_established_by_result_match'
    || digest(receipt.independently_compared_file_facts) !== digest(checked.expected)
    || digest(receipt.authorization) !== digest(checked.dispatch.packet.authorization)
    || digest(receipt.result_contract) !== digest(checked.contract)
    || receipt.parent_observed_status !== 'completed'
    || digest(receipt.visibility) !== digest(RESULT_VISIBILITY)
    || digest(receipt.limitations) !== digest(CAPTURE_LIMITATIONS)) throw new Error('result_receipt_binding_invalid');
  return { ok: true, independently_compared_file_facts: checked.expected, task_identity: checked.dispatch.identity,
    visibility: receipt.visibility, limitations: receipt.limitations, criterion_acceptance: false };
}
