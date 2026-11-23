// Parent-owned cloud dispatch bridge. This module never creates or messages remote tasks.
import { randomUUID } from 'node:crypto';
import { compileWorkerPacket } from './planner-handoff.mjs';

const text = (v, name) => {
  if (typeof v !== 'string' || !v.trim() || v.length > 1024 || /[\r\n]/.test(v)) throw new Error('dispatch_' + name + '_required');
  return v;
};
const stamp = () => new Date().toISOString();
const shaped = (store, row) => ({
  request_id: row.id, client_key: row.client_key, execution_route: 'cloud-parent',
  plan_id: row.plan_id, step_id: row.step_id, phase: row.phase,
  packet: JSON.parse(row.packet_json), identity: JSON.parse(row.identity_json || '{}'),
  cancellation_requested: !!row.cancellation_requested, lease_id: row.lease_id || null,
  work_epoch: row.work_epoch, remote_outcome: row.remote_outcome,
  ownership: { state: row.phase === 'completed' ? 'released' : row.lease_id && store.getExecutionLease(row.lease_id).status === 'closed' ? 'recovery_required' : row.phase === 'reconciling' ? 'held_pending_remote_reconciliation' : row.lease_id ? 'held' : 'not_claimed',
    remote_last_observed_at: JSON.parse(row.identity_json || '{}').observed_at || null,
    observation_freshness_is_not_remote_liveness: true, relaunch_allowed: false },
  events: store.db.prepare('SELECT seq, event_json, created_at FROM cloud_dispatch_events WHERE request_id=? ORDER BY seq').all(row.id).map(e => ({ ...JSON.parse(e.event_json), seq: e.seq, created_at: e.created_at })),
});
const rowFor = (store, id) => {
  const row = store.db.prepare('SELECT * FROM cloud_dispatch_requests WHERE id=?').get(text(id, 'request_id'));
  if (!row) throw new Error('dispatch_request_missing');
  return row;
};
const event = (store, id, data) => store.db.prepare('INSERT INTO cloud_dispatch_events(request_id,event_json,created_at) VALUES(?,?,?)').run(id, JSON.stringify(data), stamp());
const observation = input => {
  if (!input || !['created','running','unknown','completed','failed','cancelled','not_created'].includes(input.status)) throw new Error('dispatch_observation_status_invalid');
  const out = { status: input.status, source_ref: text(input.source_ref, 'source_ref'), tool_name: text(input.tool_name, 'tool_name'), observed_at: text(input.observed_at, 'observed_at'), verification: 'trusted-parent-platform-observation' };
  if (!out.tool_name.startsWith('cloud_threads.')) throw new Error('dispatch_observation_tool_invalid');
  if (!Number.isFinite(Date.parse(out.observed_at))) throw new Error('dispatch_observed_at_invalid');
  for (const k of ['thread_id','turn_id']) if (input[k] != null) out[k] = text(input[k], k);
  if (['created','running','completed','failed','cancelled'].includes(out.status) && !out.thread_id) throw new Error('dispatch_thread_id_required');
  return out;
};
function bindIdentity(store, row, obs) {
  const prior = JSON.parse(row.identity_json || '{}');
  if (prior.observed_at && Date.parse(obs.observed_at) < Date.parse(prior.observed_at)) throw new Error('dispatch_observation_stale');
  for (const k of ['thread_id','turn_id']) if (prior[k] && obs[k] && prior[k] !== obs[k]) throw new Error('dispatch_identity_mismatch');
  if (obs.thread_id) {
    const other = store.db.prepare("SELECT id FROM cloud_dispatch_requests WHERE id<>? AND json_extract(identity_json,'$.thread_id')=?").get(row.id, obs.thread_id);
    if (other) throw new Error('dispatch_thread_already_bound');
  }
  const identity = { ...prior, ...(obs.thread_id ? { thread_id: obs.thread_id } : {}), ...(obs.turn_id ? { turn_id: obs.turn_id } : {}),
    source_ref: obs.source_ref, tool_name: obs.tool_name, observed_at: obs.observed_at, verification: obs.verification };
  // Absent turn IDs stay absent. Parent tool capabilities are not assumed.
  store.db.prepare('UPDATE cloud_dispatch_requests SET identity_json=?, updated_at=? WHERE id=?').run(JSON.stringify(identity), stamp(), row.id);
  return identity;
}
function current(store, row) {
  if (store.getStep(row.step_id).acceptance_epoch !== row.work_epoch) throw new Error('dispatch_work_generation_stale');
}
export function readCloudDispatch(store, { request_id }) { return shaped(store, rowFor(store, request_id)); }

