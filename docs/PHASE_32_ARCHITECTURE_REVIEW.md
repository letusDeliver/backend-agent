# Phase 32 Architecture Review — Workspace Lifecycle & Cleanup

Status: **Review only. Nothing in this document has been implemented.**

## 1. Executive Summary

Real-mode execution creates exactly one git worktree per **task** (not per attempt) at a fixed
path, `tasks/<id>/workspace`, on a fixed branch, `agent/task-<id>`. `GitWorktreeManager.remove()` —
a tested, safe primitive (`git worktree remove --force` + `git branch -D`) — already exists and has
existed since Phase 28, but nothing in the codebase calls it. This was a deliberate Phase 28
decision ("workspace cleanup is manual/future work, not automatic," `docs/REAL_EXECUTION.md#cleanup`),
not an oversight. The result: every task that ever prepares a real-mode workspace leaves a full
working-copy checkout on disk forever, regardless of how the task ends, unless a developer retries
it again (which force-recreates the same worktree in place) or someone runs `git worktree remove`
by hand.

Two things distinguish this review from a generic "add cleanup" task:

1. **Worktrees don't accumulate per attempt.** Because the workspace path and branch name are
   keyed only by `taskId`, `TaskOrchestrator.retry()` already overwrites the previous attempt's
   worktree and force-resets the branch ref (`git worktree add -B`) before the new attempt runs.
   There is never more than one live worktree for a given task. The orphan problem is "one
   never-cleaned worktree per real-mode task," not "N worktrees per task across N attempts."
2. **A `blocked` (conflict) task's resume path depends on the worktree still existing.**
   `resumeAfterConflictResolution()` calls `continueAfterReconciliation()` directly, which reaches
   `implement()` without ever re-calling `prepareRealExecutionWorkspace()`. The executor resolves
   the workspace path from `task.executionWorkspace.workspacePath`, set once when the workspace was
   first prepared. If that directory is deleted while a task sits `blocked`, resolving the conflict
   will attempt to implement against a worktree that no longer exists. This is a genuine
   correctness hazard any cleanup design must respect, not a hypothetical edge case.

The durable historical record for a completed pipeline stage is already almost entirely outside
the worktree: every specialist report, the reconciliation, the implementation plan, the execution
report (file list + line-count diff stats + test results), reviews, and the final handoff all live
under `tasks/<id>/` as JSON/Markdown, independent of the worktree subdirectory nested inside it.
The one thing that lives *only* in the worktree/branch is the actual patch content — the full text
of what Claude changed. `ExecutionReport.diff` stores `{ baseRevision, branch, files: [{path,
additions, deletions}], summary }` — line counts, not patch text. So the worktree isn't disposable
scratch space; it's the only place a developer can `git diff`/`git log -p` the real change before
merging it into their own repository.

## 2. Current Workspace Lifecycle

```
Task created (status: created)
  → POST /tasks/:id/start
  → inspecting → routing
  → [real mode only] prepareRealExecutionWorkspace()
        GitWorktreeManager.prepare(repository, taskId, tasksDir)
        → git worktree prune (best-effort)
        → if tasks/<id>/workspace exists: git worktree remove --force (best-effort)
        → git worktree add -B agent/task-<id> tasks/<id>/workspace <HEAD>
        → task.executionWorkspace = { workspacePath, branch, baseRevision, status: "ready", createdAt }
  → analyzing → reconciling → planning
  → implementing
        executor.implement() / runTests() operate inside task.executionWorkspace.workspacePath
        GitWorktreeManager.commitChanges() commits onto the task branch
  → reviewing
  → completed / failed / blocked / cancelled
```

The worktree is created exactly once per attempt, immediately before specialist analysis, and
nothing in `run()`, `block()`, `complete`-equivalent handoff code, `POST /tasks/:id/cancel`, or
`recoverOrphanedTasks()` ever removes it. Verified by grepping the whole `server/src` tree for
every call site of `GitWorktreeManager` — `prepare()` is called from exactly one place
(`prepareRealExecutionWorkspace()`), and `remove()` is called from nowhere in application code,
only from its own test file (`server/tests/gitWorktree.test.ts`).

Per terminal outcome, as actually implemented today:

