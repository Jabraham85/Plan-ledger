// runner-step.mjs — reusable single-step execution for parallel dispatch.
// Uses supervise() so heartbeats, artifact probes, and terminalization stay on
// the unified lease contract (C1-C4).

import { randomUUID } from 'node:crypto';
import { supervise } from '../src/supervisor.mjs';
import { parseStepOwnership } from '../src/path-ownership.mjs';
import {
  runDispatchPreflight,
  parseGovernanceHints,
  parseCompletionContract,
  evaluateCompletionContract,
  buildCompletionPayloadV2,
  detectNoncomplianceEscalation,
  safeActivitySummary,
} from './execution-governance.mjs';
import { parseVerify, applyVerifyGate, formatUsageLine, appendUsageToLatestAttempt } from './runner-lib.mjs';

function terminalizeCrash(store, stepId, { executorId = 'runner-parallel', reason = 'step runner crashed' } = {}) {
  try {
    const open = store.listExecutionLeases({ step_id: stepId, status: 'open' });
    for (const lease of open) {
      store.closeExecutionLease(lease.id, {
        outcome: 'abandoned',
        close_reason: reason,
        terminal_summary: safeActivitySummary(reason),
        terminal_phase: 'execute',
      });
    }
  } catch {}
  try {
    const st = store.getStep(stepId);
    if (st.status === 'in_progress') store.setStepStatus(stepId, 'pending');
  } catch {}
}

function spawnHooks(heartbeat, heartbeatMs, extra = {}) {
  return {
    ...extra,
    heartbeat_ms: extra.heartbeat_ms ?? heartbeatMs,
    onStart: ({ pid }) => {
      heartbeat({ child_pid: pid });
      extra.onStart?.({ pid });
    },
    onHeartbeat: extra.onHeartbeat,
  };
}