function enforceReviewScope(store, packet) {
  if (!packet.prior_review) return;
  const prior = store.db.prepare(`
    SELECT d.packet_json FROM cloud_dispatch_requests d JOIN cloud_dispatch_events e ON e.request_id=d.id
    WHERE d.step_id=? AND json_extract(e.event_json, '$.event')='evidence_submitted'
      AND json_extract(e.event_json, '$.submission.submission_id')=?`
  ).get(packet.step_id, packet.prior_review.submission_id);
  if (!prior) return;
  const original = JSON.parse(prior.packet_json);
  if (packet.goal !== original.goal || packet.step.context !== original.step.context ||
      packet.pilot_version !== original.pilot_version ||
      JSON.stringify(packet.result_evidence_contract) !== JSON.stringify(original.result_evidence_contract) ||
      JSON.stringify(packet.scope) !== JSON.stringify(original.scope) ||
      JSON.stringify(packet.authorization) !== JSON.stringify(original.authorization)) throw new Error('dispatch_review_scope_changed');
}

export function prepareCloudDispatch(store, args) {
  text(args.client_key, 'client_key');
  return store._tx(() => {
    const old = store.db.prepare('SELECT * FROM cloud_dispatch_requests WHERE client_key=?').get(args.client_key);
    if (old) {
      if (old.step_id !== Number(args.step_id)) throw new Error('dispatch_client_key_conflict');
      return shaped(store, old); // Retry recovers the same request; never creates a second remote task.
    }
    const step = store.getStep(Number(args.step_id)), plan = store.openPlan(step.plan_id);
    if (plan.status !== 'active') throw new Error('awaiting_plan_approval');
    if (!store.readySteps(plan.id, { claim: false }).some(s => s.id === step.id)) throw new Error('step_not_ready');
    const active = store.db.prepare("SELECT id FROM cloud_dispatch_requests WHERE step_id=? AND phase<>'completed'").get(step.id);
    if (active) throw new Error('dispatch_already_owned:' + active.id);
    const pendingSubmission = step.notes.map(n => { try { return JSON.parse(n.body); } catch { return {}; } }).some(n => n.event === 'completion_submission' && n.epoch === step.acceptance_epoch);
    const completedAwaitingEvidence = store.db.prepare("SELECT id FROM cloud_dispatch_requests WHERE step_id=? AND phase='completed' AND remote_outcome='completed' AND work_epoch=?").get(step.id, step.acceptance_epoch);
    if (pendingSubmission || completedAwaitingEvidence) throw new Error('dispatch_pending_acceptance');
    const packet = compileWorkerPacket(store, args);
    enforceReviewScope(store, packet);
    const id = randomUUID(), at = stamp();
    store.db.prepare("INSERT INTO cloud_dispatch_requests(id,client_key,plan_id,step_id,phase,packet_json,work_epoch,created_at,updated_at) VALUES(?,?,?,?,'prepared',?,?,?,?)").run(id, args.client_key, plan.id, step.id, JSON.stringify(packet), step.acceptance_epoch, at, at);
    event(store, id, { event: 'prepared', packet_digest: packet.digest, remote_task_created: false });
    return readCloudDispatch(store, { request_id: id });
  });
}

export function requestCloudDispatch(store, { request_id }) {
  return store._tx(() => {
    const row = rowFor(store, request_id);
    if (row.phase !== 'prepared') throw new Error('dispatch_already_requested_reconcile_before_retry');
    if (row.cancellation_requested) throw new Error('dispatch_cancellation_pending');
    current(store, row);
    const packet = JSON.parse(row.packet_json), step = store.getStep(row.step_id), plan = store.openPlan(row.plan_id);
    if (plan.status !== 'active' || JSON.stringify(step.acceptance_contract) !== JSON.stringify(packet.step.acceptance_contract) || step.context !== packet.step.context || store.getProjectRoot(plan.project_id) !== packet.scope.workspace) throw new Error('dispatch_packet_stale');
    const lease = store.openExecutionLease({ plan_id: row.plan_id, step_id: row.step_id, executor: 'cloud-parent', run_id: row.id,
      session_ref: 'dispatch-request:' + row.id, metadata: { execution_route: 'cloud-parent', request_id: row.id, packet_digest: packet.digest }, action_summary: 'Parent dispatch requested; remote start not confirmed' });
    store.db.prepare("UPDATE cloud_dispatch_requests SET phase='requested',lease_id=?,work_epoch=?,updated_at=? WHERE id=?").run(lease.lease.id, store.getStep(row.step_id).acceptance_epoch, stamp(), row.id);
    event(store, row.id, { event: 'requested', parent_action: 'create exactly one cloud task; uncertain outcome requires reconciliation', remote_task_created: false });
    return readCloudDispatch(store, { request_id: row.id });
  });
}

