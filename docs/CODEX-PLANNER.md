# Nova and the ledger planner

Nova coordinates priorities and reviews acceptance. The planner compiles a versioned per-step packet, initiates a worker through a supplied adapter, and owns ledger bookkeeping. Workers receive scope, the original user instruction reference and excerpt, granted actions, constraints, relevant context, decisions, findings, prior attempts, acceptance criteria and review ownership.

## Strict acceptance contracts

Use `acceptance_contract: {version:1, criteria:[{id,description,mandatory:true}]}` when creating a step with add_step (CLI or MCP). This opts the step into strict validation independently of the legacy off/warn/enforce rollout flag. Legacy steps are not upgraded or assigned new evidence. A completion payload v2 must include `criteria:[{id,status:"verified",reviewer:"Nova",evidence:[{path:"evidence/receipt.json",sha256:"<64 hex digits>"}]}]` for every mandatory criterion, in addition to artifacts, command results and limitations. Evidence files must exist under the registered project root, be at most 10 MiB, and match their hashes. Receipts describe what actually happened, identity/environment, commands/results and limitations. Hashes prove file identity, not whether a receipt's narrative is true: the independent review callback owns that check.

An untested or blocked mandatory criterion cannot pass. Direct done/skipped/verified writes cannot replace missing criterion evidence. Plan closure rejects blocked steps and deferred/manual dispositions, including force closure. Existing unknown evidence stays unknown. Changing a contract invalidates its stored completion payload. Closure rechecks receipts for drift. Do not mutate acceptance contracts merely to make a plan green.

## Interfaces

The JSON CLI supports `planner_packet` (step_id, authorization, goal, owned_paths, excluded_actions, context_refs, decision_refs, decision_owner, review_owner) and `planner_blocker_route`. The packet builder uses stepBrief, lessons, file references and carry-forward. Packet construction requires source_ref, user_instruction and granted_actions, supplied by the trusted initiating conversation; ledger text alone does not grant authority. The version/digest identify the brief and detect accidental change; they are not a signature or an authentication mechanism.

Use `list_projects` to identify the owning project, then `get_project_root` with its numeric `project_id`. If the root is unset, use `set_project_root` with the same ID and the absolute `root` path of the workspace. Both commands require the project ID so setup works without changing the current project. Packet compilation and local acceptance evidence use this registered root.

After verifying a reusable lesson, record it with `absorb_findings`, a source `step_id`, and evidence. A later packet searches the same project's findings using its title, context, legacy acceptance text, and strict criterion descriptions. Inspect the packet's `findings` to verify the lesson was retrieved. A recalled finding is context for the later step and its own acceptance still requires current evidence.

`src/planner-handoff.mjs` exports `initiateWorker(store,{packet,adapter,reviewEvidence,acceptanceAuthority})`. Only explicitly supplied offline-local adapters are enabled. No native Codex provider/CLI adapter or unattended dispatch is enabled. This is a tested local seam, not proof of native Codex launch. A real adapter must separately map platform controls, execution identity, cancellation and reporting before use. Never translate Claude bypassPermissions or Cursor trust/force flags into Codex authority.

The planner checks approval/readiness, opens the existing supervised lease, records the packet identity and authorization provenance, forwards the context and heartbeat helper, validates completion, requires independent reviewer acceptance, and terminalizes through the shared lifecycle. Unknown model identity is left unknown. An interrupted run closes without inventing success; an already owned step cannot launch again. A genuinely orphaned claim requires explicit existing recovery rather than automatic adoption by this interface.

## Research, implementation, and QA loop

Start with the user's goal and scope. Use `planner_start` to find prior plans and record the consultation on the new draft, then create strict steps. Each packet includes same-project consultation references alongside current findings, lessons, file references, and prior attempts. Historical results guide research and still require current verification.

For substantial work, give research and design, implementation, QA, and handoff their own steps when they have separate outputs or checks. Use `references` for informational provenance. The readiness check treats both `builds_on` and `blocks` as prerequisites whose target must be done or skipped.

