# Phase 32 Proposal — Workspace Lifecycle & Cleanup

Status: **Proposed. Awaiting approval — do not implement from this document alone.**
See `docs/PHASE_32_ARCHITECTURE_REVIEW.md` for the investigation this proposal is derived from.

## 1. Objective

Make the git worktree a real-mode task creates a safe, understandable, **finite** lifecycle
resource: give the developer an explicit, safe way to reclaim the disk space a terminal task's
worktree holds, without ever risking the developer's own repository, without ever destroying
information needed for debugging/audit/retry, and without breaking Phase 30's conflict-resolution
resume path or Phase 31's retry guarantees.

## 2. Scope

**In scope**: a manual, explicit cleanup operation for a single task's real-mode workspace; the
ownership/safety check that makes it trustworthy; the workspace-lifecycle metadata needed to
represent "cleaned" without a new `TaskStatus`; the API and UI surface for triggering it; tests
proving it against real git state.

**Out of scope** (see §14 Non-Goals): automatic/scheduled cleanup, time-based retention, any
background scheduler, cloud/container execution environments, a workspace-tracking database,
changes to `TaskStatus`, changes to retry or crash-recovery semantics beyond what's needed to keep
them correct under the new operation existing at all.

## 3. Lifecycle Model

```
prepare() [real mode, first time this attempt runs]
   → RealExecutionWorkspace.status: "ready"
   → RealExecutionWorkspace.cleanupStatus: "active"

task reaches a terminal status (completed / failed / cancelled)
   → cleanup becomes AVAILABLE (not automatic)

task reaches "blocked"
   → cleanup is REFUSED, server-side, for as long as status stays "blocked"
     (Phase 30 conflict-resolution resume needs this exact worktree to still exist — see
     architecture review §6)

developer calls POST /tasks/:id/cleanup-workspace
   → git worktree remove --force + git branch -D (GitWorktreeManager.remove(), unchanged)
   → RealExecutionWorkspace.cleanupStatus: "cleaned", cleanedAt set
   → on failure: cleanupStatus: "cleanup_failed", cleanupError set — task status/error untouched

task is retried (any status it was retryable from)
   → prepare() force-recreates the worktree in place, exactly as it already does today
   → RealExecutionWorkspace is replaced wholesale with a fresh "ready"/"active" record
     (a manually cleaned workspace and a never-cleaned one look identical to prepare() — no
     special-casing needed)
```

No new `TaskStatus` value. "Cleaned" is a fact about the workspace, not about the task's
engineering outcome — it lives entirely on `Task.executionWorkspace`, which already exists
precisely to hold workspace-scoped facts separately from `Task.status`.

## 4. Ownership Model

A cleanup request names a `taskId`, never a filesystem path. The implementation:

1. Loads the task; 404 if it doesn't exist.
2. Reads `task.executionWorkspace`; if absent or `status !== "ready"`, there is nothing to clean
   (400/404-shaped response — mock-mode tasks and tasks whose workspace preparation itself failed
   both hit this).
3. Re-derives the expected `workspacePath`/`branch` from `taskId` the same way
   `GitWorktreeManager.prepare()` does, and asserts they equal what's stored on
   `task.executionWorkspace`. This can never actually fail today (both are set from the same
   computation), but it costs nothing and means a future bug that lets `executionWorkspace` drift
   from the platform's own naming convention fails closed instead of deleting whatever path ended
   up stored.
4. Calls `GitWorktreeManager.remove(task.repository, workspacePath, branch)` — the existing,
   already-tested primitive, unchanged. `task.repository` was already validated by
   `assertSafeRepositoryPath()` when the task was created; no new repository-path validation is
   needed.

No new deny-list, no new path-traversal defense — the request shape itself (a `taskId`, resolved
entirely server-side) makes the classes of attack §26 of the phase prompt asks about structurally
unreachable, the same way none of the existing `attempts/:attempt/...` routes accept a filesystem
path either.

## 5. Cleanup Policy

- **Trigger**: manual only. `POST /tasks/:id/cleanup-workspace`.
- **Eligibility**: `task.executionMode === "real"`, `task.executionWorkspace?.status === "ready"`,
  `task.executionWorkspace.cleanupStatus !== "cleaned"`, and `task.status !== "blocked"` and
  `task.status` is not one of the in-flight statuses (`inspecting` … `reviewing`) — i.e. the same
  terminal-or-not distinction `recoverOrphanedTasks()` already uses
  (`IN_FLIGHT_STATUSES`/terminal), reused rather than reinvented. `created` never has a workspace,
  so it's excluded implicitly.
