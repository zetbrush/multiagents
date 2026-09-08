# Autonomous execution implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task.

**Goal:** Execute an approved plan with one fixed-model worker, durable progress, bounded failures and explicit final review.

**Architecture:** Store a versioned execution contract and results alongside existing plan items. A dedicated module validates transitions and runs verification; the broker owns persistence. MCP exposes worker progress and coordinator decisions through distinct tools.

**Tech Stack:** TypeScript, Bun, SQLite, existing MCP SDK.

**Spec:** docs/superpowers/specs/2026-09-07-autonomous-execution-design.md

## Global constraints

- One sequential worker; preserve existing team mode.
- Explicit model, no automatic model changes in plan execution.
- Two failed verification attempts block an item until a coordinator decision.
- No silence-based completion or reviewer-absence approval.
- Persist original task, plan, results and blockers. Unknown usage remains unknown.
- No new dashboard or general rewrite.

### 1. Execution contract and verification

Files: shared/plan-execution.ts, tests/plan-execution.test.ts.

- [x] Write failing tests for invalid dependencies, cycles, invalid commands, sequential execution, decision gates, failure limit and result evidence.
- [x] Run `bun test tests/plan-execution.test.ts` and confirm failures.
- [x] Implement `validateExecutionPlan`, `transitionExecutionStep`, `runVerification` with typed contracts and bounded subprocess output stored in local files.
- [x] Run the tests to verify success.

Contract example: `{key: 'impl', label: 'Implement', files: ['src/**'], depends_on: [], acceptance: ['Behavior matches specification'], checks: [{argv: ['bun', 'test'], cwd: '.', timeout_ms: 60000}]}`.

### 2. Broker lifecycle and persistence

Files: broker.ts, shared/broker-client.ts, tests/plan-execution-broker.test.ts.

- [x] Add failing broker integration tests for real successful and failing verification processes, cross-session updates, restart recovery, explicit decisions and premature completion rejection.
- [x] Extend plan item storage with JSON execution metadata; validate before mutation and preserve legacy plans.
- [x] Add asynchronous verification endpoint and coordinator decision endpoint. Restrict worker writes to assigned items and prohibit bypass through legacy status updates.
- [x] Persist verification state before spawning; recover interrupted checks as incomplete.
- [x] Run integration tests against a temporary database.

### 3. Orchestrator and worker integration

Files: orchestrator/orchestrator-server.ts, orchestrator/launcher.ts, orchestrator/recovery.ts, adapters/base-adapter.ts.

- [x] Extend create_team with execution_mode and structured plan contract; reject missing explicit model and multiple workers before launch.
- [x] Store the plan before launch to prevent startup races; assign its items to the worker once its slot exists.
- [x] Expose verify_plan_step and resolve_plan_blocker; include criteria/results in get_plan.
- [x] Inject autonomous instructions and resume context. Disable escalation/decay, pause blocked execution, preserve original task.
- [x] Replace silence completion with diagnostic prompt; remove orphan approval.
- [x] Exercise tool integration with fake executable and add regression coverage.

### 4. Documentation and verification

Files: README.md, tests/model-routing.test.ts, tests/session-lifecycle.test.ts.

- [x] Document an executable create_team payload, worker/coordinator tool flow, subscription prerequisites and test limitations.
- [x] Verify unknown usage handling and deterministic model retention.
- [x] Run `bun test` and `bunx tsc --noEmit`; review diff for bypasses and regressions.
- [x] Attempt real CLI availability check; report missing authentication/model availability honestly.

## Validation et limites

Le test MCP utilise un faux exécutable AGY avec de vrais outils MCP, un vrai broker,
une écriture de fichier et de vrais contrôles. Le CLI `agy` est absent de cet
environnement ; aucune authentification Google ni disponibilité du modèle réel
n’a donc été validée. Les résultats finaux des commandes sont consignés dans
le compte rendu de livraison.