export function createParallelStepRunner(deps) {
  const {
    store,
    executorId = 'runner-parallel',
    inject = false,
    heartbeatMs = 60_000,
    leasePolicyTemplate = {},
    dispatchPlanForStep,
    runInjected,
    runAgent,
    budgetOrLimitStop,
    usage,
    trackClaim,
    checkPortReady,
    cursorModelCatalog,
    dispatchOverrideReason = '',
    worktreePool = null,
    onStepComplete = () => {},
  } = deps;

  const spawns = new Map();

  return async function runParallelStep({ step, ownership, executor, releasePathLock }) {
    const pid = step.plan_id;
    const n = (spawns.get(step.id) || 0) + 1;
    spawns.set(step.id, n);
    trackClaim?.(step);

    const dispatch = dispatchPlanForStep(step);
    const roleR = dispatch.roleResolution;
    const requestedModel = dispatch.requestedModel;
    const dispatchWarnings = [...(dispatch.policy.warnings || [])];
    const owned = ownership || parseStepOwnership(step);
    const writeCapable = !!(owned.exact?.length || owned.prefixes?.length);

    if (dispatch.policy.requires_override_reason && !dispatchOverrideReason) {
      store.recordAttempt(step.id, {
        what_tried: '[dispatch-policy] blocked before dispatch (override reason missing)',
        result: `Override reason required for explicit role "${dispatch.policy.explicit_role}"`,
        verdict: 'fail',
        role: dispatch.dispatchRole || '',
        executor: executorId,
      });
      try { store.setStepStatus(step.id, 'pending'); } catch {}
      return { outcome: 'paused', step_id: step.id };
    }
    if (dispatch.policy.requires_override_reason) dispatch.policy.override_reason = dispatchOverrideReason;

    const runId = `run-${step.id}-${n}-${randomUUID().slice(0, 8)}`;
    let wtEntry = null;
    let wtCleaned = false;
    const cleanupWorktree = async (integrate = false, message = '') => {
      if (wtCleaned || !worktreePool || !wtEntry || wtEntry.skipped) return;
      if (integrate) await worktreePool.integrateSuccess(wtEntry, { message });
      else await worktreePool.discard(wtEntry);
      wtCleaned = true;
    };

    try {
      if (worktreePool && writeCapable) {
        const clean = worktreePool.assertCleanForParallelWrite?.();
        if (clean && !clean.ok) {
          throw new Error(clean.reason || 'integration repository is dirty');
        }
      }
      if (worktreePool) {
        wtEntry = await worktreePool.allocate({
          planId: pid,
          stepId: step.id,
          runId,
          readOnly: !writeCapable,
        });
      }
      const cwd = wtEntry?.cwd || process.cwd();
      const integrateMessage = `plan-ledger plan-${pid} step-${step.id} run-${runId}`;

      const finalizePassWithIntegration = async (workResult, { heartbeat }) => {
        const post = store.getStep(step.id);
        const isPass = workResult.step_verdict === 'pass'
          || workResult.verdict === 'pass'
          || (workResult.outcome === 'success' && post.status === 'done');
        if (!isPass) {
          if (wtEntry && !wtEntry.skipped && !wtCleaned) await cleanupWorktree(false);
          return workResult;
        }
        if (writeCapable && wtEntry && !wtEntry.skipped) {
          heartbeat({
            phase: 'review',
            action_summary: 'integrating worker changes before terminal close',
            progress_completed: 3,
            progress_total: 4,
          });
          try {
            await cleanupWorktree(true, integrateMessage);
          } catch (err) {
            return {
              outcome: 'failed',
              verdict: 'fail',
              step_verdict: 'fail',
              close_reason: 'integration failed',
              terminal_summary: safeActivitySummary(err?.message || 'integration failed'),
              terminal_metadata: {
                integration_error: err?.message || String(err),
                recoverable_branch: err?.details?.branch || wtEntry.branch || '',
                recoverable_commit: err?.details?.commitSha || '',
              },
              attempt: {
                what_tried: '[integration] failed before lease terminal close',
                result: String(err?.message || err).slice(0, 500),
                verdict: 'fail',
                role: dispatch.dispatchRole || '',
                executor: executorId,
              },
            };
          }
        } else if (wtEntry && !wtEntry.skipped && !wtCleaned) {
          await cleanupWorktree(false);
        }
        return workResult;
      };

      const sup = await supervise(store, {
        plan_id: pid,
        step_id: step.id,
        executor: executor || executorId,
        run_id: runId,
        session_ref: `pending-${runId}`,
        role: dispatch.dispatchRole || '',
        agent: roleR.mode === 'dispatch' ? (roleR.agent || dispatch.dispatchRole || '') : (dispatch.dispatchRole || ''),
        requested_model: requestedModel,
        actual_model: requestedModel,
        model_source: requestedModel ? 'runner-cli' : '',
        heartbeat_ms: heartbeatMs,
        stale_after_ms: leasePolicyTemplate.stale_after_ms,
        deadline_ms: 30 * 60 * 1000,
        artifact_cwd: cwd,
        owned_paths: owned,
        metadata: {
          dispatch_policy: dispatch.policy,
          lease_policy: leasePolicyTemplate,
          warnings: dispatchWarnings,
          worktree: wtEntry?.path || '',
          worktree_branch: wtEntry?.branch || '',
        },
      }, async ({ heartbeat }) => {
        const preflight = await runDispatchPreflight({
          cwd,
          requested_model: requestedModel,
          context: step.context,
          acceptance: step.acceptance_criteria,
          model_catalog: cursorModelCatalog,
          check_port: checkPortReady,
        });
        if (!preflight.ok) {
          if (wtEntry && !wtEntry.skipped && !wtCleaned) await cleanupWorktree(false);
          return {
            outcome: 'failed',
            verdict: 'fail',
            step_verdict: 'fail',
            close_reason: 'preflight failed',
            terminal_summary: safeActivitySummary(preflight.summary),
            attempt: {
              what_tried: `[governance:preflight] ${preflight.summary}`,
              result: preflight.checks.map((c) => `${c.ok ? 'ok' : 'fail'} ${c.name}: ${c.detail}`).join('\n'),
              verdict: 'fail',
              role: dispatch.dispatchRole || '',
              executor: executorId,
            },
          };
        }

        heartbeat({ phase: 'execute', action_summary: 'dispatch running', progress_completed: 1, progress_total: 4 });

        if (inject) {
          const hints = parseGovernanceHints({ context: step.context, acceptance: step.acceptance_criteria });
          const res = await runInjected(step, dispatch, spawnHooks(heartbeat, heartbeatMs, {
            cwd,
            onHeartbeat: ({ elapsed_ms }) => {
              heartbeat({
                phase: 'execute',
                action_summary: safeActivitySummary(`dispatch running (${Math.round(elapsed_ms / 1000)}s elapsed)`),
                progress_completed: 1,
                progress_total: 4,
              });
            },
          }));
          if (res) {
            usage.cost += res.cost;
            usage.in += res.tin;
            usage.out += res.tout;
            usage.turns += res.turns;
            usage.agents++;
            if (budgetOrLimitStop(res)) {
              if (wtEntry && !wtEntry.skipped && !wtCleaned) await cleanupWorktree(false);
              return {
                outcome: 'failed',
                verdict: 'fail',
                step_verdict: 'fail',
                close_reason: 'budget or rate limit',
                terminal_summary: 'stopped by budget/rate limit',
              };
            }
          }
          const completion = parseCompletionContract(res?.result || '');
          const evaluated = evaluateCompletionContract({
            completion_parse: completion,
            required_artifacts: hints.required_artifacts,
            verify_commands: hints.declared_verify,
            cwd,
          });
          const escalation = detectNoncomplianceEscalation({
            attempts: store.getStep(step.id).attempts,
            nextNoncompliant: !completion.ok,
          });
          const finalVerdict = escalation.escalate ? 'fail' : evaluated.verdict;
          const summary = escalation.escalate
            ? `${evaluated.summary} | ${escalation.recommendation}`
            : evaluated.summary;
          const usageStr = formatUsageLine({ tin: res?.tin || 0, tout: res?.tout || 0, cost: res?.cost || 0, turns: res?.turns || 0, model: res?.model });
          const completionPayload = buildCompletionPayloadV2({
            evaluated,
            outcome: finalVerdict === 'pass' ? 'success' : 'failed',
            limitations: evaluated.unresolved_gaps || [],
          });
          if (finalVerdict !== 'pass') {
            if (wtEntry && !wtEntry.skipped && !wtCleaned) await cleanupWorktree(false);
            return {
              outcome: 'failed',
              verdict: 'fail',
              step_verdict: 'fail',
              close_reason: escalation.escalate ? 'noncompliance escalation' : `inject verdict ${finalVerdict}`,
              terminal_summary: safeActivitySummary(summary),
              attempt: {
                what_tried: `[governance:noncompliance] ${safeActivitySummary(summary, 200)}`,
                result: `${safeActivitySummary(summary, 360)}\n${usageStr}`,
                verdict: 'fail',
                role: dispatch.dispatchRole || '',
                executor: executorId,
              },
            };
          }
          const passResult = {
            outcome: 'success',
            verdict: 'pass',
            step_verdict: 'pass',
            close_reason: 'inject pass integrated',
            terminal_summary: safeActivitySummary(summary),
            verification_state: 'passed',
            completion_payload: completionPayload,
            attempt: {
              what_tried: `[orchestrator:inject] ${safeActivitySummary(summary, 200)}`,
              result: `${safeActivitySummary(summary, 360)}\n${usageStr}`,
              verdict: 'pass',
              role: dispatch.dispatchRole || '',
              executor: executorId,
              model: res?.model || requestedModel,
              model_source: requestedModel ? 'runner-cli' : '',
            },
          };
          return finalizePassWithIntegration(passResult, { heartbeat });
        }

        const lastAttemptIdBefore = store.db.prepare('SELECT MAX(id) m FROM attempts WHERE step_id=?').get(step.id).m || 0;
        const res = await runAgent(step, dispatch, spawnHooks(heartbeat, heartbeatMs, {
          cwd,
          onHeartbeat: ({ elapsed_ms }) => {
            heartbeat({
              phase: 'execute',
              action_summary: safeActivitySummary(`dispatch running (${Math.round(elapsed_ms / 1000)}s elapsed)`),
              progress_completed: 1,
              progress_total: 3,
            });
          },
        }));
        if (res) {
          usage.cost += res.cost;
          usage.in += res.tin;
          usage.out += res.tout;
          usage.turns += res.turns;
          usage.agents++;
          const usageStr = formatUsageLine({ tin: res.tin, tout: res.tout, cost: res.cost, turns: res.turns, model: res.model });
          appendUsageToLatestAttempt(store.db, step.id, lastAttemptIdBefore, usageStr);
          if (budgetOrLimitStop(res)) {
            if (wtEntry && !wtEntry.skipped && !wtCleaned) await cleanupWorktree(false);
            return { outcome: 'failed', verdict: 'fail', step_verdict: 'fail', close_reason: 'budget or rate limit', terminal_summary: 'stopped by budget/rate limit' };
          }
        }
        const verifyCmd = parseVerify(step.context);
        if (verifyCmd) {
          const afterAgent = store.getStep(step.id);
          if (afterAgent.status === 'done') {
            const gated = applyVerifyGate('pass', 'agent claimed pass via record_attempt', verifyCmd, { cwd });
            if (gated.verdict === 'fail') {
              if (wtEntry && !wtEntry.skipped && !wtCleaned) await cleanupWorktree(false);
              return {
                outcome: 'failed',
                verdict: 'fail',
                step_verdict: 'fail',
                close_reason: 'verify override',
                terminal_summary: safeActivitySummary('VERIFY override after MCP pass'),
                attempt: {
                  what_tried: '[orchestrator:verify-override] re-ran VERIFY after done',
                  result: gated.resultText,
                  verdict: 'fail',
                  role: dispatch.dispatchRole || '',
                  executor: executorId,
                },
              };
            }
          }
        }
        const post = store.getStep(step.id);
        const mcpOutcome = post.status === 'done' ? 'success'
          : post.status === 'blocked' ? 'blocked'
          : post.status === 'failed' ? 'failed'
          : 'abandoned';
        if (mcpOutcome !== 'success') {
          if (wtEntry && !wtEntry.skipped && !wtCleaned) await cleanupWorktree(false);
          return {
            outcome: mcpOutcome,
            verdict: post.status === 'done' ? 'pass' : 'fail',
            step_verdict: post.status === 'done' ? 'pass' : 'fail',
            close_reason: `mcp dispatch -> step ${post.status}`,
            terminal_summary: safeActivitySummary(`MCP dispatch finished with step status ${post.status}.`),
          };
        }
        const mcpPass = {
          outcome: 'success',
          verdict: 'pass',
          step_verdict: 'pass',
          close_reason: 'mcp pass integrated',
          terminal_summary: safeActivitySummary(`MCP dispatch finished with step status ${post.status}.`),
        };
        return finalizePassWithIntegration(mcpPass, { heartbeat });
      });

      onStepComplete({ step, sup, attempt: n });
      return { outcome: sup.outcome, step_id: step.id, supervised: true };
    } catch (err) {
      terminalizeCrash(store, step.id, { executorId, reason: err?.message || 'step runner crashed' });
      if (!wtCleaned) await cleanupWorktree(false);
      throw err;
    } finally {
      releasePathLock?.();
    }
  };
}

export { parseStepOwnership };
