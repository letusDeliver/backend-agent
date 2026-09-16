# Phase 31 Proposal — Task Retry + Startup Crash Recovery

**Status**: proposed, not implemented. Companion to `docs/PHASE_31_ARCHITECTURE_REVIEW.md`, which
contains the full investigation this proposal is derived from. This document is the
implementation-ready spec for the single recommended milestone — waiting for developer approval
before any code is written.

---

## Milestone name

**Task Retry & Startup Crash Recovery**

## Why now

Every task that reaches `failed`, or reaches `blocked` for any reason other than a Phase 30
material reconciliation conflict, is permanently inert today — no API endpoint, and no UI control,
can move it anywhere (`docs/PHASE_31_ARCHITECTURE_REVIEW.md` §1, §3). Separately, a server restart
while a task is mid-flight leaves it silently stuck in a non-terminal status forever, invisible as
a failure and unreachable by any future feature that only looks at `failed`/`blocked` (§5). Both
gaps have the same fix shape — give the developer (and, for the restart case, the platform itself)
a safe way to say "start this task over" — so they are addressed together rather than as separate
milestones.

## Current problem

- `POST /tasks/:id/retry` does not exist.
- `blocked` is listed as a terminal status for cancellation purposes in both
  `routes/tasks.ts`'s `TERMINAL_STATUSES` and the UI's mirrored constant, so a `blocked` task
  outside the conflict-resolution path cannot even be cancelled, let alone retried.
- `index.ts` performs no startup recovery; a task left `analyzing` (or any other mid-flight status)
  by an unclean shutdown stays in that status indefinitely, with no further events ever generated
  for it.

## Desired developer workflow

```
Task fails (e.g. Claude CLI timeout during implementation)
   ↓
Task Detail shows: "TASK FAILED — Reason: <error>" and a [ Retry ] button
   ↓
Developer clicks Retry
   ↓
A new attempt begins: repository is re-inspected (picks up anything the developer
fixed since the last attempt), routing/memory/analysis/reconciliation/implementation/
review all run fresh, exactly like a brand-new task would
   ↓
Previous attempt's specialist reports, reconciliation, plan, execution report, and
reviews remain readable under an "Attempt 1" history section — nothing is deleted
   ↓
Task reaches completed (or fails/blocks again, in which case Retry is offered again)
```

For a crash-orphaned task:

```
Server restarts
   ↓
Startup sweep finds task-42 stuck in "implementing" from before the crash
   ↓
task-42 becomes: status "failed", error "Orchestrator restarted while this task
was in progress (stage: implementing). Retry to restart from repository inspection."
   ↓
Developer sees task-42 in the task list as FAILED (not silently stuck) and can Retry it
```

## Architecture impact

- `Task` gains two fields: `attempt: number` (starts at 1) and no separate "attempts list" type —
  prior attempts are discoverable via the archived artifact directories (see below), not
  duplicated into the `Task` record itself, keeping `TaskStore`'s shape simple.
- `ArtifactStore` gains an `archiveAttempt(taskId, attempt)` operation: before a retry re-runs
  `ensureWorkspace()`, it moves the current top-level artifact files (`task.json` is excluded —
  it's about to be overwritten with fresh status anyway and is always readable from `TaskStore`;
  everything else — specialist reports, `reconciliation.json`, `implementation-plan.json`,
  `execution-report.json`, `reviews/`, `context/`, `final-handoff.*` — moves) into
  `tasks/<id>/attempts/<n>/`. `events.log.jsonl` is **not** archived or truncated — it is a single
  continuous history across all attempts of a task, with a new `TASK_RETRIED` event marking the
  boundary, consistent with how the event log already works as an append-only audit trail.
- `TaskOrchestrator` gains a public `retry(taskId): Promise<void>` method: validates status,
  increments `attempt`, resets `error`, `executionWorkspace`, `selectedAgents`, `currentStage`,
  `reviewRetryCount` on the `Task`, delegates to the existing `run(taskId)` unchanged. `run()`
  itself needs no modification — it already re-derives everything from the `Task` + live repository
  state.
- `routes/tasks.ts` gains `POST /tasks/:id/retry`, mirroring the existing `/start` endpoint's
  shape (202 Accepted, fire-and-forget `void orchestrator.retry(task.id)`).
- `index.ts` (or a new `server/src/startup/recoverOrphanedTasks.ts` called from it, before
  `app.listen()`) lists all tasks, finds any in a mid-flight status, and transitions each straight
  to `failed` via the existing event-publishing path — no orchestrator method needed for this,
  since there is no in-flight work to resume, only a status correction to make.
- UI: Task Detail's existing action-button area gains a `[ Retry ]` button, shown when
  `task.status` is `failed`, `blocked`, or `cancelled`, calling a new `TaskService.retryTask()` —
  the same pattern already used for `cancelTask()`/`resolveConflict()`. The existing
  `TERMINAL_STATUSES`/`isTerminal()` check for the cancel button is **unchanged** (retry and
  cancel are different affordances for different statuses; retry does not change what "terminal"
  means for cancellation).
