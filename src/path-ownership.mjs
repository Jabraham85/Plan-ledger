// path-ownership.mjs — deterministic repo-relative path ownership for parallel dispatch.
// Steps declare ownership via file_refs (write/edit roles) and OWNED_PATH:/OWNED_GLOB: hints.

const WRITE_ROLES = new Set(['write', 'edit', 'modify', 'owner', 'output']);

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

export function normalizeRepoPath(raw) {
  let p = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!p) return '';
  if (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function normalizePrefix(raw) {
  const p = normalizeRepoPath(raw);
  if (!p) return '';
  return p.endsWith('/**') ? p.slice(0, -3) : p;
}

export function parseStepOwnership(step) {
  const exact = new Set();
  const prefixes = new Set();
  const merged = `${step?.context || ''}\n${step?.acceptance_criteria || ''}`;
  for (const line of parseLineList('OWNED_PATH', merged)) {
    const p = normalizeRepoPath(line);
    if (p) exact.add(p);
  }
  for (const line of parseLineList('OWNED_GLOB', merged)) {
    const p = normalizePrefix(line);
    if (p) prefixes.add(p);
  }
  for (const ref of step?.file_refs || []) {
    const role = String(ref?.role ?? '').trim().toLowerCase();
    const p = normalizeRepoPath(ref?.path);
    if (!p) continue;
    if (WRITE_ROLES.has(role)) exact.add(p);
  }
  return { exact: [...exact], prefixes: [...prefixes] };
}

function pathUnderPrefix(path, prefix) {
  if (!prefix) return false;
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function ownershipConflicts(a, b) {
  if (!a || !b) return false;
  for (const ea of a.exact || []) {
    for (const eb of b.exact || []) {
      if (ea === eb) return true;
    }
    for (const pb of b.prefixes || []) {
      if (pathUnderPrefix(ea, pb)) return true;
    }
  }
  for (const eb of b.exact || []) {
    for (const pa of a.prefixes || []) {
      if (pathUnderPrefix(eb, pa)) return true;
    }
  }
  for (const pa of a.prefixes || []) {
    for (const pb of b.prefixes || []) {
      if (pa === pb || pathUnderPrefix(pa, pb) || pathUnderPrefix(pb, pa)) return true;
    }
  }
  return false;
}

export class PathLockRegistry {
  constructor() {
    this.active = new Map(); // stepId -> ownership
  }

  holds(stepId) {
    return this.active.get(stepId) ?? null;
  }

  conflictsWithActive(ownership) {
    for (const [, held] of this.active) {
      if (ownershipConflicts(ownership, held)) return true;
    }
    return false;
  }

  acquire(stepId, ownership) {
    this.active.set(stepId, ownership);
  }

  release(stepId) {
    this.active.delete(stepId);
  }

  snapshot() {
    return new Map(this.active);
  }
}

export function selectNonConflictingSteps(readySteps, lockRegistry, { max = Infinity } = {}) {
  const picked = [];
  const staged = [];
  for (const step of readySteps || []) {
    const ownership = parseStepOwnership(step);
    const candidate = { step, ownership };
    const conflictsHeld = lockRegistry.conflictsWithActive(ownership);
    const conflictsStaged = staged.some((s) => ownershipConflicts(ownership, s.ownership));
    if (conflictsHeld || conflictsStaged) continue;
    staged.push(candidate);
    picked.push(step);
    if (picked.length >= max) break;
  }
  return picked;
}
