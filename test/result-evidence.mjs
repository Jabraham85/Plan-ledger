import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/db.mjs';
import { prepareCloudDispatch, requestCloudDispatch, reconcileCloudDispatch, submitCloudDispatch } from '../src/cloud-dispatch.mjs';
import { captureCloudResultEvidence, verifyCloudResultEvidence, RESULT_CRITERIA } from '../src/result-evidence.mjs';
import { compileWorkerPacket } from '../src/planner-handoff.mjs';
const root = mkdtempSync(join(tmpdir(), 'ledger-supported-results-'));
process.env.PLAN_LEDGER_ROLES = join(root, 'no-roles');
process.env.PLAN_LEDGER_CURSOR_MODELS = 'offline-fixture';
process.env.PLAN_LEDGER_COMPLETION_GATE = 'off';
const authority = Object.freeze({});
const db = join(root, 'test.db');
const store = new Store(db, { acceptanceAuthority: authority });
const project = store.createProject({ name: 'Offline result contract' }); store.setProjectRoot(project.id, root);
const source = 'LEDGER_RESULT_V1\nmarker=fixture-marker\n';
writeFileSync(join(root, 'source.txt'), source);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const result = { source_path: join(root, 'source.txt'), sha256: sha(source), byte_count: Buffer.byteLength(source), content_marker: 'fixture-marker', limitations: ['No raw task trace supplied'] };
const evidenceContract = { version: 1, kind: 'sha256_fixture', input_path: 'source.txt', observability_policy: 'supported_task_outputs_only', raw_trace_required: false, side_effect_assertion: 'unseen_activity_not_verified' };
const authorization = { source_ref: 'test:original-human-message', user_instruction: 'Implement the ledger integration',
  granted_actions: ['read source.txt','return structured facts'], constraints: ['no writes by worker'],
  delegation: { source_ref: 'test:parent-delegation', instruction: 'Run bounded fixture result comparison' },
  additional_user_authorizations: [{ source_ref: 'test:latest-human-message', quote: 'Finish the remaining ledger work' }] };
