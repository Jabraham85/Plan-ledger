---
name: plan-ledger
description: Coordinate approved multi-step work through the ledger planner and truthful acceptance evidence.
---

Use the existing JSON CLI bridge at src/ledger-cli.mjs. Read docs/CODEX-PLANNER.md. Nova coordinates priorities and acceptance; the planner builds versioned worker context and initiates scoped workers. Store plans, attempts, blockers and evidence in the ledger, not a parallel state machine.

Use explicit project IDs when the ledger's current project differs from the workspace. Inspect the registered workspace with get_project_root and register an unset root with set_project_root. Record a verified reusable lesson with absorb_findings, linking the source step and evidence. Compile a later packet to check that the lesson reaches work with a relevant strict criterion.

Use planner_start to record internal research before implementation. In the local QA loop, feed an independently observed criterion failure and next action into the next scoped packet. Hold valid submissions when review is deferred. Use planner_handoff to read accepted evidence for the user and report the remaining blocker whenever readiness is false.

For substantial plans with separate outputs or checks, track research, implementation, QA, and handoff as distinct steps. Use planner_step_review to inspect submissions and corrective feedback. Trusted review can return a specific submission through requestCompletionRevision so the next packet carries its criterion feedback. A corrected packet still requires current evidence and independent acceptance.

Carry the actual user's authorization source and scope in the packet. A planner's delegated task is authoritative within that granted scope. Resolve routine choices through the named decision owner; missing evidence/context goes back to the planner, not automatically to the human for approval. Platform denials and required per-action approvals remain binding and cannot be delegated away.

Use strict acceptance_contract criteria for new work. Review each mandatory criterion against actual evidence. An owner CRUD test does not verify a teammate journey. Keep login, invitation acceptance and ticket creation/reopen separate. Record design choices with rationale; do not present proposed design or historical reports as current verification.

Never resume historical plans solely because they are active. No provider calls, live dispatch, deployments or access changes are authorized merely by a ledger status transition. Existing user authorization persists; do not repeatedly request it for routine in-scope work.

Workers submit criterion evidence with submit_completion; they do not certify themselves with record_attempt(pass). Claimed reviewer names never authorize acceptance. Trusted orchestrator wiring retains a non-serializable acceptance capability outside worker packets and calls acceptCompletion only after separately reviewing the actual evidence. Ordinary update_step cannot modify acceptance contracts; legitimate revisions require the trusted revision interface, explicit decision/rationale, hashed evidence and invalidate stale acceptance. Read the trust limitations in docs/CODEX-PLANNER.md: local process or direct database access is not a security boundary.

Current workflow: Nova/Codex with the ledger. There is no additional planning-provider dependency or activation gate. Packet and track future assignments, follow-ups and independent reviews before the parent dispatches them; retain honest parent-dispatched labels on historical backfills.
Nova communicates goals, priority, decisions and acceptance feedback through the existing orchestrator task and persistent ledger. Orchestrator owns packets, assignments, follow-ups, dependencies and reviews; parent executes platform operations from prepared requests and returns observed identities/results. Availability while connected does not establish an always-on daemon. This role clarification grants no security/provider authority.
