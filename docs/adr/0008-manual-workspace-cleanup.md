# ADR 0008 — Workspace cleanup is manual, worktree-only, and never runs while a task is blocked

**Status**: Accepted (Phase 32)

## Context

Phase 28 gave real-mode execution an isolated git worktree (`tasks/<id>/workspace/`) and a
tested-but-unused removal primitive, `GitWorktreeManager.remove()`, deliberately left unwired —
"workspace cleanup is manual/future work, not automatic," documented at the time in
`docs/REAL_EXECUTION.md#cleanup`. Phase 31 added retry, which force-recreates that same worktree
in place on every retried attempt but otherwise left the cleanup question untouched (ADR 0007:
"retry does not change when or whether a worktree is ever deleted"). The result, confirmed by
inspection in `docs/PHASE_32_ARCHITECTURE_REVIEW.md`, is that every real-mode task that ever
prepares a workspace leaves a full working-copy checkout on disk forever unless a developer removes
it by hand with raw git commands. This phase gives the developer a safe, in-product way to do that.

Two findings from that review shaped the decision more than the original phase proposal
anticipated:

1. **Worktrees are keyed per task, not per attempt** — the workspace path and branch name are a
   pure function of `taskId` (`tasks/<id>/workspace`, `agent/task-<id>`), so there is only ever one
   live worktree per task, not one per attempt. The "orphan" problem is one never-cleaned worktree
   per real-mode task, not accumulation across retries.
2. **A `blocked` task's conflict-resolution resume path reuses the exact same worktree.**
   `resumeAfterConflictResolution()` reaches `implement()` without ever re-calling
   `prepareRealExecutionWorkspace()` — it reads `task.executionWorkspace.workspacePath` as set when
   the task first blocked. Deleting that worktree while the task is `blocked` would break Phase
   30's conflict-resolution feature for real-mode tasks, not just remove something not yet needed.

## Decision

- **Cleanup is always an explicit developer action, never automatic.** `POST
  /tasks/:id/cleanup-workspace` is the only way a workspace is ever removed. No terminal status
  transition, no startup sweep, and no timer triggers it. This mirrors Phase 31's "retry is always
  an explicit developer action" decision and the same "retry storms" reasoning: an automatic
  trigger on a machine running real Claude CLI calls should never fire without developer intent.
- **Eligible statuses are `completed`, `failed`, and `cancelled` — explicitly not `blocked`, even
  though `blocked` is otherwise "nothing is actively running."** This is enforced in
  `TaskOrchestrator.cleanupWorkspace()` itself (`WORKSPACE_CLEANUP_ELIGIBLE_STATUSES`), not only in
  the UI, because the correctness hazard in Context §2 is real: a `blocked` task's worktree must
  still exist for `POST /tasks/:id/reconciliation/conflicts/:conflictId/resolve` to keep working.
  A developer who wants to discard a blocked task's workspace can still retry it (which
  force-recreates the worktree from current `HEAD` — Phase 31's existing, unchanged behavior) or
  cancel it first.
- **Cleanup removes the worktree and its branch together, reusing `GitWorktreeManager.remove()`
  unmodified in shape** (still `git worktree remove --force` + `git branch -D`). No partial
  "worktree-only, keep the branch" variant was built: the branch is disposable and re-derivable
  (fixed name, force-recreated on the next retry), and a full-strength confirmation warning in the
  UI ("any changes you haven't merged will be permanently lost") covers the real risk — losing
  patch content a developer hadn't reviewed yet — more honestly than a partial-removal mode that
  quietly leaves an unreachable dangling branch ref behind.
