# Phase 37 Completion Report — Autonomous Reconciliation-Conflict Arbitration

**Status**: Complete.

## Problem

See `docs/PHASE_37_PROPOSAL.md`. Phase 36 added an opt-in (`Task.autonomyLevel: "autonomous"`) that
let the orchestrator decide a direction itself instead of blocking, but scoped it to the routing
decision point only — reconciliation's material-conflict block was explicitly named out of scope and
carried forward as a next-milestone candidate. The developer picked it as the next phase.

## Implementation

### A. Type system (`server/src/types/index.ts`)

`AutonomousDecision.subject` widened from the single literal `"routing"` to
`"routing" | "reconciliation-conflict"`; `agents` made optional (only meaningful for `"routing"`);
new optional `conflictId` (only meaningful for `"reconciliation-conflict"`). Backward compatible —
every pre-existing `"routing"` record already has `agents` populated.

### B. Executor capability (`ClaudeCodeExecutor.ts`, `MockClaudeCodeExecutor.ts`,
`RealClaudeCodeExecutor.ts`)

`decideConflictResolution(params: ConflictResolutionParams): Promise<ConflictResolutionDecision>`
added to the executor interface — one call per conflict. `MockClaudeCodeExecutor`'s implementation
deterministically adopts whichever `ConflictParticipant` reported the highest confidence (fixed
confidence `0.4`, rationale prefixed `MOCK / SIMULATED EXECUTION`; falls back to a clearly-labeled
low-confidence "no participant available" response if `participants` is empty, rather than
throwing). `RealClaudeCodeExecutor`'s implementation shells out to the `claude` CLI with
`cwd: config.tasksDir` (same no-repository-access reasoning as `decideDirection()`), reusing
`REQUIREMENT_TRUST_FRAME` plus a new, analogous `CONFLICT_TRUST_FRAME` for the conflict's captured
specialist-report text, and validates the response (`resolution` non-empty, `confidence` a number)
before returning.

### C. Orchestrator integration (`taskOrchestrator.ts`)

`run()`'s existing `hasUnresolvedMaterialConflict(reconciliation)` block gained one condition:
if `task.autonomyLevel === "autonomous"`, call a new private `decideConflictsAutonomously()` first,
then **re-check** `hasUnresolvedMaterialConflict()` before deciding whether to block. The new helper
attempts each currently-unresolved material conflict independently — a resolved one gets its
`ReconciliationConflict.resolution` written (`resolvedBy: "autonomous-arbitration"`), its matching
entry removed from `reconciliation.unresolvedQuestions` (same `describeUnresolvedQuestion()`
computed-before-mutation convention the human-resolution route already uses), an `AutonomousDecision`
appended to `task.autonomousDecisions`, and an `AUTONOMOUS_DECISION_MADE` event published; a conflict
whose arbitration call throws is simply left unresolved. If every material conflict got resolved,
the outer re-check now passes and the pipeline falls through to `continueAfterReconciliation()`
exactly as the human `resumeAfterConflictResolution()` path already does — no new continuation logic
was needed, only reused. If anything remains unresolved, the task blocks with the same message as
before, now correctly scoped to whatever's actually still outstanding.

### D. Frontend

- `web/src/app/models/task.model.ts`: `AutonomousDecision` widened to match the backend exactly.
- `task-detail.component.html`'s "Autonomous Decisions" card (Phase 36) now branches on
  `decision.subject` — shows "Agents selected" only for `"routing"` and "Conflict resolved"
  (the conflict id) only for `"reconciliation-conflict"` — instead of unconditionally calling
  `.join()` on a now-optional field, which would have broken for this phase's decision shape.
  `resolvedBy: "autonomous-arbitration"` needed no other UI change: the existing reconciliation
  panel already renders `conflict.resolution.resolvedBy` as free text.

## Testing

New file `server/tests/autonomousConflictResolution.test.ts` (4 tests):

- 2 unit tests against `MockClaudeCodeExecutor.decideConflictResolution()` directly (adopts the
  higher-confidence participant; degrades gracefully with zero participants instead of throwing).
- An end-to-end test reusing the exact genuinely-disagreeing fixture pattern from
  `reconciliationConflict.e2e.test.ts` (two specialists materially disagree on a transaction
  decision), extended with a working `decideConflictResolution()`, driving the real
  `TaskOrchestrator` with `autonomyLevel: "autonomous"`: asserts the task reaches `"completed"`
  (not `"blocked"`), exactly one `AutonomousDecision` is recorded with `subject:
  "reconciliation-conflict"` and `conflictId` matching the real persisted conflict's `id`, the
  reconciliation artifact's `conflicts[0].resolution.resolvedBy` is `"autonomous-arbitration"`, and
  an `AUTONOMOUS_DECISION_MADE` event exists in the real event history.
- A failure-path test with a fixture whose `decideConflictResolution()` throws: asserts the task
  still blocks with the original `"...material engineering conflict..."` message, records zero
  decisions, and the conflict's `resolution` stays `null`.

All five pre-existing `ClaudeCodeExecutor` fixtures across other test files gained a
`decideConflictResolution()` stub for interface completeness (none exercise it) — the same
compile-time-only change Phase 36 already made for `decideDirection()`.

### Results

- `npm run build` (backend `tsc` + frontend `ng build`): pass, both clean.
- `npm run lint` (backend `tsc --noEmit`): pass.
- Backend `vitest`: **233 passed** (36 test files), up from 229 — the 4 new tests, zero regressions.
- Frontend `jest`: **64 passed** (5 test files) — unchanged; no existing spec exercises the new
  decision shape, and no new spec was needed since the template fix has no new branchable behavior
  a unit test would usefully isolate beyond what the backend E2E test already proves end to end.
- Manual real-HTTP validation was **not** performed for this phase specifically — see Known
  Limitations for why, and note this is the same pre-existing limitation the human-resolution
  conflict feature already has, not a new one introduced here.

## Known Limitations

- **No real-CLI validation of `decideConflictResolution()`.** Same category of gap as Phase 36's
  `decideDirection()` — both should be validated together against the actual `claude` CLI before
  relying on autonomous mode in real execution. Neither has been yet.
- **No manual live-server demonstration of this specific scenario.** The stock
  `MockClaudeCodeExecutor.analyze()` heuristic never produces genuinely conflicting specialist
  reports (by design), so reaching a material conflict at all — autonomous or human-resolved —
  requires a custom executor. The automated end-to-end test drives the real orchestrator/artifact
  store/event bus exactly as a live server would; this is the same validation posture the
  pre-existing `reconciliationConflict.e2e.test.ts` already has.
- **Review-stage conflict arbitration is still unimplemented.** A material conflict discovered
  during the review loop (after an implementation pass already ran) still always blocks, even under
  `autonomyLevel: "autonomous"` — deliberately out of scope this phase (see proposal §C).

## Next Recommended Milestone (proposed, not implemented)

1. **Real-CLI validation** of both `decideDirection()` (Phase 36) and `decideConflictResolution()`
   (this phase) together — the accumulating gap most worth closing before building further on top of
   either.
2. **Review-stage conflict arbitration** — extend the same pattern to `detectReviewConflicts()`'s
   block inside `reviewLoop()`, which is materially more complex (resolving it re-runs the entire
   planning→implement→review tail from scratch, same as the human path already does).
3. **Greenfield backlog decomposition** — the other Phase 36 candidate, still not chosen or built.
