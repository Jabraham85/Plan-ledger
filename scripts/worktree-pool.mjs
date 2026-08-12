// worktree-pool.mjs — branch-backed git worktrees with serialized integration.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { createWorktreeIntegrator, IntegrationError } from './worktree-integrator.mjs';

function safeName(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64);
}

function pathUnderBase(childPath, basePath) {
  try {
    const child = realpathSync.native(childPath);
    const base = realpathSync.native(basePath);
    return child === base || child.startsWith(`${base}${sep}`);
  } catch {
    const child = normalize(childPath);
    const base = normalize(basePath);
    return child === base || child.startsWith(`${base}${sep}`);
  }
}

export { IntegrationError };

export function defaultWorktreeBase(repoRoot) {
  return join(repoRoot, '.plan-ledger-worktrees');
}

export function worktreePath(worktreeBase, { planId, stepId, runId }) {
  return join(worktreeBase, `plan-${planId}`, `step-${stepId}`, safeName(runId));
}

export function isGitRepo(repoRoot, { pathExists = existsSync } = {}) {
  return pathExists(join(repoRoot, '.git'));
}

export function createWorktreePool({
  repoRoot = process.cwd(),
  worktreeBase = defaultWorktreeBase(repoRoot),
  skipWorktrees = false,
  exec = execFileSync,
  pathExists = existsSync,
  mkdir = mkdirSync,
  rm = rmSync,
} = {}) {
  const allocated = new Set();
  const integrator = skipWorktrees ? null : createWorktreeIntegrator({ repoRoot, exec });

  function git(args, opts = {}) {
    return exec('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
  }

  function assertCleanForParallelWrite() {
    if (skipWorktrees || !integrator) return { ok: true, skipped: true };
    if (integrator.isRepoDirty()) {
      return {
        ok: false,
        reason: 'integration repository has uncommitted changes; commit or stash before parallel write mode, or pass --skip-worktrees',
      };
    }
    return { ok: true };
  }

  async function allocate({ planId, stepId, runId, readOnly = false }) {
    if (skipWorktrees || readOnly || !isGitRepo(repoRoot, { pathExists })) {
      return { cwd: repoRoot, path: null, skipped: true, readOnly: !!readOnly };
    }
    const wtPath = worktreePath(worktreeBase, { planId, stepId, runId });
    const branch = integrator.branchName({ planId, stepId, runId });
    mkdir(join(worktreeBase, `plan-${planId}`, `step-${stepId}`), { recursive: true });
    if (pathExists(wtPath)) {
      try { git(['worktree', 'remove', '--force', wtPath]); } catch {}
      try { rm(wtPath, { recursive: true, force: true }); } catch {}
    }
    try { git(['branch', '-D', branch]); } catch {}
    const base = integrator.currentHead();
    git(['branch', branch, base]);
    git(['worktree', 'add', wtPath, branch]);
    allocated.delete(wtPath);
    allocated.add(wtPath);
    return {
      cwd: wtPath,
      path: wtPath,
      branch,
      baseCommit: base,
      runId,
      planId,
      stepId,
      skipped: false,
      readOnly: false,
    };
  }

  async function integrateSuccess(entry, { message }) {
    if (!entry || entry.skipped || !entry.path) return { integrated: false, skipped: true };
    const res = await integrator.integrateWorker(entry, {
      planId: entry.planId,
      stepId: entry.stepId,
      message: message || `plan-ledger integrate plan-${entry.planId} step-${entry.stepId}`,
    });
    allocated.delete(entry.path);
    return res;
  }

  async function discard(entry) {
    if (!entry || entry.skipped || !entry.path) return { discarded: false, skipped: true };
    const res = await integrator.discardWorker(entry);
    allocated.delete(entry.path);
    return res;
  }

  async function release(entry) {
    return discard(entry);
  }

  function currentIntegrationHead() {
    return integrator?.currentHead?.() || null;
  }

  function cleanupOrphans({ openLeases = [] } = {}) {
    if (skipWorktrees || !isGitRepo(repoRoot, { pathExists })) return { pruned: 0 };
    const activePaths = new Set(
      openLeases.map((l) => worktreePath(worktreeBase, {
        planId: l.plan_id,
        stepId: l.step_id,
        runId: l.run_id,
      })),
    );
    let pruned = 0;
    let listed = '';
    try { listed = git(['worktree', 'list', '--porcelain']).trim(); } catch { return { pruned: 0 }; }
    const blocks = listed.split('\n\n').filter(Boolean);
    for (const block of blocks) {
      const pathLine = block.split('\n').find((l) => l.startsWith('worktree '));
      const branchLine = block.split('\n').find((l) => l.startsWith('branch '));
      if (!pathLine) continue;
      const wt = pathLine.slice('worktree '.length).trim();
      if (!pathUnderBase(wt, worktreeBase)) continue;
      if (activePaths.has(wt)) continue;
      try {
        git(['worktree', 'remove', '--force', wt]);
        if (branchLine) {
          const branchRef = branchLine.slice('branch '.length).trim();
          const branch = branchRef.replace(/^refs\/heads\//, '');
          if (branch.startsWith('plan-ledger/wt/')) {
            try { git(['branch', '-D', branch]); } catch {}
          }
        }
        allocated.delete(wt);
        pruned++;
      } catch {}
    }
    return { pruned };
  }

  return {
    allocate,
    integrateSuccess,
    discard,
    release,
    cleanupOrphans,
    assertCleanForParallelWrite,
    currentIntegrationHead,
    repoRoot,
    worktreeBase,
    skipWorktrees,
    integrator,
  };
}
