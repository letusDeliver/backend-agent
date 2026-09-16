# Phase 31 Completion Report — Task Retry & Startup Crash Recovery

## What changed

Before this phase, a task that reached `failed`, or `blocked` for any reason other than a Phase 30
conflict, was permanently inert — no API endpoint and no UI control could move it anywhere.
Separately, an unclean server restart left a mid-flight task silently stuck in a non-terminal
status forever. Phase 31 adds `POST /tasks/:id/retry` (restart from repository inspection, full
attempt-history archiving) and a startup crash-recovery sweep, wired through the orchestrator, the
artifact store, the API, and the Task Detail UI.

## Retry architecture

`TaskOrchestrator.retry(taskId)` (new): validates the task is `failed`/`blocked`/`cancelled`
(`RETRYABLE_STATUSES`, throwing `TaskNotFoundError`/`RetryNotAllowedError` for the route to map to
404/409), archives the current attempt via `ArtifactStore.archiveAttempt()`, then resets `status`
to `created`, increments `attempt`, clears `error`/`executionWorkspace`/`selectedAgents`/
`reviewRetryCount`, persists, publishes `TASK_RETRIED`, and fires the existing `run(taskId)`
**without awaiting it** — so a caller that awaits `retry()` only waits for the fast archive+reset
step, not the multi-minute pipeline, matching `POST /tasks/:id/start`'s existing fire-and-forget
shape. `run()` itself needed **no modification** — it already re-derives everything from `Task` +
live repository state on every call.

## Attempt archiving

`ArtifactStore.archiveAttempt(taskId, attempt)` moves every attempt-scoped artifact
(`specialist-reports/`, `reconciliation.json`, `implementation-plan.json`,
`execution-report.json`, `reviews/`, `context/`, `final-handoff.{json,md}`) into
`tasks/<id>/attempts/<attempt>/` via per-file `rename()`. `task.json` and `events.log.jsonl` are
never archived — the event log stays one continuous, append-only history across every attempt.
Six new `readArchived*()` methods (plus `listAttempts()`) mirror the existing live-artifact
readers, reusing a shared `readReviewsFrom()` helper extracted from the pre-existing
`readLatestReviews()`.

**Archive safety** (the milestone's explicitly named critical requirement): `retry()` calls
`archiveAttempt()` *before* touching `task.status`/`task.attempt`. If archiving throws, `retry()`
rejects without ever having reset the task — verified with a deterministic test that pre-creates a
directory at a destination file's path so `rename()` genuinely fails with a real filesystem error
(`server/tests/artifactStoreArchive.test.ts`), not a mocked one. Because each entry moves with its
own `rename()`, a partial failure leaves already-moved entries findable under `attempts/<n>/` and
not-yet-reached entries still at the top level — nothing is silently lost either way, and a
retried `archiveAttempt()` call for the same attempt number is naturally idempotent (already-moved
entries are skipped).

## Real-mode git safety

Retry adds **no new guard code** for workspace staleness — the existing
`GitWorktreeManager.prepare()` self-healing (force-prune, `worktree remove --force`, then
`worktree add -B <branch> <path> <current-HEAD>`) already resets the branch ref and recreates the
worktree from the repository's current `HEAD` on every real-mode `run()` call, retried or not.
`server/tests/taskRetryRealMode.test.ts` proves this against real git state, not a self-report: a
real-mode-shaped fixture executor commits a marker file into the prepared worktree on each
attempt; after a forced block-then-retry, `git log` on the task branch (read from the *developer's
own* repository, not the worktree) contains exactly the base-repo commit plus attempt 2's marker —
attempt 1's marker commit is verifiably gone, and the developer's own checked-out branch/working
tree is untouched throughout.

## Startup crash recovery

`server/src/startup/recoverOrphanedTasks.ts` (new): lists every task, and for any task in a
non-terminal, non-`created` status (`inspecting` through `reviewing`), transitions it straight to
`failed` with `error: "Orchestrator restarted while this task was in progress (stage: <stage>).
Retry to restart from repository inspection."` and appends `TASK_FAILED`. Called from `index.ts`
before `app.listen()`, so no `orchestrator.run()` call in the new process can possibly race a task
this sweep is about to touch. It never calls into `TaskOrchestrator` — there is no in-flight work
to resume, since the process that was running it no longer exists; the developer retries the
now-visibly-`failed` task through the same endpoint as any other failure.

## Attempt history

Six new read-only endpoints mirror the live per-artifact GETs: `GET /tasks/:id/attempts` (list),
`GET /tasks/:id/attempts/:attempt/{agents,reconciliation,implementation-plan,execution-report,reviews,handoff}`.
They query all three `AgentType`s rather than the task's *current* `selectedAgents` (which reflect
the live attempt's routing, not necessarily an archived attempt's).