Trusted local orchestrator code can call `runPlannerLoop(store, {packetArgs, adapter, reviewEvidence, acceptanceAuthority, maxAttempts})`. It uses the same supervised offline-local adapter as `initiateWorker`. The independent `reviewEvidence({packet, report, submission, reviewer})` callback reads the submitted evidence and returns one of these decisions.

- `{decision: 'accept', reason}` accepts the current submission through the trusted Store capability.
- `{decision: 'revise', reason, feedback: [{criterion_id, observation, next_action}]}` records a partial attempt tied to the submission. The next packet carries that feedback and refreshed research under the same grant and contract. Keep evidence receipts distinct across attempts so reviewers can still inspect rejected work.
- `{decision: 'defer', reason}` holds the submission for independent review. A new loop invocation leaves it pending for that review.

The default budget is three attempts per invocation, configurable from one to five. A trusted revision decision can trigger a retry. When the current run fails validation solely because a criterion receipt is missing or its hash differs, the loop can also recompile the same scoped packet with the validation errors and a corrective instruction under `validation_feedback`. The failed attempt stays in history. The new receipt still needs independent acceptance. Other validation failures, execution failures, blockers and exhausted budgets return control to the planner. Boolean callbacks to `initiateWorker` still work. The retry loop has no remote dispatch entry point.

Read the user handoff with `planner_handoff` and a numeric `plan_id`. It returns `ready:true` only for an approved plan whose strict steps all have current acceptance, valid receipt hashes, and no reconciliation blockers. The handoff includes review decisions, criterion evidence, artifacts, command exit codes, and limitations. In shadow terminalization mode an accepted plan can still have status `active`. The read-only command leaves closure to the existing plan policy.

Use `planner_step_review` with a numeric `step_id` to inspect the strict criteria, latest submission identity, receipt status, and any corrective feedback. The board shows the same projection on the step and links to the verified handoff from the plan. Pending evidence and revision requests identify the affected step and submission; the board has no authority to approve a submission or issue an independent revision decision.

For a submission made through `submit_completion` or `cloud_dispatch_submit`, trusted orchestrator code can call `store.requestCompletionRevision(stepId, { ...submission, reviewer, decision_ref, reason, feedback }, { authority })` after reading the actual evidence. The call validates the current submission ID, contract and payload digests, independent reviewer, and actionable criterion feedback. It records a partial attempt and invalidates the rejected submission for acceptance. A fresh packet includes the corrective feedback. Review can reject a submission whose receipt no longer matches, so the next attempt can produce current evidence.

## Decisions and blockers

Routine decisions within the evidenced user scope belong to the planner/decision owner, without repeated human permission requests. Missing context/evidence returns to the planner with kind, field, affected action, reason and next action. Scope changes go to Nova. Platform approval/denial remains binding: stop the affected action and continue only independently authorized work. No reassignment or alternate adapter may evade a denial.

`resolveWorkerBlocker` / `planner_resolve_blocker` records a reason and closes blocked activity before returning the step to pending. If a platform restriction was reported, the caller must explicitly preserve it (`denied_action_remains_prohibited:true`); this operation only permits independent authorized work, never the denied action. The adapter remains responsible for enforcing platform controls.

## Validation

`node test/planner-handoff.mjs` runs an isolated one-executor fixture with no providers or production. It covers omitted/untested criteria, missing files, raw-status and forced-closure bypass attempts, context/provenance transmission, duplicate ownership, interruption/reopen, blocker routing and denial persistence. It does not establish live teammate onboarding or native Codex dispatch.

`node test/planner-loop.mjs` checks a rejected result, feedback and research in a revised packet, independent acceptance, deferred review, platform denial, retry exhaustion, invalid feedback, and a handoff withheld after evidence drift.

## Acceptance authority and contract revisions