export function reconcileCloudDispatch(store, { request_id, observation: supplied }) {
  const obs = observation(supplied);
  return store._tx(() => {
    const row = rowFor(store, request_id);
    if (row.phase === 'prepared' && !(row.cancellation_requested && obs.status === 'not_created')) throw new Error('dispatch_not_requested');
    if (row.phase === 'completed') {
      const identity = JSON.parse(row.identity_json || '{}');
      if (obs.status !== row.remote_outcome || (obs.thread_id && obs.thread_id !== identity.thread_id) || (obs.turn_id && identity.turn_id && obs.turn_id !== identity.turn_id)) throw new Error('dispatch_terminal_observation_conflict');
      return shaped(store, row);
    }
    if (obs.status !== 'unknown' && store.getStep(row.step_id).acceptance_epoch !== row.work_epoch) {
      store.db.prepare("UPDATE cloud_dispatch_requests SET phase='reconciling',updated_at=? WHERE id=?").run(stamp(), row.id);
      event(store, row.id, { event: 'remote_observation_requires_recovery', ...obs, reason: 'work generation changed; no newer state mutated' });
      return readCloudDispatch(store, { request_id: row.id });
    }
    bindIdentity(store, row, obs);
    if (obs.status === 'unknown') {
      store.db.prepare("UPDATE cloud_dispatch_requests SET phase='reconciling',updated_at=? WHERE id=?").run(stamp(), row.id);
      event(store, row.id, { event: 'reconciling', ...obs, retry_may_duplicate: true });
      return readCloudDispatch(store, { request_id: row.id });
    }
    if (['completed','failed','cancelled','not_created'].includes(obs.status)) {
      if (obs.status === 'not_created' && JSON.parse(row.identity_json || '{}').thread_id) throw new Error('dispatch_identity_mismatch');
      if (row.lease_id) store.closeExecutionLease(row.lease_id, { outcome: obs.status === 'completed' ? 'success' : obs.status === 'failed' ? 'failed' : 'cancelled',
        terminal_summary: 'Parent observed remote ' + obs.status + '; no criterion acceptance implied', terminal_metadata: { remote_identity: obs } });
      // Remote task completion is separate from evidence submission/acceptance.
      if (obs.status === 'completed') store.setStepStatus(row.step_id, 'pending');
      store.db.prepare("UPDATE cloud_dispatch_requests SET phase='completed',remote_outcome=?,work_epoch=?,updated_at=? WHERE id=?").run(obs.status, store.getStep(row.step_id).acceptance_epoch, stamp(), row.id);
      event(store, row.id, { event: 'remote_terminal_confirmed', ...obs, criterion_acceptance: false });
    } else {
      current(store, row);
      const beat = store.heartbeatExecutionLease(row.lease_id, { phase: 'execute', action_summary: 'Parent observed remote ' + obs.status, metadata: { remote_identity: obs } });
      if (!beat) throw new Error('dispatch_lease_missing');
      store.db.prepare("UPDATE cloud_dispatch_requests SET phase=?,updated_at=? WHERE id=?").run(row.cancellation_requested ? 'reconciling' : obs.status === 'running' || row.phase === 'started' ? 'started' : 'requested', stamp(), row.id);
      event(store, row.id, { event: 'parent_status_observed', ...obs });
    }
    return readCloudDispatch(store, { request_id: row.id });
  });
}

export function cancelCloudDispatch(store, { request_id, reason }) {
  text(reason, 'cancellation_reason');
  return store._tx(() => {
    const row = rowFor(store, request_id);
    if (row.phase === 'completed') throw new Error('dispatch_already_terminal');
    if (!row.cancellation_requested) {
      store.db.prepare("UPDATE cloud_dispatch_requests SET cancellation_requested=1,phase=CASE WHEN phase='prepared' THEN phase ELSE 'reconciling' END,updated_at=? WHERE id=?").run(stamp(), row.id);
      event(store, row.id, { event: 'cancellation_requested', reason, remote_cancellation_confirmed: false });
    }
    return readCloudDispatch(store, { request_id: row.id });
  });
}