- **`remove()` itself changed to surface genuine failures instead of swallowing them.** Before this
  phase, every git call inside `remove()` was wrapped in `.catch(() => undefined)` — safe for its
  only prior caller (its own test), useless for a developer-facing action that must be able to
  report whether cleanup actually worked. It now throws `GitWorktreeError` on a real failure (e.g.
  a worktree directory that's locked or was never registered) while staying safely re-callable: a
  workspace directory or branch that's already gone is treated as already-clean, not as an error.
  `GitWorktreeManager.prepare()`'s own inline self-healing removal is untouched by this change —
  it's separate code, not routed through `remove()`.
- **Cleanup failure never changes `Task.status` or `Task.error`.** A failure is recorded only on
  `Task.executionWorkspace.cleanupStatus: "cleanup_failed"` / `cleanupError` — the task's
  engineering outcome and its workspace's disk lifecycle are independent facts, the same principle
  Phase 31 already applied to archive-before-reset ordering. A `completed` task whose cleanup
  failed is still, correctly, `completed`.
- **Workspace lifecycle metadata lives on `Task.executionWorkspace`, not as a new `TaskStatus`.**
  `cleanupStatus?: "ready" | "cleaned" | "cleanup_failed"` plus `cleanedAt?`/`cleanupError?` are the
  only additions. Absence is treated as `"ready"` everywhere it's read — no migration default is
  written for records created before this phase, unlike Phase 31's `attempt` field, because nothing
  here requires arithmetic or a non-optional value to render correctly.
- **Ownership is re-derived server-side, not trusted from the stored record alone.**
  `deriveWorkspaceLocation(taskId, tasksDir)` (extracted from `GitWorktreeManager.prepare()` so the
  two can never compute the naming convention differently) is recomputed and compared against
  `task.executionWorkspace` before any destructive call — defense in depth, not a fix for an
  observed bug, since the client-facing API never accepts a filesystem path in the first place.
- **Concurrency uses an in-process `Set`, not a new locking mechanism.** Two `POST
  .../cleanup-workspace` calls racing for the same task are resolved by a synchronous
  test-and-set on `taskId`, the same pattern `RealClaudeCodeExecutor` already uses for
  `cancelRequested`/`activeProcesses`. Sufficient for a single-process local MVP; no distributed
  lock was introduced.

## Alternatives considered

- **Automatic cleanup on terminal status**: rejected. It would delete a `completed` task's branch
  before a developer necessarily had a chance to review or merge it (the final handoff already
  tells them to "review and merge this branch with your own git tooling"), and it would race
  `POST /tasks/:id/cancel`'s unawaited `SIGTERM`→`SIGKILL` window (`RealClaudeCodeExecutor.cancel()`
  returns before the process is confirmed exited), risking a `git worktree remove --force`
  concurrent with an in-flight write.
- **Time-based retention** (delete workspaces N hours after they go terminal): deferred, not
  rejected outright. It would require a periodic background job this codebase has never needed
  anywhere else, and any default retention window would be a guess with no usage data behind it.
  Revisit if disk accumulation turns out to be a real problem in practice, not a theoretical one.
- **Extending the startup crash-recovery sweep to also clean up orphaned workspaces**: rejected.
  That sweep's entire contract (ADR 0007) is "only corrects status, never resumes or otherwise
  acts." A crashed task's partial/uncommitted worktree state is arguably the most useful one for a
  developer to inspect, not the first one to delete, and adding a destructive filesystem operation
  to a code path whose value today is precisely that it's non-destructive would be a real change to
  what that code is trusted to do.
- **A `cleanup_pending` task-metadata state for crashed tasks**: rejected as unnecessary ceremony —
  `status: "failed"` (already set by the crash sweep) plus `executionWorkspace.cleanupStatus`
  (absent, i.e. `"ready"`) already fully describes "this failed task has an uncleaned workspace";
  the phase prompt's own guidance was to choose the smallest model that correctly represents
  reality.
- **A partial "remove the worktree directory but keep the branch" cleanup mode**: considered in the
  architecture review as a way to keep a cheap, git-native historical pointer after cleanup, but
  rejected for this milestone — it adds a second code path to `GitWorktreeManager` for a benefit
  (a diffless branch ref) the durable JSON artifacts (file list, line-count diff summary, reviews,
  handoff) already cover at audit level, while the one thing genuinely lost — full patch text — is
  better addressed by the UI's explicit pre-deletion warning than by a half-removed git state.

## Consequences

- A developer who cleans up a `completed` task's workspace without having merged its branch first
  permanently loses the actual patch content; the JSON artifact trail (diff summary, file list,
  reviews, final handoff) survives, but `git diff`/`git log -p` against that branch no longer will.
  The UI's confirmation dialog states this plainly before the request is sent.
- Disk usage from real-mode task workspaces remains unbounded for any task a developer never
  explicitly cleans up — there is still no automatic or time-based reclamation. This is an accepted
  trade-off for a small, local, developer-facing MVP where the developer who created the disk usage
  is also the one positioned to notice and act on it.
- `GitWorktreeManager.remove()` now throws on a genuine failure where it previously never did.
  Its only production caller is the new `cleanupWorkspace()` path introduced in this phase; the
  self-healing removal inside `prepare()` is separate, inline code and is unaffected.
- Workspace cleanup and Phase 31 retry remain fully independent: retrying a task whose workspace
  was manually cleaned up behaves identically to retrying one that was never cleaned, since
  `GitWorktreeManager.prepare()` already treats "nothing at this path" as its normal case.