Worker-facing CLI/MCP expose submit_completion. A submission validates evidence structure and current local hashes, records the payload in an append-only note, and leaves the step pending review. Reviewer names inside worker reports are assertions, never authority. Contracted record_attempt(pass) rejects even structurally valid self-certification; passing legacy steps retains existing behavior.

Trusted orchestrator process wiring creates an opaque object and constructs Store(dbPath,{acceptanceAuthority}). It keeps that object away from adapters/workers. After separately reviewing the actual evidence, it calls acceptCompletion(stepId,{submission_id,reviewer,decision_ref,reason,contract_digest,payload_digest},{authority:acceptanceAuthority}). Acceptance binds the latest submission and exact current contract, overwrites asserted reviewer labels with the orchestrator decision, persists an acceptance decision, and records the passing attempt atomically. CLI, MCP, JSON packets and worker reports expose no acceptance token or acceptance/revision command. A caller-supplied reviewer string or JSON-shaped token cannot authorize acceptance. Reopening the Store requires trusted wiring again to make new decisions; persisted decisions remain readable and closure revalidates their payload/contract digests and files.

Ordinary update_step rejects contract edits, including removal. Trusted reviseAcceptanceContract requires the same opaque authority, expected current contract digest, reviewer, decision reference, rationale and existing hashed decision evidence. It appends before/after contracts with a monotonically increasing revision, clears prior acceptance and completion, returns the step to pending, and reopens a completed plan. Stale submissions, decisions and worker packets must be recompiled/reviewed.

This enforces intended application caller capabilities; it does not authenticate a human reviewer, independently establish that a review callback is honest, or secure a database against arbitrary same-process JavaScript, a new privileged Store, direct SQLite access or a machine user able to replace source. The trusted orchestrator and its independent evidence review remain the trust boundary. No machine permissions, credentials or platform approval behavior are changed. A production adapter must enforce worker isolation and platform restrictions independently; native dispatch remains unimplemented.

## Reopening and freshness

Contracted steps carry an acceptance_epoch. Status reopening, fail/partial attempts, redo, fresh claims (including lease adoption), failed/cancelled/blocked/abandoned lease closure, non-verified dispositions, new submissions and contract revisions advance that generation. They clear current acceptance/completion and append an acceptance_invalidated audit entry containing the prior decision; prior acceptance and submission notes remain unchanged. Submissions and decisions bind the generation, so an old note cannot be reaccepted after a failure even if its contract and file hashes still match. These checks and mutations are transactional.

An explicit evidence-only lease close with verification_state pending plus terminal_metadata.awaiting_acceptance:true and no attempt/verdict preserves a current unaccepted submission for later orchestrator review. It cannot preserve an already accepted decision. Actual failed work invalidates the generation. Neither case grants acceptance or permits plan closure.

## Cloud execution route

See [CLOUD-DISPATCH.md](CLOUD-DISPATCH.md) for the parent-owned cloud dispatch bridge and CLI lifecycle. The parent performs supported platform operations and reports traceable identities and status. The bridge records initiation and reconciliation. The test suite uses offline observations.

The supported-results extension captures independent fixture facts and supported parent task observations. It marks raw worker trace, read mechanism and unseen side effects as unavailable when the platform supplies only task output.

Current project-work integration uses Nova/Codex with the ledger. No additional planning-provider dependency, task, blocker or activation step is required. Carry the user's original instruction separately from delegated scope; packet and track assignments, follow-ups and reviews before parent dispatch. Historical implementation and source records remain historical evidence and do not add current prerequisites.

## Nova, orchestrator and worker communication

Nova supplies goals, priorities, decisions and acceptance feedback to the connected orchestrator. The orchestrator owns context packets, assignments, follow-ups, dependency resolution and independent reviews, persisting decisions and results in the ledger. The parent performs authorized platform operations from orchestrator-prepared requests and returns actual identities and results for reconciliation.

The connected task and persistent ledger carry coordination. After an interruption, reconcile existing request identities against observed platform status before preparing further work.
