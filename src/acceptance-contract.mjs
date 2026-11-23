// Opt-in criterion contracts. Legacy steps retain their original evidence semantics.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

export function normalizeAcceptanceContract(value) {
  if (value == null || value === '') return null;
  const c = typeof value === 'string' ? JSON.parse(value) : value;
  if (!c || c.version !== 1 || !Array.isArray(c.criteria) || !c.criteria.length || c.criteria.length > 128) throw new Error('acceptance_contract_invalid');
  const ids = new Set();
  const criteria = c.criteria.map(x => {
    if (!x || !x.id || !x.description || ids.has(x.id)) throw new Error('acceptance_contract_invalid: unique id and description required');
    ids.add(x.id);
    return { id: String(x.id), description: String(x.description), mandatory: x.mandatory !== false };
  });
  return { version: 1, revision: Number.isInteger(c.revision) && c.revision > 0 ? c.revision : 1, criteria };
}

export function localEvidenceChecker(root) {
  return evidence => {
    if (!root) return 'evidence_root_missing';
    try {
      const base = realpathSync(root), path = realpathSync(resolve(base, evidence.path || ''));
      const rel = relative(base, path);
      if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) return 'evidence_outside_root';
      if (statSync(path).size > 10 * 1024 * 1024) return 'evidence_too_large';
      if (!statSync(path).isFile()) return 'evidence_not_file';
      if (!/^[a-f0-9]{64}$/i.test(evidence.sha256 || '')) return 'evidence_hash_missing';
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== evidence.sha256.toLowerCase()) return 'evidence_hash_mismatch';
      return null;
    } catch { return 'evidence_file_missing'; }
  };
}

export function validateCriterionEvidence(contract, reports, checkEvidence = () => 'evidence_not_checked') {
  const c = normalizeAcceptanceContract(contract);
  if (!c) return [];
  const errors = [];
  const rows = Array.isArray(reports) ? reports : [];
  const add = (code, id) => errors.push({ code, field: 'criteria', detail: id });
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string') { add('criterion_invalid', ''); continue; }
    if (seen.has(row.id)) add('criterion_duplicate', row.id);
    seen.add(row.id);
    if (!c.criteria.some(x => x.id === row.id)) add('criterion_unknown', row.id);
  }
  for (const item of c.criteria) {
    const r = rows.find(x => x?.id === item.id);
    if (!r || r.status !== 'verified') {
      if (item.mandatory) add('criterion_unverified', item.id);
      continue;
    }
    // Report attribution only; Store's separate orchestrator decision grants acceptance.
    if (!String(r.reviewer || '').trim()) add('criterion_review_missing', item.id);
    if (!Array.isArray(r.evidence) || !r.evidence.length) add('criterion_evidence_missing', item.id);
    for (const evidence of Array.isArray(r.evidence) ? r.evidence : []) {
      const problem = !evidence || typeof evidence.path !== 'string' ? 'criterion_evidence_invalid' : checkEvidence(evidence);
      if (problem) add(problem, item.id);
    }
  }
  return errors;
}
