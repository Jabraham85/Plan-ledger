// supervisor.mjs — one shared execution-lifecycle used by every dispatcher
// (runner, MCP server, CLI bridge, board REST). It wraps the atomic
// openExecutionLease / heartbeatExecutionLease / closeExecutionLease
// primitives in a single `supervise()` function so every path emits the
// same telemetry and terminates cleanly whether the work succeeds, fails,
// throws, times out, or the process dies mid-flight.
//
// Contract:
//   - `openExecutionLease` runs inside a transaction that either fresh-claims
//     the step (pending/failed → in_progress) or adopts an already-claimed
//     step. On success we own the lease + activity + step.
//   - A heartbeat pump ticks on a bounded cadence (default 20s, floor 1s,
//     ceiling 60s). Each tick refreshes `last_heartbeat_at` so the reaper
//     never mistakes a live executor for a dead one.
//   - `workFn` runs with helpers `{ heartbeat, appendEvent, updateLeaseMeta }`
//     so it can push mid-work progress into the store without knowing the
//     lease id.
//   - `workFn` MUST resolve with `{ outcome, verdict, disposition, ... }` or
//     reject; either way the lease terminalizes exactly once via
//     `closeExecutionLease`. Idempotent by construction — a second close is
//     a no-op even if a caller retries.
//   - `child_pid` (optional) is polled at heartbeat cadence so an early
//     `SIGKILL` / segfault surfaces as an `abandoned` close within one
//     heartbeat interval instead of waiting for the reaper.
//   - `deadline_ms` (optional) enforces a hard cap. Breaching it cancels
//     the lease as `cancelled` with the elapsed time in the terminal reason.
//
// The reap loop is exposed separately so servers (board, MCP) can start a
// single background reaper on boot without every callsite reimplementing it.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeRepoPath, parseStepOwnership } from './path-ownership.mjs';

const HEARTBEAT_MS_DEFAULT = 20_000;
const HEARTBEAT_MS_FLOOR = 1_000;
const HEARTBEAT_MS_CEIL = 60_000;

function clampInterval(ms, def = HEARTBEAT_MS_DEFAULT) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.max(HEARTBEAT_MS_FLOOR, Math.min(HEARTBEAT_MS_CEIL, n));
}

// Poll whether a child pid is still alive. `process.kill(pid, 0)` returns
// without side effects (or throws ESRCH when the pid is gone). Any other
// error (EPERM) means the pid exists but we don't own it — still alive.
function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return true;
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

function pathUnderPrefix(path, prefix) {
  if (!prefix) return false;
  return path === prefix || path.startsWith(`${prefix}/`);
}

function listFilesUnderPrefix(absDir, relPrefix, out, { pathExists = existsSync, readDir = readdirSync, stat = statSync } = {}) {
  if (!pathExists(absDir)) return;
  for (const name of readDir(absDir)) {
    const abs = join(absDir, name);
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    let st;
    try { st = stat(abs); } catch { continue; }
    if (st.isDirectory()) listFilesUnderPrefix(abs, rel, out, { pathExists, readDir, stat });
    else out.push({ path: normalizeRepoPath(rel), mtime_ms: st.mtimeMs, size: st.size });
  }
}

export function probeOwnedArtifacts(cwd, ownership, {
  baseline = null,
  pathExists = existsSync,
  stat = statSync,
  readDir = readdirSync,
} = {}) {
  const exact = ownership?.exact || [];
  const prefixes = ownership?.prefixes || [];
  const found = [];
  for (const rel of exact) {
    const abs = resolve(cwd, rel);
    if (!pathExists(abs)) continue;
    try {
      const st = stat(abs);
      if (st.isFile()) found.push({ path: normalizeRepoPath(rel), mtime_ms: st.mtimeMs, size: st.size });
    } catch {}
  }
  for (const prefix of prefixes) {
    listFilesUnderPrefix(resolve(cwd, prefix), normalizeRepoPath(prefix), found, { pathExists, readDir, stat });
  }
  const baseMap = baseline instanceof Map ? baseline : new Map();
  const promoted = [];
  for (const item of found) {
    const prev = baseMap.get(item.path);
    if (!prev || prev.mtime_ms !== item.mtime_ms || prev.size !== item.size) {
      promoted.push(item.path);
    }
  }
  return {
    artifacts: found.map((x) => x.path),
    promoted,
    artifact_count: found.length,
    file_count: found.length,
    has_new_artifacts: promoted.length > 0,
  };
}

export function buildArtifactBaseline(cwd, ownership, deps = {}) {
  const stat = deps.stat || statSync;
  const map = new Map();
  const full = probeOwnedArtifacts(cwd, ownership, deps);
  for (const rel of full.artifacts) {
    const abs = resolve(cwd, rel);
    try {
      const st = stat(abs);
      map.set(rel, { mtime_ms: st.mtimeMs, size: st.size });
    } catch {}
  }
  return map;
}

export function ownershipFromStep(step) {
  return parseStepOwnership(step);
}

