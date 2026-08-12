// worktree-integrator.mjs — serialized git integration for parallel workers.

import { execFileSync } from 'node:child_process';

export class IntegrationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'IntegrationError';
    this.details = details;
  }
}

function safeName(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48);
}

export function createWorktreeIntegrator({
  repoRoot,
  exec = execFileSync,
} = {}) {
  if (!repoRoot) throw new Error('createWorktreeIntegrator: repoRoot is required');

  let integrationHead = null;
  let chain = Promise.resolve();

  function git(args, opts = {}) {
    try {
      return exec('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts,
      }).trim();
    } catch (err) {
      const detail = err.stderr?.toString?.() || err.stdout?.toString?.() || err.message || String(err);
      const wrapped = new IntegrationError(`git ${args.join(' ')} failed: ${detail}`, {
        args,
        cwd: opts.cwd || repoRoot,
        stderr: detail,
      });
      throw wrapped;
    }
  }

  function gitIn(cwd, args) {
    return git(args, { cwd });
  }

  function enqueue(fn) {
    const next = chain.then(() => fn());
    chain = next.catch(() => {}); // keep queue alive after failures
    return next;
  }

  function isRepoDirty() {
    try {
      return git(['status', '--porcelain']).length > 0;
    } catch {
      return true;
    }
  }

  function currentHead() {
    return integrationHead || git(['rev-parse', 'HEAD']);
  }

  function refreshHead() {
    integrationHead = git(['rev-parse', 'HEAD']);
    return integrationHead;
  }

  function abortCherryPickIfNeeded() {
    try {
      const cp = git(['rev-parse', '--git-path', 'CHERRY_PICK_HEAD']);
      if (cp) git(['cherry-pick', '--abort']);
    } catch {}
  }

  function branchName({ planId, stepId, runId }) {
    return `plan-ledger/wt/plan-${planId}/step-${stepId}/${safeName(runId)}`;
  }

  async function integrateWorker(entry, { planId, stepId, message }) {
    if (!entry?.path || entry.skipped) return { integrated: false, skipped: true };
    return enqueue(async () => {
      abortCherryPickIfNeeded();
      const wtCwd = entry.path;
      const branch = entry.branch || branchName({ planId, stepId, runId: entry.runId });
      try {
        gitIn(wtCwd, ['add', '-A']);
        const staged = gitIn(wtCwd, ['diff', '--cached', '--name-only']);
        if (!staged) {
          throw new IntegrationError('worker worktree has no staged changes to integrate', {
            branch,
            path: wtCwd,
            planId,
            stepId,
          });
        }
        gitIn(wtCwd, ['commit', '-m', message]);
        const commitSha = gitIn(wtCwd, ['rev-parse', 'HEAD']);
        try {
          git(['cherry-pick', commitSha]);
        } catch (err) {
          abortCherryPickIfNeeded();
          throw new IntegrationError(`cherry-pick failed for ${commitSha}: ${err.message}`, {
            branch,
            commitSha,
            planId,
            stepId,
            recoverable: true,
          });
        }
        integrationHead = git(['rev-parse', 'HEAD']);
        try { git(['worktree', 'remove', '--force', wtCwd]); } catch {}
        try { git(['branch', '-D', branch]); } catch {}
        return { integrated: true, commit: commitSha, head: integrationHead, branch };
      } catch (err) {
        if (!(err instanceof IntegrationError)) {
          throw new IntegrationError(err.message || String(err), { branch, planId, stepId });
        }
        throw err;
      }
    });
  }

  async function discardWorker(entry) {
    if (!entry?.path || entry.skipped) return { discarded: false, skipped: true };
    const wtCwd = entry.path;
    const branch = entry.branch;
    try { git(['worktree', 'remove', '--force', wtCwd]); } catch {}
    if (branch) {
      try { git(['branch', '-D', branch]); } catch {}
    }
    return { discarded: true, branch };
  }

  return {
    repoRoot,
    isRepoDirty,
    currentHead,
    refreshHead,
    branchName,
    integrateWorker,
    discardWorker,
    abortCherryPickIfNeeded,
  };
}