| Outcome | Worktree fate today |
|---|---|
| **Successful task** | Retained forever. No code path touches it after `handoff()`. |
| **Failed task** (pipeline error, review-loop exhaustion is `blocked` not `failed`) | Retained forever. `handleRunFailure()` only writes task status/error. |
| **Blocked task** (`NEEDS_USER_DECISION`, `UNKNOWN`, unresolved material conflict, review-loop exhaustion) | Retained forever, and *must* be — see §9 below. |
| **Cancelled task** | Retained forever. `POST /tasks/:id/cancel` sends `SIGTERM` (then `SIGKILL` after a 5s grace timeout it does not await) to any in-flight `claude` child process, writes `status: "cancelled"`, and returns. It never touches the worktree. |
| **Timed-out task** (`CLAUDE_TIMEOUT_MS` exceeded) | `spawn(..., { timeout })` kills the child itself; the executor classifies this as a `ClaudeCliError`, which `handleRunFailure()` turns into `status: "failed"`. Same fate as any other failed task — worktree retained. |
| **Retried task** | The *specific instance* of the worktree from the retried attempt is gone the moment the new attempt calls `prepare()` again — `worktree remove --force` + branch force-reset happen synchronously before any specialist work starts on the new attempt. There is nothing left to separately clean up after a retry; this already happens, today, as a side effect of `prepare()`'s self-healing. |
| **Server-crashed task** | Worktree retained. `recoverOrphanedTasks()` only flips `task.status` to `failed`; it never reads `task.executionWorkspace` or touches the filesystem beyond the JSON task store. |

## 3. Ownership

There is currently no explicit "does this worktree belong to the platform" check anywhere, because
there is currently no code path that deletes a worktree by path at all — `remove()` takes an
explicit `(repositoryPath, workspacePath, branch)` triple from its caller and trusts it. Today's
only caller is a test that constructs those values itself from a `prepare()` result, so this has
never been a live risk. It becomes one the moment any API-triggered cleanup exists, because that
path would be driven by a request naming a `taskId`, and the values it acts on must be derived
**only** from server-held state.

The good news: ownership provenance already exists and is already reliable.
`task.executionWorkspace.workspacePath` and `.branch` are set exactly once, at `prepare()` time,
from values `GitWorktreeManager` itself computed (`path.join(tasksDir, taskId, "workspace")` and
`` `agent/task-${taskId}` ``) — never from client input. A cleanup implementation has a natural,
already-correct anchor: look up the task by ID, read its own `executionWorkspace`, and — as a
defense-in-depth check, not because today's data can actually disagree — re-derive the expected
path/branch from `taskId` and assert they match before doing anything destructive. This mirrors the
posture of `assertSafeRepositoryPath()` for the *developer's* repository (Phase 28 §12): that guard
protects the repository being pointed at; an equivalent narrow check for cleanup protects against
ever letting a cleanup operation act on a path it didn't itself compute.

## 4. Successful Tasks

Nothing currently happens after `completed`. The execution report's diff summary, file list, and
test results are already durable outside the worktree, and the final handoff (`final-handoff.json`
/`.md`) already tells the developer to "review and merge this branch with your own git tooling" —
i.e. the product's own stated expectation is that a human looks at the real branch before it stops
mattering. Immediate, automatic deletion on `completed` would delete that branch before the
developer necessarily had a chance to look at or merge it. This is the strongest argument in this
review against any *automatic, immediate* cleanup trigger.

## 5. Failed Tasks

Same durable/non-durable split as successful tasks, but the argument for retention is stronger: a
failed task's worktree may hold the only evidence of what Claude actually attempted before things
went wrong (uncommitted work, a partial commit that never passed review, `git log` showing exactly
which commands ran). `docs/REAL_EXECUTION.md`'s existing rationale — "a failed or cancelled task's
workspace is exactly what you need to debug it" — is not just a design comment, it's currently
lived out by the total absence of any cleanup path.

## 6. Blocked Tasks

This is the one case in this review with a concrete correctness constraint, not just a UX
preference. Traced directly in `taskOrchestrator.ts`:

```
resumeAfterConflictResolution(taskId)
  → continueAfterReconciliation(task, reconciliation)
      → implement(task, plan)
          → executor.implement({ task, ... })
              → workspaceOf(task) reads task.executionWorkspace.workspacePath directly
```

