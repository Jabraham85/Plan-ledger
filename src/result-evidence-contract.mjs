import { isAbsolute } from 'node:path';
const required = (v, name) => { if (typeof v !== 'string' || !v.trim() || v.length > 4096) throw new Error('result_' + name + '_required'); return v; };
export function normalizeResultEvidenceContract(value) {
  if (!value || value.version !== 1 || value.kind !== 'sha256_fixture' || value.observability_policy !== 'supported_task_outputs_only'
    || value.raw_trace_required !== false || value.side_effect_assertion !== 'unseen_activity_not_verified') throw new Error('supported_result_contract_required');
  const path = required(value.input_path, 'input_path');
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('result_input_path_invalid');
  return { version: 1, kind: 'sha256_fixture', input_path: path, observability_policy: 'supported_task_outputs_only',
    raw_trace_required: false, side_effect_assertion: 'unseen_activity_not_verified' };
}