- **`blocked` is refused, not just discouraged**: a `409`-class error naming the reason
  ("cannot clean up a workspace while the task is blocked — resolve or retry first"), enforced in
  the route/orchestrator layer, not only hidden in the UI. This is the one hard rule in this
  proposal that isn't a preference — see architecture review §6.
- **In-flight statuses are refused** for the same reason cancel-then-immediately-clean would race
  (architecture review §7): there is no "process has definitely exited" signal to key off yet for
  a task that hasn't reached a terminal status.
- **No automatic trigger anywhere** — not on completion, not on cancellation, not from the startup
  sweep. `recoverOrphanedTasks()` is unmodified by this phase.
- **Idempotent-safe re-request**: calling cleanup again on an already-`cleaned` workspace is a
  `409` ("already cleaned"), not a silent no-op and not an error that looks like something went
  wrong with the git operation itself.

## 6. API

### `POST /tasks/:id/cleanup-workspace`

No request body. Responses:

- `202` (cleanup performed synchronously — this is a fast, bounded git operation, not a
  fire-and-forget background job like `/start`/`/retry`) with the updated `task`.
- `404` — task not found.
- `409` — no eligible workspace (mock-mode task, workspace never prepared, workspace preparation
  itself failed, already `cleaned`, task is `blocked`, or task is still in-flight).
- `500` — the underlying `git worktree remove`/`git branch -D` failed; `task.executionWorkspace`
  is updated to `cleanupStatus: "cleanup_failed"` with `cleanupError` set, but `task.status`/
  `task.error` are **not** touched (architecture review §11) — the response body still returns the
  task so the client can see the failure recorded there.

### `GET /tasks/:id`

No new route — `task.executionWorkspace` already returned by the existing `GET /tasks/:id` gains
two new fields (`cleanupStatus`, `cleanedAt`/`cleanupError`), following the same "extend an
existing record" pattern every prior phase in this project has used rather than adding a parallel
endpoint just to expose two fields.

No `GET workspace status` endpoint, no `POST cleanup-all` — neither is justified: workspace status
is already part of `GET /tasks/:id`, and cleanup is a single-task, human-reviewed action by design
(§18/§19 of the phase prompt: don't build APIs merely because they're possible). A "clean up
everything" bulk action would undercut the entire rationale for making cleanup manual in the first
place.

## 7. UI

Extends the existing "Execution Workspace" block in Task Detail
(`web/src/app/pages/task-detail/task-detail.component.html:36-43`), which already renders
`workspace.branch` for real-mode tasks:

```
Execution Workspace

Branch: agent/task-abc123
Status: Retained
[ Cleanup Workspace ]

  (blocked task:)
Status: Retained — workspace required until this conflict is resolved or the task is retried
  (no button)

  (already cleaned:)
Status: Cleaned (2026-09-16 14:02)
  (no button)

  (cleanup failed:)
Status: Cleanup failed — <error>
[ Retry Cleanup ]
```

`[ Cleanup Workspace ]` only ever renders for a terminal, non-blocked, real-mode task with a
`ready`, not-yet-`cleaned` workspace — mirroring exactly how Phase 31's `[ Retry ]` button is
gated by `RETRYABLE_STATUSES`. Clicking it opens a confirmation (not a silent action — this is a
permanent, unmergeable-afterward deletion of the branch): "This deletes the isolated workspace and
its git branch (`agent/task-abc123`). Any changes you haven't merged into your own repository will
be permanently lost. Artifacts (diff summary, reviews, handoff) are not affected." This is not
reversible, so the UI says so plainly rather than implying otherwise.

## 8. Configuration

None required. The eligibility rule (`§5`) is a fixed policy, not a tunable — there is no evidence
yet that a configurable variant is needed, and the phase prompt explicitly asks not to add
configuration for every possible behavior. If time-based retention is ever added (see architecture
review §18, out of scope here), that is where new configuration (e.g. a retention-hours knob)
would first become justified.

## 9. Failure Handling

Covered in §5/§6: a cleanup failure is recorded on `executionWorkspace.cleanupStatus`/
`cleanupError` and surfaced in the response, but never mutates `task.status` or `task.error`. A
developer can retry the cleanup action itself (idempotent: re-running `git worktree remove --force`
against an already-partially-removed worktree is safe, matching the same self-healing behavior
`prepare()` already relies on for retry).