No step between conflict resolution and implementation re-calls `prepareRealExecutionWorkspace()`.
If a `blocked` task's worktree is deleted while it's waiting on
`POST /tasks/:id/reconciliation/conflicts/:conflictId/resolve`, resolving the conflict will attempt
real execution against a workspace path that no longer exists, and fail in a way that's opaque to
the developer (a `ClaudeCliError` about a missing directory, not a clear "your workspace was
cleaned up" message). **Any cleanup design must never allow a `blocked` task's worktree to be
removed while it is still `blocked`** — this isn't a policy nicety, it's required for Phase 30's
conflict-resolution feature to keep working correctly for real-mode tasks.

## 7. Cancelled Tasks

`POST /tasks/:id/cancel` returns to the HTTP caller immediately after sending `SIGTERM` — it does
not await process exit, and the executor's own escalation to `SIGKILL` happens on a 5-second timer
the cancel handler never waits on either (`RealClaudeCodeExecutor.cancel()`,
`server/src/execution/RealClaudeCodeExecutor.ts:40-56`). That means "task status is `cancelled`" and
"the `claude` child process (and any git commands it may itself have shelled out to) has actually
exited" are **not the same moment** — there is a window, up to several seconds, where the process
may still be running and potentially still writing to the worktree. Any cleanup triggered
synchronously by the cancel request itself would race that window and could run
`git worktree remove --force` concurrently with an in-flight write, which is unsafe. This rules out
"clean up immediately inside the cancel handler" as a design, independent of whether immediate
cleanup is otherwise desirable.

## 8. Timeout Behavior

The CLI invocation itself uses Node's `spawn(..., { timeout: config.claudeTimeoutMs })`, which kills
the process directly and synchronously reports back via the `close` handler — by the time
`handleRunFailure()` marks the task `failed`, the specific child process for that CLI call has
already exited. However, `runTests()` (a separate `exec` call, not tracked in `activeProcesses`)
has its own independent timeout path, and nothing links "this specific process has exited" to "it
is now safe to touch the worktree" as an explicit signal anywhere in the codebase. Practically, by
the time a task reaches terminal `failed` status via a timeout, the offending process is gone — but
this is true by observation of the current code, not something the codebase asserts or tests today,
and a future change to either timeout path shouldn't be assumed to preserve it silently.

## 9. Retry Interaction

Already covered in §1/§2: retry is the one lifecycle event that already, today, safely disposes of
a worktree — `GitWorktreeManager.prepare()`'s pre-existing `worktree remove --force` + `-B` force
reset. Phase 31's ADR 0007 states this outright ("retry does not change when or whether a worktree
is ever deleted, only that it is force-recreated on the next real-mode run"). Nothing in this
review proposes changing that. The only new question Phase 32 adds is: since a worktree can now
also be deleted *by an explicit developer cleanup action* (not just implicitly by the next retry),
does that interact with a later retry of the same task? It does not, by construction — `prepare()`
already handles "workspace path doesn't currently have anything at it" as a normal case (its
existence check is `if (existsSync(workspacePath))`, not an assumption that it does exist), so a
manually cleaned workspace and a naturally-never-created one look identical to `prepare()`.

## 10. Crash Recovery

`recoverOrphanedTasks()` never touches `task.executionWorkspace` or the filesystem workspace path
at all today — it only corrects `task.json`'s status. An orphaned real-mode worktree from a crashed
mid-flight task is left exactly where it was, on disk, with whatever partial/uncommitted state
existed at the moment the process died. That partial state is arguably the single most useful
worktree a developer could inspect (it shows exactly what was mid-flight when things went wrong),
which argues for retaining it, not cleaning it automatically as part of the sweep. It also argues
*against* extending the crash-recovery sweep to do destructive filesystem work: that sweep's entire
design contract (per ADR 0007) is "only corrects status, never resumes or otherwise acts" — adding
a delete operation to it would be a real change to what that code is trusted to do, for a benefit
(freeing disk for a workspace that just crashed and is probably the most interesting one to keep)
that's actually negative.

## 11. Cleanup Failure

There is no cleanup code today, so there is no existing failure-handling precedent to point to —
but the principle the rest of this platform already follows (Phase 28's git-diff-over-self-report,
Phase 31's archive-before-reset ordering) is that a side operation's failure must never corrupt the
primary record it's attached to. Concretely: if a future cleanup operation fails partway (e.g.
`git worktree remove` succeeds but `git branch -D` fails because something still references it),
that must never flip a task's `status` away from whatever it already legitimately is. The task's
engineering outcome (`completed`/`failed`/`blocked`/`cancelled`) and its workspace's disk lifecycle
are different facts about different things, and only the second one should be able to be "failed."

## 12. Security

Two guardrails already exist and are directly reusable:

- `assertSafeRepositoryPath()` already runs inside `GitWorktreeManager.prepare()` against the
  developer's repository path — this already prevents a task from ever being pointed at `/`, `~`,
  `/etc`, the platform's own source tree, etc. Cleanup doesn't need a new version of this check for
  the *repository* argument to `git worktree remove`/`git branch -D`, because that argument is
  always `task.repository`, which already passed this guard when the task was created.
- The workspace path itself is never client-supplied (§3) — a cleanup endpoint takes a `taskId`,
  not a path, and every value the actual git commands run against is derived server-side from
  `task.executionWorkspace`. There is no request shape in which a client could smuggle `../../` or
  an absolute path into a cleanup operation, because no cleanup operation would ever accept a path
  as input in the first place.

## 13. Candidate Designs

**Immediate cleanup** (delete the worktree the instant a task reaches a terminal status): simplest
to reason about, but directly conflicts with §4/§5 (destroys the only place full patch content
lives, before a human has necessarily looked at it) and §7 (races an unawaited cancel/kill).
Rejected as the primary trigger.

**Retention-based (time) cleanup**: e.g. "delete workspaces for tasks that have been terminal for
more than N hours." Solves unbounded accumulation without requiring a developer to remember to act,
but requires a background scheduler/cron-like mechanism this MVP has never needed anywhere else
(no other feature in this codebase runs periodic background work), and picking a default retention
window is a genuine guess with no usage data behind it yet. Worth naming as future work once real
disk-usage patterns are observed; not justified as a first cut.

**Manual cleanup**: an explicit, confirmed developer action (API + UI button) available once a task
is terminal. Requires no scheduler, no guessed default, and puts the "have I looked at this yet"
judgment where only a human can actually make it. Weakest point: nothing stops disk usage from
growing unbounded if developers never click it — acceptable for a small, local, developer-facing
MVP where the developer is also the one who will notice their disk filling up, not acceptable at
larger scale.

**Hybrid** (manual now, with the data model already shaped to add a retention policy later without
a breaking change): keep the trigger manual, but store `cleanupStatus`/`cleanedAt` on
`RealExecutionWorkspace` in a shape a future periodic sweep could also write to, so introducing
time-based cleanup later is additive, not a rework.

## 14. Recommended Design

See `docs/PHASE_32_PROPOSAL.md`.

## 15. Testing Strategy

See "Testing" in the proposal. In summary: reuse the already-tested `GitWorktreeManager.remove()`
directly rather than writing new git-manipulation code; the new surface to test is the *policy*
layer around it (ownership derivation, blocked-task refusal, terminal-status gating, cleanup
failure isolation from task status, concurrency between two tasks' cleanups) plus one test that
exercises real `git worktree list`/filesystem state before and after cleanup, matching this
project's established convention (Phase 28's `gitWorktree.test.ts`, Phase 31's
`taskRetryRealMode.test.ts`) of verifying git-level guarantees against real git output rather than
trusting the application's self-report.

## 16. Risks

- Deleting a branch a developer hadn't merged yet is a real, permanent loss of patch content if
  they click cleanup without checking first — mitigated by a UI confirmation that says so
  explicitly, not by making cleanup harder to reach.
- A cleanup action available while `blocked` is a latent footgun for Phase 30's conflict-resolution
  flow (§6) — mitigated by refusing cleanup server-side (not just hiding the button) while
  `status === "blocked"`.
- Racing an unawaited cancel (§7) — mitigated by not offering cleanup as a same-request side effect
  of `POST /tasks/:id/cancel`; cleanup is always a separate, later, explicit call.

## 17. Non-Goals

Unchanged from the phase prompt's explicit scope boundary: no cloud/Docker/Kubernetes execution
environments, no remote git providers, no distributed workers, no database for workspace tracking,
no automatic/scheduled task retry, no fine-grained resume, no new specialist agents, no vector
memory, no auth, no billing. Additionally, out of scope for this specific phase: any background
scheduler or periodic sweep, and any change to `TaskStatus`.

## 18. Future Work

Time-based retention (once real usage data exists to justify a default), an optional
opt-in-via-config "auto-cleanup on completed" for developers who've decided they never need to
inspect a successful branch, and a `git worktree list`-based startup discovery/reconciliation pass
purely for observability (log-only, no deletion) if orphaned-worktree accumulation turns out to be
a real problem in practice rather than a theoretical one.