export async function supervise(store, opts, workFn) {
  if (!store || typeof store.openExecutionLease !== 'function') {
    throw new Error('supervise: store missing execution-lease APIs');
  }
  if (typeof workFn !== 'function') throw new Error('supervise: workFn is required');
  const {
    plan_id, step_id,
    executor = 'supervisor', run_id = null, session_ref = null,
    role = '', agent = '',
    requested_model = '', actual_model = '', model_source = '',
    phase = 'preflight', action_summary = 'supervised execution starting',
    progress_completed = 0, progress_total = 0,
    heartbeat_ms = HEARTBEAT_MS_DEFAULT,
    stale_after_ms = null,
    deadline_ms = null,
    child_pid = null,
    metadata = {},
    onHeartbeat = null,
    onChildExit = null,
    artifact_cwd = null,
    owned_paths = null,
    artifact_probe = probeOwnedArtifacts,
    onArtifactsPromoted = null,
  } = opts;
  const beatMs = clampInterval(heartbeat_ms);
  const staleMs = stale_after_ms == null ? Math.max(30_000, beatMs * 3) : Number(stale_after_ms);
  const openArgs = {
    plan_id, step_id, executor,
    run_id: run_id ?? undefined, session_ref: session_ref ?? undefined,
    role, agent, requested_model, actual_model, model_source,
    phase, action_summary,
    progress_completed, progress_total,
    metadata, child_pid,
    stale_after_ms: staleMs,
    deadline_ms: deadline_ms ?? undefined,
  };
  const opened = store.openExecutionLease(openArgs);
  const leaseId = opened.lease.id;
  const identity = {
    plan_id: opened.lease.plan_id,
    step_id: opened.lease.step_id,
    run_id: opened.lease.run_id,
    session_ref: opened.lease.session_ref,
  };
  const startedAt = Date.now();
  let closed = false;
  let cancelReason = null;
  let trackedChildPid = child_pid != null ? Number(child_pid) : null;
  const probeCwd = artifact_cwd || process.cwd();
  const ownership = owned_paths || null;
  let artifactBaseline = new Map();
  if (ownership && typeof artifact_probe === 'function') {
    try { artifactBaseline = buildArtifactBaseline(probeCwd, ownership); } catch {}
  }

  const artifactHeartbeatPatch = () => {
    if (!ownership || typeof artifact_probe !== 'function') return {};
    try {
      const probe = artifact_probe(probeCwd, ownership, { baseline: artifactBaseline });
      if (probe?.has_new_artifacts) {
        for (const rel of probe.promoted) {
          const abs = resolve(probeCwd, rel);
          try {
            const st = statSync(abs);
            artifactBaseline.set(normalizeRepoPath(rel), { mtime_ms: st.mtimeMs, size: st.size });
          } catch {}
        }
        if (typeof onArtifactsPromoted === 'function') {
          try { onArtifactsPromoted(probe); } catch {}
        }
        return {
          artifact_count: probe.artifact_count,
          file_count: probe.file_count,
          recent_artifacts: probe.promoted.slice(0, 24),
          action_summary: `artifact probe: ${probe.promoted.slice(0, 3).join(', ')}`,
        };
      }
    } catch {}
    return {};
  };

  const closeSafely = (payload) => {
    if (closed) return { reused: true };
    closed = true;
    try { return store.closeExecutionLease(leaseId, payload); }
    catch (e) { return { error: e.message }; }
  };

  const heartbeat = (patch = {}) => {
    if (closed) return null;
    if (patch.child_pid !== undefined) {
      trackedChildPid = patch.child_pid == null ? null : Number(patch.child_pid);
    }
    try {
      const beat = store.heartbeatExecutionLease(leaseId, { ...artifactHeartbeatPatch(), ...patch });
      if (typeof onHeartbeat === 'function') {
        try { onHeartbeat({ elapsed_ms: Date.now() - startedAt, lease: beat.lease, activity: beat.activity }); } catch {}
      }
      return beat;
    } catch (e) {
      // A heartbeat failure on an already-closed lease is expected during
      // concurrent close; anything else surfaces via return so the caller
      // can react but we never let telemetry throw out of the work path.
      return { error: e.message };
    }
  };
  const appendEvent = (event) => {
    if (closed) return null;
    try {
      return store.appendActivityEvent({
        ...identity,
        event_type: event.event_type || 'progress',
        phase: event.phase || 'execute',
        summary: event.summary || '',
        command_summary: event.command_summary || '',
        metadata: event.metadata || {},
        status: event.status || 'in_progress',
        outcome: event.outcome || '',
        verification_state: event.verification_state || '',
      });
    } catch (e) { return { error: e.message }; }
  };

  const timer = setInterval(() => {
    if (closed) return;
    // Deadline check first: a hard cap always wins over a healthy heartbeat.
    if (deadline_ms && Number(deadline_ms) > 0) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= Number(deadline_ms)) {
        cancelReason = `deadline exceeded after ${elapsed}ms (cap ${deadline_ms}ms)`;
        return; // finally-block below closes as cancelled once workFn resolves/rejects
      }
    }
    // Child-death check: if the caller told us who's doing the work and
    // that pid is gone, we can close as abandoned within one heartbeat
    // instead of waiting for the reaper.
    if (trackedChildPid && !pidAlive(trackedChildPid)) {
      cancelReason = `child pid ${trackedChildPid} exited before terminal event`;
      if (typeof onChildExit === 'function') {
        try { onChildExit({ pid: trackedChildPid, elapsed_ms: Date.now() - startedAt }); } catch {}
      }
      return;
    }
    const patch = artifactHeartbeatPatch();
    heartbeat(patch);
  }, beatMs);
  if (timer.unref) timer.unref();

  try {
    const result = await workFn({
      lease: opened.lease,
      identity,
      heartbeat,
      appendEvent,
      updateLeaseMeta: (patch) => heartbeat(patch),
      startedAt,
      isCancelled: () => cancelReason != null,
      cancelReason: () => cancelReason,
    });
    clearInterval(timer);
    // Explicit deadline hit before workFn resolved? Terminate as cancelled.
    if (cancelReason) {
      return {
        supervised: true, lease_id: leaseId, identity,
        result: closeSafely({
          outcome: 'cancelled', close_reason: cancelReason,
          terminal_phase: 'review',
          terminal_summary: cancelReason,
        }),
        outcome: 'cancelled',
        cancelled: true, reason: cancelReason,
      };
    }
    const outcome = result?.outcome
      || (result?.verdict === 'pass' ? 'success'
        : result?.verdict === 'blocked' ? 'blocked'
        : result?.verdict === 'partial' ? 'partial'
        : result?.verdict === 'fail' ? 'failed'
        : 'success');
    const close = closeSafely({
      outcome,
      close_reason: result?.close_reason || '',
      terminal_summary: result?.terminal_summary || result?.summary || 'work completed',
      terminal_phase: result?.terminal_phase || 'review',
      terminal_metadata: result?.terminal_metadata || {},
      verification_state: result?.verification_state ?? null,
      step_verdict: result?.step_verdict || result?.verdict || null,
      attempt: result?.attempt ?? null,
      completion_payload: result?.completion_payload ?? result?.attempt?.completion_payload ?? null,
      disposition: result?.disposition ?? null,
      disposition_reason: result?.disposition_reason || '',
    });
    return {
      supervised: true, lease_id: leaseId, identity,
      result: close, outcome, cancelled: false, work_result: result,
    };
  } catch (err) {
    clearInterval(timer);
    const close = closeSafely({
      outcome: cancelReason ? 'cancelled' : 'failed',
      close_reason: cancelReason || (err?.message || 'workFn threw'),
      terminal_summary: cancelReason || `error: ${(err?.message || 'unknown').slice(0, 240)}`,
      terminal_phase: 'review',
      terminal_metadata: { error: err?.message || String(err), stack: err?.stack?.slice(0, 400) || '' },
    });
    return {
      supervised: true, lease_id: leaseId, identity,
      result: close, outcome: cancelReason ? 'cancelled' : 'failed',
      cancelled: !!cancelReason, error: err,
    };
  } finally {
    clearInterval(timer);
  }
}

