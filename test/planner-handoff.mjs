import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/db.mjs';
import { compileWorkerPacket, initiateWorker, routeWorkerBlocker, resolveWorkerBlocker } from '../src/planner-handoff.mjs';

const root = mkdtempSync(join(tmpdir(), 'ledger-planner-pilot-'));
process.env.PLAN_LEDGER_ROLES = join(root, 'no-roles.json');
process.env.PLAN_LEDGER_CURSOR_MODELS = 'offline-fixture';
process.env.PLAN_LEDGER_COMPLETION_GATE = 'off'; // explicit contracts must still enforce
const db = join(root, 'pilot.db');
const acceptanceAuthority = Object.freeze({ purpose: 'test orchestrator only' });
let store = new Store(db, { acceptanceAuthority }), checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('ok ' + name); };
const project = store.createProject({ name: 'Isolated Orbit pilot' });
store.setProjectRoot(project.id, root);
const contract = { version: 1, criteria: [ { id: 'login', description: 'Second user logs in' }, { id: 'join', description: 'Invitation accepted' }, { id: 'ticket', description: 'Second user creates and reopens ticket' } ] };
const plan = store.createPlan({ title: 'Simulated journey; no live access', project_id: project.id });
const step = store.addStep(plan.id, { title: 'Verify simulated acceptance contract', context: 'Offline fixture only; no provider or production calls', acceptance_contract: contract });
const auth = { source_ref: 'test:fixture-authorized-local-only', user_instruction: 'Run this offline fixture', granted_actions: ['read fixture','write fixture'], constraints: ['no external dispatch'] };
const packetArgs = { step_id: step.id, authorization: auth };
let packet = compileWorkerPacket(store, packetArgs);
const receipt = JSON.stringify({ simulation: true, journey: ['login','join','ticket'], status: 'fixture verified; native dispatch and live journey unverified' });
writeFileSync(join(root, 'receipt.json'), receipt);
const hash = createHash('sha256').update(receipt).digest('hex');
const payload = { contract_version: 2, outcome: 'success', artifacts: ['receipt.json'], commands: [{ command: 'offline fixture assertions', exit_code: 0, output: 'fixture assertions passed' }], limitations: ['Local simulation; not production acceptance'], criteria: contract.criteria.map(c => ({ id: c.id, status: 'verified', reviewer: 'Nova', evidence: [{ path: 'receipt.json', sha256: hash }] })) };
try {
  check('missing authorization routes as missing context', () => assert.throws(() => compileWorkerPacket(store, { step_id: step.id }), /context_missing/));
  check('packet carries source authorization, context and review owner', () => { assert.equal(packet.authorization.source_ref, auth.source_ref); assert.equal(packet.step.context, step.context); assert.equal(packet.review_owner, 'Nova'); });
  await assert.rejects(initiateWorker(store, { packet, adapter: { kind: 'offline-local', run: async () => ({}) } }), /awaiting_plan_approval/); checks++;
  store.setPlanStatus(plan.id, 'active');
  check('missing mandatory reports rejected even with global gate off', () => assert.throws(() => store.recordAttempt(step.id, { what_tried: 'unsupported pass', verdict: 'pass', completion_payload: { ...payload, criteria: [] } }), /criterion_unverified/));
  check('untested join prevents pass', () => assert.throws(() => store.recordAttempt(step.id, { what_tried: 'join untested', verdict: 'pass', completion_payload: { ...payload, criteria: payload.criteria.map(r => r.id === 'join' ? { ...r, status: 'untested' } : r) } }), /criterion_unverified/));
  check('nonexistent criterion receipt rejected', () => assert.throws(() => store.recordAttempt(step.id, { what_tried: 'missing receipt', verdict: 'pass', completion_payload: { ...payload, criteria: payload.criteria.map(r => ({ ...r, evidence: [{ path: 'missing.json', sha256: hash }] })) } }), /evidence_file_missing/));
  check('criterion receipt hash mismatch rejected',()=>assert.throws(()=>store.recordAttempt(step.id,{what_tried:'wrong receipt hash',verdict:'pass',completion_payload:{...payload,criteria:payload.criteria.map(r=>({...r,evidence:[{path:'receipt.json',sha256:'0'.repeat(64)}]}))}}),/evidence_hash_mismatch/));
  check('duplicate criterion reports rejected',()=>assert.throws(()=>store.recordAttempt(step.id,{what_tried:'duplicate reports',verdict:'pass',completion_payload:{...payload,criteria:[...payload.criteria,payload.criteria[0]]}}),/criterion_duplicate/));
  check('worker self certification rejected despite genuine file hash', () => assert.throws(() => store.recordAttempt(step.id, { what_tried: 'worker self', verdict: 'pass', completion_payload: { ...payload, criteria: payload.criteria.map(r => ({ ...r, reviewer: 'worker-self' })) } }), /orchestrator_acceptance_required/));
  check('serialized authority and boolean completion bypass rejected', () => {
    assert.throws(() => store.recordAttempt(step.id, { what_tried: 'forged capability', verdict: 'pass', completion_payload: payload }, { acceptance_authority: {} }), /orchestrator_acceptance_required/);
    assert.throws(() => store.setStepStatus(step.id, 'done', { validated_completion: true }), /completion_gate_rejected|orchestrator_acceptance_required/);
  });
  check('ordinary worker cannot drop mandatory join or erase contract', () => {
    assert.throws(() => store.updateStep(step.id, { acceptance_contract: { version: 1, criteria: contract.criteria.filter(c => c.id !== 'join') } }), /acceptance_contract_revision_required/);
    assert.throws(() => store.updateStep(step.id, { acceptance_contract: null }), /acceptance_contract_revision_required/);
    assert.equal(store.getStep(step.id).acceptance_contract.criteria.length, 3);
  });
  check('worker submission stays pending and cannot accept with claimed reviewer', () => {
    const submitted = store.submitCompletion(step.id, { completion_payload: payload, executor: 'worker' });
    assert.equal(submitted.status, 'pending_review'); assert.equal(store.getStep(step.id).status, 'pending');
    assert.throws(() => store.acceptCompletion(step.id, { ...submitted, reviewer: 'Nova', decision_ref: 'fake', reason: 'claim' }, { authority: {} }), /orchestrator_authority_required/);
    assert.throws(() => store.acceptCompletion(step.id, { ...submitted, reviewer: 'worker', decision_ref: 'self', reason: 'self' }, { authority: acceptanceAuthority }), /independent_reviewer_required/);
    store.submitCompletion(step.id, { completion_payload: payload, executor: 'worker' });
    assert.throws(() => store.acceptCompletion(step.id, { ...submitted, reviewer: 'Nova', decision_ref: 'stale', reason: 'old submission' }, { authority: acceptanceAuthority }), /acceptance_submission_stale/);
    assert.throws(() => store.reviseAcceptanceContract(step.id, {}), /orchestrator_authority_required/);
  });
  check('forced plan closure cannot bypass pending mandatory work',()=>assert.throws(()=>store.setPlanStatus(plan.id,'done',{force:true,reason:'bypass'}),/mandatory acceptance/));
  check('raw done cannot bypass criterion evidence', () => assert.throws(() => store.setStepStatus(step.id, 'done'), /completion_gate_rejected/));
  check('verified disposition cannot bypass evidence', () => assert.throws(() => store.setStepDisposition(step.id, { disposition: 'verified' }), /completion_gate_rejected/));
  await assert.rejects(initiateWorker(store, { packet, adapter: { kind: 'native-codex', run: () => {} } }), /external_dispatch_disabled/); checks++;
  const noReview = await initiateWorker(store,{packet,adapter:{kind:'offline-local',run:async()=>({completion_payload:payload})}});
  check('worker success without independent review does not pass',()=>{assert.equal(noReview.outcome,'partial');assert.equal(store.getStep(step.id).status,'pending');});
  packet=compileWorkerPacket(store,packetArgs);
  let release, entered;
  const started = new Promise(r => { entered = r; });
  const hold = new Promise(r => { release = r; });
  const run = initiateWorker(store, { packet, adapter: { kind: 'offline-local', run: async ({packet: received}) => { assert.equal(received.digest, packet.digest); entered(); await hold; throw new Error('simulated interruption'); } } });
  await started;
  await assert.rejects(initiateWorker(store, { packet, adapter: { kind: 'offline-local', run: async () => ({}) } }), /ownership_exists/); checks++;
  release(); const interrupted = await run;
  check('interruption closes lease without inventing success', () => { assert.equal(interrupted.outcome, 'failed'); assert.equal(store.listExecutionLeases({step_id:step.id,status:'open'}).length,0); assert.notEqual(store.getStep(step.id).status,'done'); });
  store.close(); store = new Store(db, { acceptanceAuthority }); packet = compileWorkerPacket(store, packetArgs);
  const routed = routeWorkerBlocker({ kind: 'missing_context', field: 'invite receipt', reason: 'Missing evidence' });
  check('missing evidence returns to planner without approval fiction', () => { assert.equal(routed.owner,'planner'); assert.equal(routed.requires_human_approval,false); });
  const denied = routeWorkerBlocker({ kind:'platform_denial', action:'production update', reason:'Denied by platform' });
  check('platform denial is binding and cannot be bypassed', () => { assert.equal(denied.denied_action_must_stop,true); assert.equal(denied.may_bypass,false); });
  const deniedResult = await initiateWorker(store, { packet, adapter: {kind:'offline-local',run:async()=>({blocker:{kind:'platform_denial',reason:'fixture platform denial'}})} });
  check('denial persists blocker and closes ownership',()=>{assert.equal(deniedResult.outcome,'blocked');assert.equal(store.getStep(step.id).status,'blocked');assert.equal(store.listExecutionLeases({step_id:step.id,status:'open'}).length,0);});
  check('denial cannot be silently resolved',()=>assert.throws(()=>resolveWorkerBlocker(store,{step_id:step.id,reason:'retry'}),/platform_restriction_binding/));
  resolveWorkerBlocker(store,{step_id:step.id,reason:'Resume only offline evidence assessment; production action remains forbidden',denied_action_remains_prohibited:true}); packet=compileWorkerPacket(store,packetArgs);
  const accepted=await initiateWorker(store,{packet,acceptanceAuthority,adapter:{kind:'offline-local',run:async()=>({completion_payload:payload,summary:'Offline fixture accepted'})},reviewEvidence:async({reviewer})=>reviewer==='Nova'});
  check('resumed local adapter succeeds with independent review',()=>{assert.equal(accepted.outcome,'success');assert.equal(store.getStep(step.id).status,'done');});
  check('evidence hash drift blocks plan closure',()=>{writeFileSync(join(root,'receipt.json'),'changed');assert.throws(()=>store.setPlanStatus(plan.id,'done'),/criterion_evidence_invalid/);});
  writeFileSync(join(root,'receipt.json'),receipt);store.setPlanStatus(plan.id,'done');
  const acceptedStep = store.getStep(step.id);
  const previousDigest = createHash('sha256').update(JSON.stringify(acceptedStep.acceptance_contract)).digest('hex');
  const revisionArgs = { acceptance_contract: { version: 1, criteria: contract.criteria.filter(c => c.id !== 'join') },
    expected_contract_digest: previousDigest, reviewer: 'Nova', decision_ref: 'test:explicit-scope-decision',
    reason: 'Fixture only: separately approved scope reduction', evidence: [{ path: 'receipt.json', sha256: hash }] };
  check('contract revision requires authority, decision and real evidence', () => {
    assert.throws(() => store.reviseAcceptanceContract(step.id, revisionArgs, { authority: {} }), /orchestrator_authority_required/);
    assert.throws(() => store.reviseAcceptanceContract(step.id, { ...revisionArgs, reason: '' }, { authority: acceptanceAuthority }), /contract_revision_decision_required/);
    assert.throws(() => store.reviseAcceptanceContract(step.id, { ...revisionArgs, evidence: [{ path: 'missing.json', sha256: hash }] }, { authority: acceptanceAuthority }), /contract_revision_evidence_invalid/);
  });
  check('audited revision invalidates old acceptance and reopens done plan', () => {
    store.reviseAcceptanceContract(step.id, revisionArgs, { authority: acceptanceAuthority });
    const revised = store.getStep(step.id);
    assert.equal(revised.acceptance_contract.revision, 2); assert.equal(revised.status, 'pending');
    assert.equal(revised.acceptance_decision, null); assert.equal(store.openPlan(plan.id).status, 'active');
    assert.ok(revised.notes.some(n => JSON.parse(n.body).event === 'acceptance_contract_revision'));
    assert.throws(() => store.setPlanStatus(plan.id, 'done', { force: true, reason: 'stale' }), /mandatory acceptance/);
    assert.throws(() => store.reviseAcceptanceContract(step.id, revisionArgs, { authority: acceptanceAuthority }), /contract_revision_stale/);
  });
  const legacy=store.createPlan({title:'Legacy deferred gate',project_id:project.id});const old=store.addStep(legacy.id,{title:'Manual verification'});store.setStepStatus(old.id,'done');store.setStepDisposition(old.id,{disposition:'deferred',reason:'untested journey'});
  check('direct and forced closure reject deferred gate',()=>{assert.throws(()=>store.setPlanStatus(legacy.id,'done'),/mandatory acceptance/);assert.throws(()=>store.setPlanStatus(legacy.id,'done',{force:true,reason:'attempted bypass'}),/mandatory acceptance/);});
  const legacy2=store.createPlan({title:'Deferred gate plus active work',project_id:project.id});const deferred=store.addStep(legacy2.id,{title:'Manual gate'});store.addStep(legacy2.id,{title:'Still pending'});store.setStepStatus(deferred.id,'done');store.setStepDisposition(deferred.id,{disposition:'deferred',reason:'untested'});
  check('force cannot hide deferred gate behind another blocker',()=>assert.throws(()=>store.setPlanStatus(legacy2.id,'done',{force:true,reason:'bypass'}),/mandatory acceptance/));
  check('legacy unknown remains unknown on reopen',()=>assert.equal(store.getStep(old.id).completion_validation_status,'legacy_unknown'));
  console.log(`planner handoff isolated pilot OK (${checks} checks); offline adapter only; native Codex and production unverified`);
} finally { store.close(); rmSync(root,{recursive:true,force:true}); }