let serial=0, checks=0;
function fresh(supported=true) {
 const plan=store.createPlan({title:'Supported result fixture',project_id:project.id});
 const step=store.addStep(plan.id,{title:'Compare reported facts',context:'Result contract only; raw activity unknown',
  acceptance_contract:{version:1,criteria:(supported?RESULT_CRITERIA:['actual_fixture_read','observed_read_only_scope']).map(id=>({id,description:'Original explicit criterion '+id}))}});
 store.setPlanStatus(plan.id,'active');
 const args={step_id:step.id,client_key:'result-fixture-'+ ++serial,authorization,owned_paths:['source.txt'],excluded_actions:['writes','network','production'],pilot_version:2,...(supported?{result_evidence_contract:evidenceContract}:{})};
 const prepared=prepareCloudDispatch(store,args);
 const requested=requestCloudDispatch(store,{request_id:prepared.request_id});
 const observation={status:'completed',thread_id:'mock-offline-thread-'+serial,turn_id:'mock-offline-turn-'+serial,tool_name:'cloud_threads.fixture',
  source_ref:'test:mock-supported-read',observed_at:'2026-10-11T12:00:00Z'};
 const dispatch=reconcileCloudDispatch(store,{request_id:requested.request_id,observation});
 return {plan,step,dispatch,args};
}
const captureArgs = f => ({request_id:f.dispatch.request_id,result_data:result,result_source_ref:'test:mock-final-message',result_message_id:'mock-final-message-'+f.step.id,visibility:{mode:'task_outputs_only',raw_worker_trace_available:false}});
const check=(name,fn)=>{fn();checks++;console.log('ok '+name);};
try {
 const f=fresh();
 check('packet preserves human quotation separately from parent-derived scope',()=>{
  const a=f.dispatch.packet.authorization;assert.equal(a.user_instruction,'Implement the ledger integration');assert.equal(a.delegation.scope_origin,'parent-derived');assert.equal(a.additional_user_authorizations[0].quote,'Finish the remaining ledger work');
 });
 check('unsupported original trace contract cannot be captured or retroactively passed',()=>{const old=fresh(false);assert.throws(()=>captureCloudResultEvidence(store,captureArgs(old)),/supported_result_contract_required/);assert.equal(store.getStep(old.step.id).acceptance_decision,null);});
 check('contract claiming full trace or unseen side-effect proof rejects',()=>assert.throws(()=>compileWorkerPacket(store,{...f.args,result_evidence_contract:{...evidenceContract,raw_trace_required:true}}),/supported_result_contract_required/));
 check('an existing file outside the workspace remains rejected',()=>{
  const outside = root + '-outside.txt';
  writeFileSync(outside, source, { flag: 'wx' });
  try {
   assert.throws(()=>captureCloudResultEvidence(store,{...captureArgs(f),result_data:{...result,source_path:outside}}),/result_path_outside_workspace/);
  } finally { rmSync(outside); }
 });
 for(const field of ['sha256','byte_count','content_marker'])check('wrong '+field+' independently rejects',()=>assert.throws(()=>captureCloudResultEvidence(store,{...captureArgs(f),result_data:{...result,[field]:field==='byte_count'?99:'wrong'}}),/independent_comparison_failed/));
 check('capture needs actual bound identity, result reference and visibility limits',()=>{
  assert.throws(()=>captureCloudResultEvidence(store,{...captureArgs(f),result_message_id:''}),/message_id_required/);
  assert.throws(()=>captureCloudResultEvidence(store,{...captureArgs(f),visibility:{mode:'task_outputs_only',raw_worker_trace_available:true}}),/visibility_limits_required/);
 });
 const captured=captureCloudResultEvidence(store,captureArgs(f));
 check('receipt verifies output facts and explicitly leaves worker mechanism/activity unknown',()=>{
  const receipt=JSON.parse(readFileSync(join(root,captured.receipt.path),'utf8'));assert.equal(receipt.independently_compared_file_facts.sha256,result.sha256);
  assert.equal(receipt.visibility.unseen_side_effects,'not_verified');assert.equal(receipt.visibility.raw_worker_tool_trace,'not_observed');assert.equal(receipt.visibility.proof_of_worker_read_mechanism,'not_established_by_result_match');assert.equal(captured.criterion_acceptance,false);
 });
 check('identical capture retries preserve immutable receipt',()=>{const again=captureCloudResultEvidence(store,captureArgs(f));assert.equal(again.reused,true);assert.equal(again.receipt.sha256,captured.receipt.sha256);});
 check('different result source cannot overwrite receipt',()=>assert.throws(()=>captureCloudResultEvidence(store,{...captureArgs(f),result_message_id:'different'}),/already_exists_with_different_evidence/));
 const submitted=submitCloudDispatch(store,{request_id:f.dispatch.request_id,completion_payload:captured.completion_payload,report_source_ref:'test:actual-mock-result-reference'});
 check('captured result submits pending review and cannot self-certify',()=>{assert.equal(store.getStep(f.step.id).status,'pending');assert.equal(submitted.submission.status,'pending_review');
 assert.throws(()=>store.recordAttempt(f.step.id,{what_tried:'self',verdict:'pass',completion_payload:captured.completion_payload}),/orchestrator_acceptance_required/);});
 const verifyArgs={request_id:f.dispatch.request_id,receipt_path:captured.receipt.path,receipt_sha256:captured.receipt.sha256};
 check('independent recheck works after evidence submission without granting acceptance',()=>{const review=verifyCloudResultEvidence(store,verifyArgs);assert.equal(review.ok,true);assert.equal(review.criterion_acceptance,false);assert.equal(store.getStep(f.step.id).acceptance_decision,null);});
 check('source drift invalidates independent result review',()=>{writeFileSync(join(root,'source.txt'),'LEDGER_CHANGED\nmarker=fixture-marker\n');assert.throws(()=>verifyCloudResultEvidence(store,verifyArgs),/independent_comparison_failed/);writeFileSync(join(root,'source.txt'),source);});
 const receiptPath=join(root,captured.receipt.path), original=readFileSync(receiptPath);
 check('receipt hash drift rejects',()=>{writeFileSync(receiptPath,'changed');assert.throws(()=>verifyCloudResultEvidence(store,verifyArgs),/hash_mismatch/);writeFileSync(receiptPath,original);});
 for(const change of ['unseen_activity','file_facts','limitations'])check('rehashing forged '+change+' cannot upgrade evidence',()=>{
  const receipt=JSON.parse(original);
  if(change==='unseen_activity')receipt.visibility.unseen_side_effects='verified_absent';
  if(change==='file_facts')receipt.independently_compared_file_facts.byte_count=999;
  if(change==='limitations')receipt.limitations=[];
  const text=JSON.stringify(receipt);writeFileSync(receiptPath,text);
  assert.throws(()=>verifyCloudResultEvidence(store,{...verifyArgs,receipt_sha256:sha(text)}),/binding_invalid/);writeFileSync(receiptPath,original);
 });
 check('explicit independent review then capability acceptance closes this new outcome contract only',()=>{
  assert.equal(verifyCloudResultEvidence(store,verifyArgs).ok,true);
  store.acceptCompletion(f.step.id,{...submitted.submission,reviewer:'Nova',decision_ref:'test:independent-supported-results-review',reason:'Verified declared result/identity/limits; no claim of raw trace or all side-effect absence'},{authority});
  store.setPlanStatus(f.plan.id,'done');assert.equal(store.getStep(f.step.id).status,'done');
 });
 const cli=spawnSync(process.execPath,[resolve('src/ledger-cli.mjs'),'ledger_runtime','--input','{}'],{encoding:'utf8',env:{...process.env,PLAN_LEDGER_DB:db}});
 check('loaded CLI runtime exposes diagnostic identity without auth/config values',()=>{
  assert.equal(cli.status,0,cli.stderr);const info=JSON.parse(cli.stdout).result;assert.equal(info.build_id,'nova-ledger-supported-results-v1');
  assert.ok(info.capabilities.includes('supported_task_result_evidence'));assert.ok(/^[a-f0-9]{64}$/.test(info.startup_source_fingerprint));assert.ok(!('environment' in info));
 });
 console.log('supported result evidence OK ('+checks+' scenarios); offline identities/results only');
}finally{store.close();rmSync(root,{recursive:true,force:true});}
