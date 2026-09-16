# Phase 31 Implementation Plan — Task Retry & Startup Crash Recovery

**Status**: approved, in progress. Derived from `docs/PHASE_31_PROPOSAL.md` (the accepted spec) and
`docs/PHASE_31_ARCHITECTURE_REVIEW.md` after re-verifying both against the current `main` branch
(commit `d87788d`, Phase 30 complete). No architectural drift was found — the proposal's file-level
claims (`Task` shape, `ArtifactStore` layout, `TaskOrchestrator.run()`/`continueAfterReconciliation()`,
`routes/tasks.ts`'s `/start`/`/cancel` shape, `GitWorktreeManager.prepare()`'s force-recreate
self-healing) all match the code read during verification. This document only fills in the
mechanical details the proposal left to implementation judgment.

## Verified assumptions (re-checked against current code)

- `GitWorktreeManager.prepare()` (`server/src/execution/gitWorktree.ts`) already force-prunes and
  `worktree remove --force`s any existing worktree at `tasks/<id>/workspace` before `worktree add
  -B <branch>` from a freshly re-read `HEAD`. This runs unconditionally on every real-mode
  `run()` call, including a retried one — retry needs **no new guard** for workspace staleness,
  only needs to make sure `run()` is invoked again exactly the way a fresh task invokes it.
- `TaskOrchestrator.run()` re-derives everything from `Task` + live repository state and has no
  attempt-aware branching — safe to call unmodified after `retry()` resets task fields.
- `continueAfterReconciliation()` (Phase 30) is the shared planning→handoff tail; unchanged.
- `ArtifactStore` has no existing archiving/versioning concept; `archiveAttempt()` is additive.
- The event log (`events.log.jsonl`) is append-only via `TaskEventBus.publish()` →
  `ArtifactStore.appendEvent()`; nothing about retry needs to touch that path except adding
  `TASK_RETRIED` publishes through the existing mechanism.

## Design decisions filled in beyond the proposal's text

1. **`TaskOrchestrator.retry(taskId): Promise<void>` is awaited by the route, but `run()` itself is
   fired without awaiting from inside `retry()`.** This lets the archive-then-reset step (fast,
   local filesystem) be a real precondition the HTTP response reflects (archive failure -> the
   route's `await` rejects -> 500, task untouched), while the multi-minute pipeline itself stays
   fire-and-forget, matching `/start`'s existing shape and proposal section 8's "do not block the
   HTTP request while the complete pipeline executes."
2. **Two new orchestrator-level error classes**, `TaskNotFoundError` and `RetryNotAllowedError`,
   thrown by `retry()` for its precondition checks and mapped to 404/409 in the route handler —
   mirrors how `ApiError` is already used at the route layer, but keeps the precondition table unit
   -testable directly against `TaskOrchestrator.retry()` without an HTTP layer (proposal section 25).
3. **Archive-failure determinism in tests**: rather than mocking `fs`, the archive-failure test
   pre-creates a directory at the destination path a source file would be renamed to (e.g.
   `attempts/1/reconciliation.json/` as a directory), so `rename()` genuinely fails with `EISDIR`/
   `ENOTEMPTY` — a real filesystem condition, not a simulated one.
4. **Previous-attempt read endpoints always try all three `AgentType`s** (not `task.selectedAgents`,
   which reflects the *current* attempt's routing and may differ from an archived attempt's
   routing) and filter out agents that produced no artifact for that attempt — same pattern
   `ArtifactStore.readSpecialistReports` already uses for the live case.
5. **Startup sweep is a standalone function** (`server/src/startup/recoverOrphanedTasks.ts`,
   `recoverOrphanedTasks(taskStore, artifacts, events): Promise<number>`) called from `index.ts`
   before `app.listen()`, not wired into `container.ts` — so it runs exactly once per real process
   boot and is independently callable from tests (simulating "a fresh app boot" the same way
   `reconciliationApi.test.ts`/`memoryLoop.e2e.test.ts` simulate a fresh `createApp()`, without
   needing to actually bind a port in the test process).
6. **`Task.attempt` migration for pre-Phase-31 data**: `JsonFileTaskStore` defaults `attempt` to `1`
   for any record loaded without the field, so existing `data/tasks-index.json` / `tasks/<id>/task.json`
   files from before this phase don't crash on load.

## File-by-file change list

**Backend**
- `server/src/types/index.ts` — `Task.attempt: number`, `EventType` gains `"TASK_RETRIED"`.
- `server/src/store/jsonFileTaskStore.ts` — default `attempt: 1` on load if absent.
- `server/src/artifacts/artifactStore.ts` — `archiveAttempt()`, `listAttempts()`, and
  `readArchived*()` mirrors of every existing per-artifact reader; `readLatestReviews` refactored
  to share logic with the new `readArchivedReviews` via a private `readReviewsFrom(dir, agents)`.
- `server/src/orchestrator/taskOrchestrator.ts` — `retry()`, `TaskNotFoundError`,
  `RetryNotAllowedError`, exported `RETRYABLE_STATUSES`.
- `server/src/startup/recoverOrphanedTasks.ts` — new.
- `server/src/index.ts` — calls the sweep before `app.listen()`.
- `server/src/routes/tasks.ts` — `POST /tasks/:id/retry`, `GET /tasks/:id/attempts`,
  `GET /tasks/:id/attempts/:attempt/{agents,reconciliation,implementation-plan,execution-report,reviews,handoff}`;
  `attempt: 1` set at task creation.

**Frontend**
- `web/src/app/models/task.model.ts` — mirror `attempt`, `TASK_RETRIED`.
- `web/src/app/services/task.service.ts` — `retryTask()`, `listAttempts()`, archived-attempt
  getters.
- `web/src/app/pages/task-detail/task-detail.component.ts`/`.html` — Retry button
  (failed/blocked/cancelled only), previous-attempts collapsed section, read-only archived-attempt
  view.

**Tests** (see proposal's Testing Strategy section — implemented 1:1, file names chosen to match
existing per-concern test file conventions in `server/tests/`).

**Docs**: `README.md`, `docs/AGENT_WORKFLOW.md`, `docs/API.md`, `docs/adr/0007-retry-restarts-from-inspection.md`,
`docs/PHASE_31_COMPLETION_REPORT.md` (written after implementation + validation, not before).

## Non-goals carried over unchanged from the proposal

No new `TaskStatus`, no fine-grained resume, no automatic retry, no rate limiting, no workspace
retention policy, no candidate-lesson deduplication, no multi-user attribution. See proposal
"Explicit non-goals" — unchanged.