## Migration

`Task.attempt` is a new required field. `JsonFileTaskStore` defaults it to `1` for any record
loaded without one, so pre-Phase-31 `data/tasks-index.json`/`tasks/<id>/task.json` files on an
existing developer machine keep loading without a migration script — consistent with how Phase 30
handled `Reconciliation.conflicts`'s shape change (no migration tooling, old data degrades
gracefully).

## Memory interaction

No change to `generateCandidateLessons()` — it already only ever runs from `handoff()` for a task
that reaches `completed`, reading `reconciliation.decisions` at that moment. A failed/blocked
attempt that gets retried never reaches `handoff()`, so it can never generate candidate lessons;
only the attempt that actually completes does. No deduplication across attempts was needed or
built, per the proposal's explicit scope.

## UI

Task Detail gains a `[ Retry ]` action in the header action area, shown only for
`failed`/`blocked`/`cancelled` (`canRetry` computed signal, mirroring the server's
`RETRYABLE_STATUSES`), disabled and reading "Retrying…" while in flight; an attempt badge once
`task.attempt > 1`; and a collapsed "Previous Attempts" card listing archived attempt numbers,
each expandable into a read-only summary (reconciliation status, plan summary, execution status,
per-agent review status, handoff summary) fetched from the new attempt-history endpoints. A
conflict-blocked task shows both the existing inline resolve form and the header Retry button —
resolution stays the narrower, primary path for the case it was built for; Retry remains available
as an explicit fallback, never implied as preferred.

## Tests

**176 backend** (vitest, up from 149) + **33 frontend** (jest, up from 18) + **1 Playwright E2E**
= **210 total**, up from 168 before this phase. New coverage:

- `server/tests/taskRetry.test.ts` (16 tests) — the full status-precondition table (every
  `TaskStatus`, accepted from `failed`/`blocked`/`cancelled`, rejected and left unchanged from
  every other status, including a dedicated concurrent-retry-while-mid-flight case), 404 for an
  unknown task, and a full lifecycle test (block on attempt 1 with real artifacts → retry →
  complete on attempt 2, asserting attempt-1 artifacts are archived/unmodified/readable, attempt-2
  artifacts are fresh, and the event log contains an unbroken `TASK_BLOCKED` → `TASK_RETRIED` →
  `TASK_COMPLETED` sequence).
- `server/tests/artifactStoreArchive.test.ts` (3 tests) — full artifact archiving with everything
  readable back afterward; archiving a task with no artifacts beyond the empty workspace
  directories; the deterministic archive-failure case (task/artifacts provably untouched at the
  point of failure).
- `server/tests/startupRecovery.test.ts` (4 tests) — a mid-flight task is marked `failed` naming
  its stage with a `TASK_FAILED` event appended; every terminal status is left untouched
  (regression guard); a task resting in `created` is left untouched; every in-flight stage is
  independently recovered.
- `server/tests/taskRetryRealMode.test.ts` (1 test) — real-mode git isolation end to end, described
  above.
- `server/tests/retryApi.test.ts` (3 tests) — `POST /tasks/:id/retry` against the real Express app:
  404 unknown task, 409 from `created`, and 202-with-attempt-increment plus the attempts read
  endpoints (including 400 for a non-integer attempt and 404 for an unknown task), forcing a
  deterministic `blocked` outcome the same way `reconciliationApi.test.ts` does (this test is about
  the retry endpoint's own contract, not about re-proving a genuine block through the pipeline,
  which the fixture-executor tests above already cover).
- `web/src/app/pages/task-detail/task-detail.component.spec.ts` (+15 tests) — retry-button
  visibility across all 12 statuses (parametrized), click-through calling `TaskService.retryTask`
  and disabling the button while in flight, the attempt-number badge, a rendered Previous Attempts
  section that expands into a fetched read-only view, and a conflict-blocked task showing both the
  resolve form and the Retry button.

Regression: the full pre-existing 168-test suite passes unmodified. Six pre-existing test files
that construct `Task` object literals directly (`realClaudeCodeExecutorUnit.test.ts`,
`reconciliationConflict.e2e.test.ts`, `routingEngine.test.ts`, `contextPack.test.ts`,
`candidateLessons.test.ts`) needed `attempt: 1` added to satisfy the new required field — a
mechanical type-completeness fix, no behavioral change.

