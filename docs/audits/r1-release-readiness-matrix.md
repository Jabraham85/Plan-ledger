# R1 Release Readiness Matrix

Generated: 2026-08-12T06:08:45.750Z

| Area | Checks | Evidence Commands | Status |
|---|---|---|---|
| C1 evidence gate | completion payload gate; legacy_unknown semantics | node test/completion-gate.mjs<br>node benchmarks/completion-validator.mjs | PASS |
| C2 terminalization integrity | reconciliation blockers; close-path atomicity; migration additive/idempotent | node test/terminalization-reconciliation.mjs<br>node test/execution-lifecycle.mjs<br>node benchmarks/reconciliation-latency.mjs | PASS |
| C3 dispatch/recovery | policy mismatch enforcement; deadline semantics; bounded/atomic reassignment; migration additive/idempotent | node test/dispatch-policy.mjs<br>node test/stale-recovery.mjs<br>node benchmarks/c3-dispatch-recovery.mjs | PASS |
| C4 telemetry/board health | ordered events; pre-v13 upgrade; marker semantics; health API/UI; migration/additive compatibility | node test/c4-pre-v13-upgrade.mjs<br>node test/c4-telemetry-health.mjs<br>node test/live-activity-ui.mjs<br>node test/board-routes.mjs<br>node benchmarks/non-planner-latency.mjs | PASS |
| CLI/MCP compatibility | ledger CLI bridge; MCP e2e contract | node test/ledger-cli.mjs<br>node test/mcp-e2e.mjs | PASS |

Run command: `node scripts/r1-release-validation.mjs`