- Task Detail also gains a collapsed "Previous attempts" section listing archived attempt numbers,
  each linking to a read-only view of that attempt's artifacts (new `GET
  /tasks/:id/attempts/:attempt/...` read endpoints mirroring the existing per-artifact GETs, e.g.
  `/tasks/:id/attempts/:attempt/reconciliation`).

## Dependencies

None beyond what already exists: `GitWorktreeManager.prepare()`'s existing idempotent self-healing
(§6 of the review) is what makes retry safe for real-mode workspaces without any change to that
class; `continueAfterReconciliation()` (Phase 30) is what makes `run()` itself already reusable
without modification.

## Risks

- **Real-mode double-execution risk**: mitigated by construction, not by a new guard — `retry()`
  always re-runs `prepareRealExecutionWorkspace()` before any implementation call, and
  `GitWorktreeManager.prepare()` already force-removes and recreates the worktree at that path.
  `RealClaudeCodeExecutor.implement()` is never called against a worktree that retry did not just
  (re)prepare. This is the specific hazard the brief called out by name (§7 of the brief prompt)
  and is treated as the top implementation-review item once this proposal is built.
- **Retry storms**: a developer (or a buggy client) repeatedly retrying a task that will
  deterministically fail again (e.g. a permanently broken repository path) burns real Claude CLI
  calls in real mode. Mitigation: no automatic retry is proposed anywhere in this milestone — retry
  is always a single explicit developer action via the button/endpoint, never triggered by the
  orchestrator itself. A rate limit is not proposed as in-scope (no evidence of this being hit;
  add only if observed).
- **Concurrent retry + still-running original attempt**: `POST /tasks/:id/retry` must be rejected
  (409) unless `task.status` is one of `failed | blocked | cancelled` — the same pattern
  `POST /tasks/:id/start` already uses for `created`-only. This fully prevents a retry racing a
  still-in-flight original run.
- **Artifact archive partially fails mid-move**: `archiveAttempt()` must complete (or the retry
  must abort before resetting `task.json`) — a half-archived state would corrupt the "attempt N"
  read endpoints. Treated as a hard precondition: if archiving throws, `retry()` fails the request
  (500) without touching `task.json`, leaving the task exactly as it was, retryable again.
- **Startup sweep racing a task actually still legitimately running** — cannot happen by
  construction: the sweep runs once, synchronously, before `app.listen()`, i.e. before any new
  `orchestrator.run()` call can possibly be in flight in this process, and a *previous* process's
  in-flight work cannot survive to this point (it was a different process).

## Scope

In scope:
- `POST /tasks/:id/retry` for `failed`, `blocked`, `cancelled` tasks.
- Attempt archiving in `ArtifactStore` and read endpoints for prior attempts.
- Startup crash-recovery sweep.
- UI retry button + previous-attempts view.
- `TASK_RETRIED` event type.

## Explicit non-goals

- Fine-grained per-stage resume (e.g. "retry only from implementing, reusing prior specialist
  reports") — restart-from-inspection only, per the review's §16 Future Roadmap reasoning.
- Any change to `resumeAfterConflictResolution()` or the conflict-resolve endpoint — they remain
  the correct, narrower path for the case they already handle (§8 of the review); retry is not a
  replacement for it and the UI must not suggest retry as the primary action for a conflict-blocked
  task (resolve stays primary; retry remains available as a fallback for every blocked task,
  including conflict-blocked ones, since a developer may legitimately prefer to just start over).
- Automatic/scheduled retry of any kind.
- Workspace cleanup / retention policy (Option B) — explicitly deferred, see the review's
  Future Roadmap.
- Any new `TaskStatus` value.
- Rate limiting or quota enforcement on retries.
- Deduplication of candidate lessons across attempts — not needed per §7 of the review.
- Multi-user attribution of who clicked retry (the platform has no auth; `resolvedBy`-style
  free-text attribution is out of scope here, matching how the rest of the platform already has no
  user identity).

## Acceptance criteria

- [ ] `POST /tasks/:id/retry` returns 404 for an unknown task, 409 for a task not in
      `failed | blocked | cancelled`, 202 otherwise.
- [ ] A retried task's `attempt` field increments; its `status` returns to `created` then proceeds
      through the normal lifecycle exactly as a fresh task would (assert full sequence in a test).
- [ ] The previous attempt's specialist reports, reconciliation, plan, execution report, and
      reviews are readable via new `attempts/:attempt/...` endpoints after a retry, unmodified from
      what they were before the retry.
- [ ] `events.log.jsonl` contains a `TASK_RETRIED` event and the full event history from both
      attempts, in order, with no truncation.
- [ ] Real-mode retry: the workspace is genuinely reset — a retry after a real-mode attempt that
      left partial/committed changes in the worktree produces a fresh worktree at the current
      `HEAD` of the source repository, verified via a test asserting the worktree's git log after
      retry contains none of the prior attempt's commits.
  - [ ] `RealClaudeCodeExecutor.implement()` is never invoked without a workspace that the current
      attempt itself prepared (assert via a spy/fixture that `workspaceOf()` is never called
      against a workspace whose `createdAt` predates the current attempt's start).
- [ ] The startup sweep: a task manually left in a mid-flight status in the store, followed by a
      simulated fresh app boot (re-import/re-instantiate the container against the same data
      directory), results in that task becoming `failed` with an error message naming the stage it
      was stuck in, and a `TASK_FAILED` event is appended.
- [ ] A task already in a terminal status at startup is left untouched by the sweep (regression
      guard against over-eager sweeping).
- [ ] `POST /tasks/:id/retry` on a task that is currently mid-flight (not yet terminal) returns 409
      and does not touch the task.
- [ ] UI: Task Detail shows a `[ Retry ]` action for `failed`/`blocked`/`cancelled` tasks and not
      for any other status; clicking it calls the retry endpoint and the page reflects the new
      attempt once the task transitions out of `created`.
- [ ] UI: a conflict-blocked task shows both the existing resolve form and the retry button,
      without implying retry is required or preferred over resolution.
- [ ] All existing 168 tests remain green (regression).

## Testing strategy

- **Unit**: `TaskOrchestrator.retry()` status-precondition table (accept from
  `failed`/`blocked`/`cancelled`, reject from every other status) — mirrors the existing
  `/start` precondition test pattern.
- **Unit**: `ArtifactStore.archiveAttempt()` — files present before archiving are present under
  `attempts/<n>/` after, and absent from the top level; a task with no artifacts yet (edge case:
  retry of a task that failed during `inspect()`, before any artifact beyond `task.json` was
  written) archives cleanly with nothing to move.
- **Integration**: a mock-mode task engineered to fail (e.g. via a stub executor returning a
  failed specialist report), retried, and asserted to reach `completed` on the second attempt —
  the mock-mode analogue of the real-mode worktree-reset test, proving the general retry path.
- **Integration (real-mode-shaped, deterministic fixture)**: extending the pattern already
  established in `reconciliationConflict.e2e.test.ts` — a stub executor that fails on attempt 1 and
  succeeds on attempt 2, driven through the real `TaskOrchestrator`, asserting the workspace-reset
  and no-double-execution properties without needing the actual `claude` CLI.
- **Integration**: startup sweep, using the same `mkdtemp` + fresh `createApp()`-after-manual-
  store-mutation pattern already used in `memoryLoop.e2e.test.ts`/`reconciliationApi.test.ts` — no
  new test infrastructure pattern needed.
- **API**: supertest coverage for `POST /tasks/:id/retry`'s status codes, mirroring
  `reconciliationApi.test.ts`'s structure.
- **Frontend**: `task-detail.component.spec.ts` gains cases for the retry button's visibility
  across statuses and its call-through to `TaskService.retryTask()`, following the existing
  `resolveConflict`/`cancelTask` spec pattern (mock returning `NEVER`, per the fix already
  documented for that gotcha in Phase 30's completion report).
- **Playwright**: not required for this milestone's CI (mock-mode alone cannot easily engineer a
  `failed` task any more than it can engineer a conflict — same limitation Phase 30 documented for
  its own manual validation); a manual/dev-only smoke check is sufficient, documented as such
  rather than claimed as automated coverage.
- No test-count inflation: only add tests exercising a genuinely new code path from the list above.

## Documentation changes

- `README.md`: update the task-status/lifecycle description and doc table (new
  `docs/PHASE_31_PROPOSAL.md`/`PHASE_31_COMPLETION_REPORT.md` entries once built), test-count
  badge.
- `docs/AGENT_WORKFLOW.md`: document the retry entry point alongside the existing pipeline
  description, and the distinction between retry and conflict-resolution resume (review §8).
- `docs/API.md`: document `POST /tasks/:id/retry` and the new `attempts/:attempt/...` read
  endpoints.
- New ADR (`docs/adr/0007-retry-restarts-from-inspection.md`) recording the restart-from-inspection
  decision and the rejected fine-grained-resume alternative, following the existing ADR 0001-0006
  format.
- A `docs/PHASE_31_COMPLETION_REPORT.md`, written only once this milestone is actually implemented
  and validated — not part of this proposal.

## Expected follow-up milestones

1. Workspace lifecycle / cleanup (Option B), sequenced after this milestone per the review's
   dependency note (§10).
2. Fine-grained checkpoint resume, only if real-world usage shows restart-from-inspection is
   materially wasteful (not assumed here).
3. Task-level operation timeouts beyond the existing Claude CLI timeout, only if an actual hang is
   observed.