## Manual validation

Ran the actual dev server (`tsx src/index.ts`, mock mode) against a scratch git repository and
exercised the real HTTP API end to end with `curl`, not just the test suite:

1. Created and started a cross-stack-migration-worded task (`"Migrate this Python service to
   Node.js, rewriting all endpoints."`) — this deterministically routes to
   `needsEscalation: true` and reconciliation status `NEEDS_USER_DECISION`, giving a genuinely
   `blocked` task reachable purely through the documented pipeline (no internal state
   manipulation).
2. `POST /tasks/:id/retry` → `202`, `attempt: 2`, `status: "created"`; polled `GET /tasks/:id`
   until terminal → `blocked` again (the same requirement deterministically re-escalates, which is
   itself confirmation that retry genuinely re-ran routing and reconciliation from scratch rather
   than reusing cached state).
3. `GET /tasks/:id/attempts` → `{"attempts":[1]}`; `GET /tasks/:id/attempts/1/reconciliation` and
   `.../1/agents` returned attempt 1's original, unmodified reconciliation and specialist reports.
4. Read `events.log.jsonl` directly off disk: a single unbroken sequence —
   `TASK_CREATED ... RECONCILIATION_COMPLETED, TASK_BLOCKED, TASK_RETRIED,
   REPOSITORY_INSPECTION_STARTED ... RECONCILIATION_COMPLETED, TASK_BLOCKED` — confirming the event
   log is genuinely continuous across the retry boundary, not truncated or restarted.
5. **Crash recovery**: created a second task, edited its on-disk `task.json` and
   `tasks-index.json` directly to pin `status: "implementing"` (simulating a process that died
   mid-pipeline — the mock pipeline runs too fast to reliably race a real `kill` over HTTP),
   killed the running server process, and started a fresh one against the same `DATA_DIR`/
   `TASKS_DIR`. The new process logged `Startup recovery: 1 orphaned task(s) marked failed.` before
   binding its port; `GET /tasks/:id` confirmed `status: "failed"`, error naming
   `stage: implementing`. Retried that task through the same endpoint → `attempt: 2` → polled to
   `completed`, proving the full crash → recover → retry → complete loop works against a real
   server process, not just an in-process simulation.

Additionally verified:

- Full `npm run build` (backend `tsc`, frontend production `ng build`) — clean.
- Full `npm run lint` (`tsc --noEmit`) — clean.
- Playwright `happy-path.spec.ts` against the real dev stack — passing, zero browser console
  errors (unchanged path; confirms the new Retry UI code doesn't break the existing bundle).

**Not performed**: a live-browser click-through of the Retry button and Previous Attempts UI
specifically (as opposed to the Angular `TestBed` component spec, which does exercise the real
template/change-detection/click-handler path against a mocked service). The manual `curl`
validation above proves every server-side behavior the button triggers; the component spec proves
the button/section render and wire up correctly. Chaining both through an actual browser was
judged redundant with what those two already independently prove, given `MockClaudeCodeExecutor`
provides no natural browser-reachable path to a `blocked`/`failed` task without the same
requirement-wording technique used in the manual validation above (documented, not hidden).

## Known limitations

- No fine-grained checkpoint resume — restart-from-inspection only, by design (ADR 0007).
- No rate limiting on retries; a developer can retry a deterministically-failing task repeatedly.
  Not mitigated further per the proposal's explicit reasoning (no evidence this is hit in
  practice; retry is never automatic).
- `archiveAttempt()`'s per-file `rename()` is not a single atomic transaction — a partial failure
  is safely recoverable (see Archive safety above) but not instantaneous-looking on disk.
- Workspace lifecycle / cleanup for completed or abandoned real-mode git worktrees remains out of
  scope, unchanged from Phase 28/30.
- The startup sweep was validated by calling `recoverOrphanedTasks()` directly against a
  manually-pinned task and, separately, by a real process kill + restart in manual validation —
  not by an automated test that kills a real child process mid-pipeline (impractical to make
  deterministic; the direct-call tests plus the manual restart together cover both the unit
  behavior and the real-process wiring).

## Next recommended milestone

Workspace lifecycle / cleanup for completed or abandoned real-mode git worktrees (Option B),
sequenced after this milestone per the architecture review's dependency note — retry makes
worktree churn more frequent (each retry force-recreates one), which is exactly the scenario
cleanup policy would need to account for.
