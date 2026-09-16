# Phase 32 Completion Report — Manual Workspace Cleanup

## Status

**Complete.** Approved design: `docs/PHASE_32_PROPOSAL.md`, informed by
`docs/PHASE_32_ARCHITECTURE_REVIEW.md`. Decision record: `docs/adr/0008-manual-workspace-cleanup.md`.

## Data model

`RealExecutionWorkspace` (`server/src/types/index.ts`, mirrored in `web/src/app/models/task.model.ts`)
gains three optional fields — no new `TaskStatus`, no new store, no migration write:

```ts
cleanupStatus?: "ready" | "cleaned" | "cleanup_failed";
cleanedAt?: string;
cleanupError?: string;
```

Absence is treated as `"ready"` everywhere it's read. Unlike Phase 31's `attempt` field (which
needed a load-time migration default because it's non-optional and used in arithmetic), nothing
here requires a non-optional value to render or evaluate correctly, so no migration code was added.

Two new `EventType` values: `WORKSPACE_CLEANED`, `WORKSPACE_CLEANUP_FAILED` — mirroring the existing
`WORKSPACE_PREPARED`/`WORKSPACE_PREPARATION_FAILED` pair.

## API

`POST /tasks/:id/cleanup-workspace` — no request body; every path/branch value is derived
server-side from `Task.executionWorkspace`, never from client input.

- `200` — cleaned. Body: `{ task }` with `executionWorkspace.cleanupStatus: "cleaned"`, `cleanedAt` set.
- `404` — unknown task.
- `409` — nothing eligible to clean up (see Eligibility policy below), including "already cleaned"
  and "cleanup already in progress for this task."
- `500` — the underlying git removal genuinely failed. `executionWorkspace.cleanupStatus` becomes
  `"cleanup_failed"` with `cleanupError` set; `Task.status`/`Task.error` are untouched.

Documented in `docs/API.md`.

## Eligibility policy

Enforced in `TaskOrchestrator.cleanupWorkspace()` (`server/src/orchestrator/taskOrchestrator.ts`),
not only in the UI:

```
task exists
+ not already cleaning up (in-process concurrency guard)
+ executionMode === "real"
+ executionWorkspace exists and status === "ready"
+ executionWorkspace.cleanupStatus !== "cleaned"
+ status !== "blocked"
+ status ∈ { completed, failed, cancelled }  (WORKSPACE_CLEANUP_ELIGIBLE_STATUSES)
+ workspacePath/branch match deriveWorkspaceLocation(taskId, tasksDir)  (defense in depth)
```

## Git cleanup

Reuses `GitWorktreeManager.remove()` (`server/src/execution/gitWorktree.ts`) unmodified in shape
(`git worktree remove --force` + `git branch -D`). One targeted behavioral change was required: the
method previously swallowed every git failure (`.catch(() => undefined)` on each step) — safe for
its only prior caller (its own test), unusable for a developer-facing action that must be able to
report whether cleanup actually worked. It now:

- Throws `GitWorktreeError` on a genuine failure (verified with a real, deterministic failure — a
  directory that exists on disk but was never registered as a worktree — not a mock).
- Stays safely idempotent: a worktree directory or branch that's already gone is treated as
  already-clean, not as an error, so calling it twice never fails on that account.

`GitWorktreeManager.prepare()`'s own inline self-healing removal (used when a stale worktree exists
at task-start time) is separate code and was not routed through `remove()`, so this change carries
no risk to Phase 28/31 behavior. `deriveWorkspaceLocation(taskId, tasksDir)` was extracted from
`prepare()` so cleanup's ownership check and `prepare()`'s own path computation can never drift
apart.

## Blocked-task safety

The one hard correctness rule this phase introduces: cleanup is refused, server-side, for any
`blocked` task. `resumeAfterConflictResolution()` reaches `implement()` without ever re-preparing a
workspace — it reads `task.executionWorkspace.workspacePath` as set when the task first blocked.
Deleting that worktree while `blocked` would silently break Phase 30's conflict-resolution feature
for real-mode tasks. Verified directly: `server/tests/workspaceCleanup.test.ts`'s
"Blocked-task regression" test runs a real conflict to a genuine `blocked` status, confirms cleanup
is rejected and the worktree/branch are provably untouched via real git commands, then resolves the
conflict and confirms `resumeAfterConflictResolution()` still completes successfully against that
exact, never-recreated workspace.

## Retry interaction

Unchanged, by construction. `GitWorktreeManager.prepare()` already treats "nothing at this path" as
its normal case (`if (existsSync(workspacePath))`, not an assumption it exists), so a manually
cleaned workspace and one that was never prepared behave identically on the next retry. Verified in
`workspaceCleanup.test.ts`'s "Retry after manual cleanup" test: clean up a `failed` task's
workspace, retry it, and confirm a fresh workspace is prepared normally while task artifacts
(handoff, archived attempt 1) remain fully readable throughout.

