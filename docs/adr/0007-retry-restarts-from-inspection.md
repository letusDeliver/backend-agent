# ADR 0007 — Retry restarts from repository inspection, not from the failed stage

**Status**: Accepted (Phase 31)

## Context

Before this phase, every task that reached `failed`, or `blocked` for any reason other than a
Phase 30 conflict, was permanently inert: no API endpoint and no UI control could move it
anywhere. Separately, an unclean server restart left a mid-flight task silently stuck in a
non-terminal status forever — invisible as a failure, and unreachable by any future feature that
only looks at `failed`/`blocked`. Both gaps share the same fix shape: give the developer (and, for
the restart case, the platform itself) a safe way to say "start this task over." See
`docs/PHASE_31_PROPOSAL.md` and `docs/PHASE_31_ARCHITECTURE_REVIEW.md` for the full investigation
this decision is derived from.

## Decision

- **Retry restarts the entire pipeline from repository inspection.** `POST /tasks/:id/retry`
  resets a `failed`/`blocked`/`cancelled` task's `status` to `created`, increments `Task.attempt`,
  and calls the existing `TaskOrchestrator.run()` unmodified — routing, memory retrieval,
  specialist analysis, reconciliation, planning, implementation and review all run again exactly
  as they would for a brand-new task.
- **No fine-grained checkpoint resume** (e.g. "retry only from implementing, reusing prior
  specialist reports") is implemented. `run()` already re-derives everything from `Task` + live
  repository state with no attempt-aware branching; a resume mechanism would require threading
  attempt-awareness through every stage for a benefit that isn't yet demonstrated as necessary.
- **Attempt history is archived, not duplicated onto `Task`.** `Task` gains a single `attempt:
  number` field; there is no `attempts: Attempt[]` list on the record itself. A retry archives the
  current attempt's artifacts (`ArtifactStore.archiveAttempt()`) into `tasks/<id>/attempts/<n>/`
  before resetting the task — specialist reports, reconciliation, implementation plan, execution
  report, reviews, context and final handoff all move; `task.json` and `events.log.jsonl` never
  do. The event log stays one continuous, append-only history across every attempt, with a new
  `TASK_RETRIED` event marking each boundary — consistent with how the event log already worked
  before this phase.
- **Real-mode git safety is achieved by construction, not a new guard.** Retry always re-runs
  `prepareRealExecutionWorkspace()` before any implementation call, exactly like a fresh task does,
  and `GitWorktreeManager.prepare()` already force-prunes and `worktree remove --force`s any
  existing worktree at the task's fixed workspace path before creating a fresh one at the
  repository's current `HEAD` (`git worktree add -B <branch> <path> <revision>` resets an
  already-existing branch ref, verified directly against real git state in
  `server/tests/taskRetryRealMode.test.ts`). No new locking, staleness-check, or
  double-execution-prevention code was added — the existing self-healing behavior already provides
  the guarantee.
- **Startup crash recovery only corrects status; it never resumes work.** A sweep
  (`recoverOrphanedTasks()`) runs once, synchronously, before `app.listen()`. Any task found in a
  non-terminal, non-`created` status is transitioned straight to `failed`, naming the stage it was
  interrupted at — there is no in-flight work to resume, since the process that was running it no
  longer exists. The developer (or a future automated policy, out of scope here) then retries it
  through the same endpoint as any other failed task.
- **No new `TaskStatus` value.** Retry reuses `created` as its starting status and the existing
  in-flight statuses as-is; a retried task is indistinguishable in the state machine from a fresh
  one except for its `attempt` field and archived history.
- **Retry is always an explicit developer action.** No automatic or scheduled retry is
  implemented anywhere in this milestone — `run()` never calls `retry()`, and nothing retries a
  task without a `POST /tasks/:id/retry` call.

## Alternatives considered

- **Fine-grained resume from the failed stage** (e.g. reuse prior specialist reports and only
  re-run implementation): rejected for this milestone. It would require every stage to become
  attempt-aware and would make "what actually ran for this completion" harder to audit — a
  fresh, full pipeline run is unambiguous evidence, matching the platform's existing preference for
  ground-truth over inferred state (Phase 28's `git diff`-over-self-report, Phase 30's
  deterministic conflict detection). Deferred to a later milestone, only if real-world usage shows
  restart-from-inspection is materially wasteful — not assumed here.
- **A dedicated `Attempt` domain object with its own store**: rejected — the archived-artifacts
  layout under `tasks/<id>/attempts/<n>/` already gives full history with zero new storage
  infrastructure, consistent with this MVP's JSON-file-workspace-first design. Revisit only if a
  future feature needs to query across attempts in a way a directory listing can't support.
  See `[[project_status]]`-style precedent: every prior phase (28, 29, 30) added fields to existing
  records rather than new stores where a directory-based artifact was sufficient.
- **A new `retrying`/`recovering` `TaskStatus`**: rejected — nothing in the state machine needs to
  distinguish "this is a retried attempt currently inspecting" from "this is a first attempt
  currently inspecting"; `attempt` already carries that distinction where it matters (archived
  history, UI attempt badge), and a new status would be pure ceremony.
- **Orchestrator-driven automatic resume for orphaned tasks at startup**: rejected — the process
  that was running the task is gone; there is no partial in-memory state to resume, only a
  correction to make. Automatically re-running the pipeline on every orphaned task at boot would
  also silently burn real Claude CLI calls in real mode without developer intent, which the
  proposal's "Retry storms" risk section explicitly calls out as something to avoid.

## Consequences

- A retried task's `currentStage`/`status` timeline is a second, independent traversal — the UI's
  stage timeline (`STAGE_SEQUENCE` in `task-detail.component.ts`) reflects only the current
  attempt; prior attempts are inspected separately via the read-only "Previous Attempts" section
  and the `attempts/:attempt/...` API, not blended into the live timeline.
- Retrying a task that will deterministically fail again (e.g. a permanently broken repository
  path) is possible to do repeatedly, burning real Claude CLI calls in real mode. No rate limit is
  introduced — there is no evidence yet that this is actually hit in practice; the mitigation
  already in place is that retry is never automatic, only ever an explicit developer action.
- `ArtifactStore.archiveAttempt()` uses per-file `rename()` rather than a single atomic
  transaction. A failure partway through leaves some artifacts already moved and others still at
  the top level — nothing is lost (everything is still findable at one location or the other), and
  `TaskOrchestrator.retry()` never resets `task.json` unless archiving resolves without throwing,
  so a failed archive attempt is always safely retryable.
- Workspace lifecycle / cleanup for completed or abandoned real-mode git worktrees remains
  out of scope for this milestone, as it was for Phase 28 — retry does not change when or whether
  a worktree is ever deleted, only that it is force-recreated on the next real-mode run.