## 10. Security

No new attack surface beyond what §4/§12 (architecture review) already establishes: the operation
takes a `taskId`, resolves every path/branch value server-side from `task.executionWorkspace`
(itself only ever set by `prepare()`, never client input), and reuses `task.repository`, which was
already validated by `assertSafeRepositoryPath()` at task-creation time. No new deny-list is
needed because no new path ever enters from outside the server.

## 11. Acceptance Criteria

- A completed/failed/cancelled real-mode task's workspace can be cleaned via
  `POST /tasks/:id/cleanup-workspace`, verified against actual `git worktree list`/branch
  existence/filesystem state before and after — not just the application's self-reported success.
- A `blocked` task's cleanup request is refused with a clear reason, and the underlying worktree is
  provably untouched (still present on disk, still a valid git worktree) after the refused
  request.
- A cleanup call for a task belonging to a different, still-active task's workspace never occurs —
  concurrency test proves task A's cleanup cannot touch task B's worktree.
- A cleanup failure (simulated deterministically, not mocked) leaves `task.status` exactly as it
  was before the call.
- Retrying a task after its workspace was manually cleaned works exactly as retrying one that was
  never cleaned — `prepare()` behaves identically either way.
- Mock-mode tasks are unaffected — the endpoint is a clean 409 for them, no code path assumes a
  workspace exists.

## 12. Testing

Following this project's established real-git-validation convention (Phase 28's
`gitWorktree.test.ts`, Phase 31's `taskRetryRealMode.test.ts`):

- **Successful task → cleanup**: real worktree via `GitWorktreeManager.prepare()`, mark task
  `completed`, call cleanup, assert via `git worktree list`/`git branch --list` (run against the
  real repo, not asserted from application state) that both the worktree and branch are gone, and
  `task.executionWorkspace.cleanupStatus === "cleaned"`.
- **Failed/cancelled task → cleanup**: same shape, confirms eligibility isn't accidentally
  scoped to only `completed`.
- **Blocked task → cleanup refused**: assert `409`, then assert via real git state that the
  worktree is still present and intact — proves the refusal isn't merely a UI-layer suggestion.
- **In-flight task → cleanup refused**: same shape for e.g. `implementing`.
- **Retry after manual cleanup**: clean attempt 1's workspace, retry, assert attempt 2's worktree
  is created successfully and is fully isolated (reuses the real-mode-shaped assertions
  `taskRetryRealMode.test.ts` already established).
- **Cleanup failure is isolated from task status**: deterministic failure (e.g. pre-remove the
  worktree directory out from under `GitWorktreeManager.remove()` via a locked/undeletable file, or
  reuse this project's existing pattern of pre-creating a conflicting path), assert `task.status`
  unchanged and `cleanupStatus === "cleanup_failed"`.
- **Ownership / concurrency**: two real tasks with two real worktrees; clean task A; assert task
  B's worktree, branch, and `executionWorkspace` are byte-for-byte untouched.
- **Mock-mode task**: cleanup request returns `409`, no git commands attempted (spy/assert no
  `GitWorktreeManager` method invoked).
- **Already-cleaned task**: second cleanup call returns `409` ("already cleaned"), not a git error.

Frontend: `it.each` visibility matrix across the same status set Phase 31's retry-button test
already parametrizes over (extended with `cleanupStatus` permutations for the terminal ones),
confirmation-dialog test, and a cleaned/cleanup-failed rendering test.

## 13. Documentation

Update `docs/REAL_EXECUTION.md#cleanup` (currently states cleanup is "manual/future work" — this
phase makes it manual/*present*, so the section needs rewriting, not just appending to), `docs/API.md`
(new endpoint), `docs/AGENT_WORKFLOW.md` (a short note alongside the existing Retry section, since
developers will naturally ask how cleanup and retry relate), and the project-status memory. No new
ADR is required by this proposal itself (existing ADR 0007 already documents the "workspace
lifecycle deferred" decision this phase resolves) — the implementation phase should add one if the
chosen approach in review turns out to diverge from this document.

## 14. Non-Goals

Automatic or scheduled cleanup of any kind; time-based retention; a `[ Cleanup All ]` bulk action;
any change to `TaskStatus`; any change to `recoverOrphanedTasks()`'s behavior or contract; any
change to how retry or conflict-resolution-resume acquire a workspace; cloud/Docker/Kubernetes
execution environments; a database for workspace tracking; authentication; billing.

---

Waiting for approval.