## Crash recovery interaction

`recoverOrphanedTasks()` (`server/src/startup/recoverOrphanedTasks.ts`) is **unmodified**. It never
reads `Task.executionWorkspace` and never touches the filesystem beyond the JSON task store — an
orphaned real-mode worktree from a crashed mid-flight task is left exactly where it was, retained
for debugging, and becomes cleanable through the normal manual path once the sweep marks the task
`failed`. No `cleanup_pending` state was introduced; `status: "failed"` plus
`executionWorkspace.cleanupStatus` (absent, i.e. `"ready"`) already fully describes "this failed
task has an uncleaned workspace."

## UI

`web/src/app/pages/task-detail/task-detail.component.{ts,html,css}` extend the existing "Execution
Workspace" panel:

- `[ Cleanup Workspace ]` renders only when `canCleanupWorkspace()` — the same
  `executionMode/status/cleanupStatus` conditions the server enforces, mirrored client-side purely
  for UX (the server is the actual gate).
- Clicking it shows an inline confirmation naming exactly what happens: the worktree and branch are
  removed, unmerged changes are permanently lost, task artifacts are unaffected, and the developer's
  own repository is never touched. `[ Confirm Cleanup ]` / `[ Cancel ]`.
- A `cleaned` workspace renders "Cleaned" with the timestamp and the branch marked `(deleted)`; a
  `cleanup_failed` workspace renders the error and lets the developer retry.

## Confirmation UX