export function submitCloudDispatch(store, { request_id, completion_payload, report_source_ref }) {
  text(report_source_ref, 'report_source_ref');
  return store._tx(() => {
    const row = rowFor(store, request_id);
    if (row.phase !== 'completed' || row.remote_outcome !== 'completed') throw new Error('dispatch_remote_completion_unconfirmed');
    current(store, row);
    const identity = JSON.parse(row.identity_json || '{}');
    const submission = store.submitCompletion(row.step_id, { completion_payload, executor: 'cloud-parent-worker', session_ref: identity.thread_id });
    store.db.prepare('UPDATE cloud_dispatch_requests SET work_epoch=?,updated_at=? WHERE id=?').run(store.getStep(row.step_id).acceptance_epoch, stamp(), row.id);
    event(store, row.id, { event: 'evidence_submitted', submission, report_source_ref, remote_identity: identity, criterion_acceptance: false });
    return { ...readCloudDispatch(store, { request_id: row.id }), submission };
  });
}


export function bindCloudDispatch(store, args) {
  if (!['created','running'].includes(args.observation?.status)) throw new Error('dispatch_bind_status_invalid');
  return reconcileCloudDispatch(store, args);
}

// Explicit same-task ownership recovery for leases closed by the old local reaper.
// A recorded historical observation never asserts a new remote liveness timestamp.
export function recoverCloudDispatch(store, {request_id, observation: supplied, reason}, {cloudOwnershipAuthority} = {}) {
  const obs = observation(supplied); text(reason, 'recovery_reason');
  return store._tx(() => {
    const row = rowFor(store, request_id);
    if (row.phase === 'completed' || row.phase === 'prepared') throw new Error('dispatch_recovery_phase_invalid');
    if (!['running','created','completed','failed','cancelled'].includes(obs.status)) throw new Error('dispatch_recovery_observation_required');
    const prior = JSON.parse(row.identity_json || '{}');
    if (!prior.thread_id || !prior.turn_id || obs.thread_id !== prior.thread_id || obs.turn_id !== prior.turn_id) throw new Error('dispatch_recovery_exact_identity_required');
    current(store,row);
    const oldLease = store.getExecutionLease(row.lease_id);
    if (oldLease.status !== 'closed' || !oldLease.close_reason.startsWith('reap:')) throw new Error('dispatch_recovery_reaped_lease_required');
    const step = store.getStep(row.step_id), packet = JSON.parse(row.packet_json);
    if (!['pending','in_progress'].includes(step.status) || step.acceptance_decision || step.context !== packet.step.context || JSON.stringify(step.acceptance_contract) !== JSON.stringify(packet.step.acceptance_contract) || store.getProjectRoot(packet.project_id) !== packet.scope.workspace) throw new Error('dispatch_recovery_newer_work_or_scope');
    if (['completed','failed','cancelled'].includes(obs.status)) {
      const result = reconcileCloudDispatch(store,{request_id,observation:obs});
      event(store,row.id,{event:'closed_lease_terminal_recovery',reason,prior_lease_id:oldLease.id,observation:obs,prior_local_closure_preserved:true,new_remote_task_created:false,criterion_acceptance:false});
      store.addNote(row.step_id,{author:'planner',body:JSON.stringify({event:'cloud_terminal_recovery',request_id:row.id,reason,prior_lease_id:oldLease.id,observation:obs,old_reap_audit_preserved:true,criterion_acceptance:false})});
      return readCloudDispatch(store,{request_id});
    }
    bindIdentity(store,row,obs);
    const recovered = store.openExecutionLease({plan_id:row.plan_id,step_id:row.step_id,executor:'cloud-parent',run_id:row.id + ':recovery:' + randomUUID().slice(0,8),session_ref:'dispatch-request:' + row.id,
      metadata:{cloud_dispatch_request_id:row.id,execution_route:'cloud-parent',recovered_from_lease_id:oldLease.id,remote_identity:prior},phase:'recovery',action_summary:'Hold existing remote task pending reconciliation; no redispatch'}, {cloudOwnershipAuthority});
    store.db.prepare('UPDATE execution_leases SET last_heartbeat_at=? WHERE id=?').run(obs.observed_at,recovered.lease.id);
    store.db.prepare("UPDATE cloud_dispatch_requests SET phase='reconciling',lease_id=?,work_epoch=?,updated_at=? WHERE id=?").run(recovered.lease.id,store.getStep(row.step_id).acceptance_epoch,stamp(),row.id);
    event(store,row.id,{event:'ownership_recovered_same_remote_task',reason,prior_lease_id:oldLease.id,new_lease_id:recovered.lease.id,observation:obs,new_remote_task_created:false,remote_liveness_timestamp:obs.observed_at,observation_is_historical:true});
    store.addNote(row.step_id,{author:'planner',body:JSON.stringify({event:'cloud_ownership_recovery',request_id:row.id,reason,prior_lease_id:oldLease.id,new_lease_id:recovered.lease.id,observation:obs,remote_task_relaunched:false})});
    return readCloudDispatch(store,{request_id:row.id});
  });
}