// Background reaper: closes stale/deadline-breached leases on a bounded
// cadence. Servers (board, MCP) call this once at boot and let it run for
// the lifetime of the process; the runner also runs it in-band before/after
// each plan pass. Returns a { stop } handle so callers can shut it down.
export function reapLoop(store, {
  interval_ms = 60_000,
  stale_after_ms = 120_000,
  batch = 50,
  onReap = null,
  logger = null,
} = {}) {
  const beatMs = Math.max(5_000, Math.min(15 * 60_000, Number(interval_ms) || 60_000));
  const staleMs = Math.max(5_000, Number(stale_after_ms) || 120_000);
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      const res = store.reapStaleLeases({ stale_after_ms: staleMs, batch });
      if (res && res.reaped_count > 0) {
        if (typeof onReap === 'function') { try { onReap(res); } catch {} }
        if (logger) { try { logger(`[reap] closed ${res.reaped_count} stale lease(s)`); } catch {} }
      }
    } catch (e) {
      if (logger) { try { logger(`[reap] error: ${e.message}`); } catch {} }
    }
  };
  const timer = setInterval(tick, beatMs);
  if (timer.unref) timer.unref();
  // Fire once on start so already-stale leases from a prior crashed run are
  // recovered immediately, not after the first interval.
  setImmediate(tick);
  return {
    stop() { stopped = true; clearInterval(timer); },
    tickNow: tick,
    interval_ms: beatMs,
    stale_after_ms: staleMs,
  };
}

export const HEARTBEAT_DEFAULTS = { HEARTBEAT_MS_DEFAULT, HEARTBEAT_MS_FLOOR, HEARTBEAT_MS_CEIL };