Not a native `window.confirm()` (none exists elsewhere in this codebase, and it's harder to test) —
a two-step in-component signal toggle (`confirmingCleanup`), matching this project's existing
signals-only state pattern (`Component OnDestroy` note in the phase prompt: no imperative
subscription-based state was introduced).

## Artifact retention

Verified, not assumed: every workspace-cleanup test that reaches a `cleaned` state also asserts
`ArtifactStore` reads (`readFinalHandoff`, `listAttempts`, `readEvents`) still succeed afterward,
and the manual HTTP validation below directly inspected the `tasks/<id>/` directory post-cleanup to
confirm `task.json`, `events.log.jsonl`, `specialist-reports/`, `reviews/`, and `context/` all
survived while only `workspace/` was gone.

## Cleanup failure handling

`cleanupWorkspace()` catches the `GitWorktreeError` from `GitWorktreeManager.remove()`, persists
`cleanupStatus: "cleanup_failed"` / `cleanupError` on the task, publishes `WORKSPACE_CLEANUP_FAILED`,
and re-throws as `WorkspaceCleanupFailedError` (mapped to HTTP `500`) — `Task.status`/`Task.error`
are never touched in this path. Verified with a genuinely forced failure (an unregistered directory
at the expected workspace path), not a stub.

## Concurrency / idempotency

An in-process `Set<string>` (`cleanupInProgress`) on `TaskOrchestrator`, following the same
synchronous test-and-set pattern `RealClaudeCodeExecutor` already uses for
`cancelRequested`/`activeProcesses` — no distributed lock. Verified with two real, racing
`cleanupWorkspace()` calls for the same task (`Promise.allSettled`): exactly one fulfills, exactly
one rejects, and the underlying git removal happens exactly once. A separate test confirms cleaning
up one task's workspace never touches a second, concurrently-active task's workspace.

## Testing

22 new backend tests, 11 new frontend tests.

- `server/tests/gitWorktree.test.ts` (+2, 11 total): `remove()` is idempotent; `remove()` now
  surfaces a genuine, deterministic removal failure instead of swallowing it.
- `server/tests/workspaceCleanup.test.ts` (new, 15): full eligibility matrix (completed/failed/
  cancelled eligible; blocked/in-flight/mock-mode/no-workspace/failed-preparation/unknown-task/
  already-cleaned all rejected, each verified against real git or persisted state, not just a
  thrown error type) · cleanup-failure isolation from task status · same-task concurrency ·
  cross-task isolation · the blocked-task regression (refused, then resolve+resume still succeeds
  against the untouched workspace) · retry after manual cleanup.
- `server/tests/cleanupWorkspaceApi.test.ts` (new, 5): the same success/blocked/already-cleaned/
  mock-mode/unknown-task cases through the actual Express route and HTTP status codes, with a real
  git-backed workspace attached via the same synthetic-state technique `retryApi.test.ts` and
  `reconciliationApi.test.ts` already established for this codebase's API-layer tests.
- `web/src/app/pages/task-detail/task-detail.component.spec.ts` (+11, 33 total in this file): an
  8-case visibility matrix (status × executionMode × workspace status × cleanupStatus) ·
  confirm/cancel flow · success rendering · failure rendering.

## Real Git validation

Every backend test above that claims a worktree or branch was removed (or, for the negative cases,
was *not* removed) asserts it via actual `git worktree list` / `git branch --list` /
`existsSync()` output — never the application's own self-report alone. This follows the same
convention established in `gitWorktree.test.ts` (Phase 28) and `taskRetryRealMode.test.ts`
(Phase 31).

## Manual validation

Performed against a genuinely running server process (`node dist/index.js`, not `vitest`), driven
entirely over real HTTP with `curl`, with a real scratch git repository:

1. Started the built server, created a task via `POST /api/tasks`, started it (mock mode).
2. Stopped the server; used a small script to call the real `GitWorktreeManager.prepare()` against
   a scratch repository and patch the on-disk task record to `executionMode: "real"`, `status:
   "completed"`, with the resulting `executionWorkspace` attached (mirroring the same technique
   used for Phase 31's manual crash-recovery validation, since there is no `claude` CLI available
   in this environment to reach a genuine real-mode terminal status).
3. Restarted the server; `GET /api/tasks/:id` confirmed the real workspace, and `git worktree
   list`/`git branch --list` in the scratch repo independently confirmed it existed on disk.
4. `POST /api/tasks/:id/cleanup-workspace` → `200`, `cleanupStatus: "cleaned"`.
5. Independently re-verified: `git worktree list` no longer listed the workspace, `git branch
   --list` for the task branch returned nothing, the workspace directory itself was gone from
   disk, `task.json`/`events.log.jsonl`/`specialist-reports/`/`reviews/`/`context/` all remained
   under `tasks/<id>/`, the events log contained a `WORKSPACE_CLEANED` entry, and the developer's
   own scratch repository was untouched (`git status --porcelain` clean, still on `main`).
6. A second `POST .../cleanup-workspace` call returned `409` ("already been cleaned up").

**Limitation, stated honestly**: a literal browser click-through of the `[ Cleanup Workspace ]`
button was not performed in this session — no browser-automation tool was available, and the
committed Playwright suite runs exclusively against the mock executor (per
`e2e/package.json`'s own description), so it has no way to reach a real-mode workspace without
either a live `claude` CLI or the same out-of-band state injection used for the manual HTTP
validation above, which would test the injection technique more than the feature. The frontend
component tests (11, listed above) exercise the same DOM/click/confirmation logic Playwright would
exercise, and the manual HTTP validation exercises the real backend + real git path end to end;
between the two, the button's own click handler is the only piece neither covers directly.

## Documentation

Updated: `README.md` (test badge/counts, feature bullet), `docs/REAL_EXECUTION.md` (rewrote
`## Cleanup` from "future work" to the actual, now-implemented policy), `docs/API.md` (new
endpoint, event types, `executionWorkspace` shape), `docs/AGENT_WORKFLOW.md` (new section relating
cleanup to retry). Created: `docs/adr/0008-manual-workspace-cleanup.md`,
`docs/PHASE_32_ARCHITECTURE_REVIEW.md`, `docs/PHASE_32_PROPOSAL.md`, this report.

## Validation

```
npm test        →  242/242 passing (198 backend + 44 frontend)
npm run test:e2e →  1/1 passing (Playwright, mock executor)
npm run build (server: tsc)  →  clean
npm run build (web: ng build) →  clean
npm run lint (server: tsc --noEmit) →  clean
```

Test count progression: 210 (post-Phase 31) → 243 (198 + 44 + 1), +33 new tests this phase (22
backend + 11 frontend).

## Known limitations

- No time-based or automatic retention — disk usage from workspaces a developer never explicitly
  cleans up remains unbounded, an accepted trade-off documented in ADR 0008.
- Cleanup removes the branch along with the worktree; there is no "keep a diffless branch pointer"
  partial mode (considered and rejected in the architecture review — see ADR 0008's Alternatives).
- A literal browser click-through was not performed this session (see Manual validation above);
  backend real-git integration coverage and frontend component coverage are both strong, but the
  gap is real and stated rather than papered over.
- `GitWorktreeManager.remove()`'s three underlying git operations (`worktree remove`, `prune`,
  `branch -D`) are not a single atomic transaction — a failure partway through is safely
  re-callable (idempotent) but not instantaneously all-or-nothing, the same category of limitation
  ADR 0007 already documented for `ArtifactStore.archiveAttempt()`.

## Next recommended milestone

Not implemented, proposed only: **time-based/opt-in retention policy**, once real usage data shows
whether unbounded manual-only cleanup is actually a problem in practice — e.g. a configurable
"auto-cleanup workspaces N hours after they go terminal" for developers who've decided they never
need to inspect a successful branch after the fact. Named in the Phase 32 architecture review
(§18 Future Work) as deliberately deferred rather than guessed at without data.
