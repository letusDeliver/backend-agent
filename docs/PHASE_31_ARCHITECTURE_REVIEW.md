# Phase 31 Architecture Review — Next Milestone Selection

**Status of this document**: analysis only. No product code was changed to produce it. It is the
required first deliverable of the Phase 31 review; the recommended milestone is specified
separately, in implementation-ready form, in `docs/PHASE_31_PROPOSAL.md`.

## 1. Executive Summary

Phase 30 made the orchestrator honest about disagreement: a material conflict between specialists
now blocks the task and requires an explicit developer resolution instead of being silently
concatenated into a plan. Inspecting the codebase to decide what comes next surfaced a more basic
gap sitting underneath that work: **once a task leaves the `created` state, there is exactly one
way out of `blocked` (an unresolved material reconciliation conflict) and zero ways out of
`failed` or a `blocked` task that got there for any other reason.** No retry endpoint exists. The
UI's own cancel button is disabled for `blocked` tasks (`TERMINAL_STATUSES` in
`task-detail.component.ts` and in `routes/tasks.ts` both list `blocked` as terminal). A task that
fails because a flaky test command timed out, or blocks because `NEEDS_USER_DECISION` fired, or
blocks because real-mode workspace preparation failed, is — as of today — permanently inert. The
only recorded action a developer has is to create an entirely new task and lose the specialist
reports, reconciliation, and (for real mode) the git branch already produced.

A second, related gap: **the orchestrator has no memory of its own liveness.** `TaskStore` is a
single JSON file loaded into memory at process start and written through on every mutation, so
task state genuinely survives a server restart on disk — but nothing on restart looks at that
state. A task sitting in `analyzing` when the process is killed stays `analyzing` forever; no
in-flight work resumes, and no code path even flags the task as stuck. This is a plain reliability
hole, not a hypothetical one — Phase 28's real executor already spawns a detached-from-Node's-
lifecycle `claude` CLI child process per specialist/implementation/review call, so a mid-flight
crash can also leave an orphaned OS process and a partially-modified isolated worktree with no
record of either.

Workspace lifecycle (Option B) is real but not urgent: real-mode worktrees already have a working,
unused `GitWorktreeManager.remove()` cleanup primitive, and the current local `tasks/` directory
(18 task workspaces accumulated during this project's own development and testing) is 1.1MB.
Nothing is measured in gigabytes yet, and mock mode — the CI/dev default — never creates a
worktree at all. Recommending workspace cleanup ahead of making failed/blocked tasks actionable
would optimize a currently-harmless cost over a currently-real one.

**Recommended Phase 31 milestone**: a narrowly-scoped **task retry** capability (`POST
/tasks/:id/retry`) for `failed`, `blocked`, and `cancelled` tasks, restarting from Repository
Inspection rather than attempting fine-grained per-stage resume — paired with a **startup crash
sweep** that finds any task left in a non-terminal stage after an unclean shutdown and marks it
`failed` with an explicit, developer-visible reason, so retry has something to act on instead of a
task staying invisibly stuck. See `docs/PHASE_31_PROPOSAL.md` for the full spec.

## 2. Current Task Lifecycle

`TaskStatus` (`server/src/types/index.ts`) is exactly:

```
created | inspecting | routing | analyzing | reconciling | planning
       | implementing | reviewing | completed | failed | blocked | cancelled
```

There is no `queued`, `memory`, or `testing` status distinct from the above — memory retrieval
happens inside the `analyzing`-adjacent phase without its own status (see below), and test
execution happens inside `implementing`/`reviewing` without its own status either. There is also
no `timed_out` status: a `claude` CLI timeout in `RealClaudeCodeExecutor` is caught internally and
turned into a `status: "failed"` specialist/execution/review *report*, which then propagates
through the normal `failed`/`blocked` task-status machinery — not a distinct task-level state.

Actual transitions, read from `TaskOrchestrator.run()` and `continueAfterReconciliation()`
(`server/src/orchestrator/taskOrchestrator.ts`):

```
created
  -> inspecting            (TaskOrchestrator.inspect)
  -> routing                (routeTask)
       -> blocked            [routing.agents.length === 0]
  -> analyzing               (memory retrieval happens here, no separate status —
                               retrieveMemory() runs between routing and analyze())
  -> reconciling              (reconcile())
       -> blocked            [NEEDS_USER_DECISION | UNKNOWN | unresolved material CONFLICT]
  -> planning                 (continueAfterReconciliation)
  -> implementing
  -> reviewing
       -> implementing        (corrective pass, up to config.maxReviewRetries times)
       -> blocked             [review-stage conflict detected, or retries exhausted]
  -> completed

At any point before a terminal status: cancelled, via POST /tasks/:id/cancel
  (checked between phases by TaskOrchestrator.isCancelled(), not preemptively —
   a phase already in flight always finishes before cancellation takes effect)

blocked (material-conflict only) -> reconciling -> [same tail as above]
  via POST /tasks/:id/reconciliation/conflicts/:conflictId/resolve -> resumeAfterConflictResolution()
```

Also: a real-mode-only path, `blocked` if `prepareRealExecutionWorkspace()` fails, sitting between
`routing` and `analyzing`.

**Terminal statuses** (per `TERMINAL_STATUSES` in both `routes/tasks.ts` and
`task-detail.component.ts`, which agree): `completed`, `failed`, `blocked`, `cancelled`. This is
worth flagging on its own: treating `blocked` as terminal for cancellation purposes is what makes
a non-conflict `blocked` task unreachable by *any* existing action — it cannot be cancelled (client
and server both refuse), and nothing resolves it because only the Phase 30 conflict-resolution path
even attempts to un-block a task.

**Resumable today**: only the single case Phase 30 introduced — `blocked` tasks whose *only*
remaining obstacle is an unresolved material `ReconciliationConflict`. Everything else that reaches
`blocked` or `failed` is a dead end.

**Deterministic?** Yes, for a given `Task`, `DetectedStack`, and mock-mode specialist behavior, the
state sequence taken is deterministic — routing, reconciliation, and the review-conflict detector
are all pure functions of their inputs (Phase 30 made this an explicit design constraint for
reconciliation; it already held for routing). Real-mode execution is not deterministic in content
(the `claude` CLI's actual output varies), but the *state machine* — which statuses are visited —
is still driven by the same deterministic control flow.

**Artifact checkpoints**: `ArtifactStore` persists one JSON file per completed phase
(`task.json`, `context/memory-retrieval.json`, `specialist-reports/specialist-<agent>.json`,
`reconciliation.json`, `implementation-plan.json`, `execution-report.json`,
`reviews/review-<agent>-attempt-<n>.json`, `final-handoff.json`), plus an append-only
`events.log.jsonl`. This is more than enough data to *reconstruct what happened*, but nothing
currently reads these artifacts back in to skip re-doing the work they represent — `run()` always
starts fresh from `inspect()`. The artifacts are an audit trail today, not (yet) a resume
mechanism.

## 3. Current Failure Model

| Scenario | What happens today |
|---|---|
| Repository inspection failure (bad path, not a real repo, etc.) | Throws inside `inspect()` → caught by `run()`'s top-level `try/catch` → `handleRunFailure()` → task `failed`, error message recorded, `TASK_FAILED` event. |
| No agent could be routed | Explicit `block()` call, not an exception — task `blocked` with a specific reason. |
| Real-mode workspace preparation failure | Explicit `block()` call — task `blocked`, `task.executionWorkspace.status: "failed"` recorded with the underlying git error. |
| A specialist's `analyze()` fails (mock: doesn't happen; real: `claude` CLI error/timeout) | Caught *inside* `RealClaudeCodeExecutor.analyze()` — returns a `SpecialistReport` with `status: "failed"`, not a thrown error. `reconcile()` then produces `UNKNOWN` if any report failed → task `blocked`. |
| Reconciliation itself throwing | Not caught specially — would propagate to `run()`'s `catch` → `failed`. In practice `reconcile()` is a pure, total function over its inputs (Phase 30), so this is not an observed failure mode, only a theoretical one if a future change introduces a throwing path. |
| Unresolved material conflict | Explicit `block()` — the Phase 30 case, the only one with a resolution path. |
| Claude Code implementation failure/timeout | Caught inside `RealClaudeCodeExecutor.implement()` → `ExecutionReport.status: "failed"`. Nothing in `TaskOrchestrator.implement()` inspects `report.status` before continuing into `reviewLoop()` — **a failed implementation still proceeds to review**, which will presumably fail every review against an unchanged/partially-changed workspace and eventually hit the review-retry ceiling. This is a real, if slow, path to `blocked`, not a fast-fail. |
| Test failures | `TaskOrchestrator.implement()` sets `report.status = "failed"` if any `TestRunResult.status === "failed"`, but — same as above — nothing short-circuits; the task still proceeds into `reviewLoop()`. |
| Review failure (ordinary blocking finding) | Loops a corrective implementation pass, up to `config.maxReviewRetries` (default 2) extra attempts, i.e. 3 review attempts total. Exceeding this → `blocked` with a generic reason (`blockReason` left `undefined`, so the fallback text in `continueAfterReconciliation()` is used). |
| Review-stage conflict (two specialists' blocking findings materially disagree) | Phase 30: detected immediately, no corrective-pass loop attempted, `blocked` with the conflict appended to `reconciliation.json`. |
| Timeout (Claude CLI) | Handled as a `ClaudeCliError` inside the executor, surfaces as a failed report/execution, not a distinct task status. No task-level timeout exists independent of the CLI's own `config.claudeTimeoutMs` (default 120s) — if inspection or routing itself hangs (e.g. a pathological repository), nothing bounds that. |
| Cancellation | `POST /tasks/:id/cancel` writes `status: "cancelled"` directly to the store and calls `executor.cancel(taskId)` (best-effort `SIGTERM`→`SIGKILL` for real mode's tracked child processes). `TaskOrchestrator.isCancelled()` is checked between phases (not preemptively mid-phase), so a phase already running always finishes. |
| Artifact persistence failure (disk full, permissions) | Not specially handled anywhere — `ArtifactStore.writeJson`/`writeFile` calls are unguarded `await`s; a failure here propagates like any other exception into `run()`'s `catch` → `failed`. |
| SSE disconnect | Handled correctly and is not actually a failure mode: `req.on("close")` cleans up the subscription; `history()` replays the persisted `events.log.jsonl` on reconnect so a client that disconnects and reconnects sees everything it missed. No task-level consequence. |
| Server restart mid-task | **Not handled at all.** See §7. |

**Recoverable today, with zero new infrastructure**: only the Phase 30 conflict-resolution case.
**Everything else in the table above needs retry/resume infrastructure of some kind** — this is
the concrete evidence behind recommending Option A's problem space over Option B's.

## 4. Current Workspace Lifecycle

From `GitWorktreeManager` (`server/src/execution/gitWorktree.ts`) and its one caller,
`TaskOrchestrator.prepareRealExecutionWorkspace()`:

- **Created**: only in real-mode, once per task, right after routing succeeds and before memory
  retrieval — `git worktree add -B agent/task-<id> tasks/<id>/workspace <baseRevision>`.
- **Branch naming**: fixed, `agent/task-<id>` — deterministic and collision-free across tasks
  (task ids are UUIDs), but colliding with itself on a retried task id, which is precisely why
  `prepare()` already **self-heals**: it runs `git worktree prune` and, if a directory already
  exists at that path, `git worktree remove --force` before re-adding. **This means re-preparing a
  workspace for the same task id is already safe and idempotent** — a materially useful, already-
  existing primitive for any retry design (see the proposal).
- **Removed**: never automatically. `GitWorktreeManager.remove()` exists and is correct (remove →
  prune → delete branch), but per its own doc comment is "not invoked automatically by any
  lifecycle event in this phase" — it is an unused seam, called from nowhere in the codebase today
  (confirmed: no caller outside its own test file).
- **After success / failure / cancellation / timeout**: identical — the worktree and branch are
  left in place regardless of how the task ended. This is intentional per ADR precedent (Phase 28
  explicitly chose not to auto-delete so a developer can inspect or merge the branch), not an
  oversight, but it does mean disk usage is monotonically non-decreasing for any repository that
  uses real mode.
- **Server crash / process death**: the worktree survives on disk (git worktrees are ordinary
  directories plus a `.git/worktrees/<name>` registration in the *source* repository) — nothing
  about it depends on the Node process staying alive. The Claude CLI child process, however, is a
  child of the orchestrator process; on parent death, orphaned children are an OS/process-group
  concern the code does not manage (no process group creation, no `detached` flag either way —
  Node's default `spawn()` behavior applies, i.e. children typically die with a SIGKILL'd parent on
  most Unix setups, but this is not verified or tested here).
- **Cleanup failure**: `remove()` already treats every step as best-effort (`.catch(() => undefined)`
  on all three git calls) — a failed removal is silently swallowed today, which is safe (never
  throws into a caller) but also invisible (no event, no log) if it were ever wired up.

**Is automatic cleanup currently safe?** Not turnkey-safe without more decisions: a worktree tied
to a `blocked` task that a developer intends to retry or resolve must not be swept by a naive
"delete everything for terminal tasks" policy, since `retry`/`resumeAfterConflictResolution` both
need that workspace (or a freshly-reset version of it) later. Any cleanup policy has to be aware of
whether a task is *actually* done being acted on, which — absent retry — is currently
indistinguishable from "task reached a terminal status." This is itself an argument for sequencing
retry before cleanup: cleanup policy is easier to define correctly once "is this task still
retryable" is a real, answerable question.

## 5. Server Restart Analysis

This is, as the brief anticipated, the single most consequential finding.

**What survives:**
- All `Task` records, at whatever status they were last persisted at (`JsonFileTaskStore` writes
  through synchronously on every `update()`/`create()`, and reloads from disk on first access after
  a restart — nothing is lost that was successfully written before the crash).
- All artifacts already written (`ArtifactStore` writes are synchronous per-call, not buffered).
- Real-mode git worktrees and branches (ordinary filesystem/git state, independent of the Node
  process).
- The `events.log.jsonl` history, replayable to any reconnecting SSE client.

**What is lost:**
- Any in-flight, not-yet-persisted step. Since every phase transition calls `persist()` before
  starting the next phase's work, the window of loss is bounded to "whatever was executing at
  crash time," not the whole task — e.g. if the process dies mid-`analyze()`, `task.status` is
  already durably `"analyzing"` (set before `analyze()` is called), so the *fact* that the task got
  that far is not lost, only the in-progress specialist calls themselves.
- The in-memory `EventEmitter` subscriber list in `TaskEventBus` — any currently-open SSE
  connections are simply dropped (the client's browser will see the connection close; reconnecting
  gets full replay from disk, so this is a UX blip, not data loss).
- Any real-mode Claude CLI child process — killed with its parent (or orphaned, per §4), either
  way not cleanly finished.

**Can the platform recover today?** No. On restart, `index.ts` does nothing but call
`createApp()` and `app.listen()` — there is no code anywhere that lists existing tasks and checks
whether any are stuck in a non-terminal, non-`created` status. A task last seen `analyzing` before
a crash stays `status: "analyzing"` in the store forever. The UI's `isTerminal()` check (mirrored
from the server's `TERMINAL_STATUSES`) does not include `analyzing`, so the Task Detail page for
such a task would keep rendering it as "in progress," including a live progress stepper, with no
SSE events ever arriving again (the emitter that would have delivered them no longer has that
history queued — only *future* events append to the log; nothing is generated for a task whose
orchestration promise simply vanished with the old process). This is a silent, indefinite hang from
the developer's point of view — worse than a visible failure.

This single gap is why the Phase 31 recommendation pairs a startup sweep with retry: retry alone
would still leave crash-orphaned tasks invisible and un-retriable (they don't look `failed` or
`blocked`, so no "retry" affordance would ever show for them); a sweep alone would produce visible
`failed` tasks with no way to act on them beyond creating a new task from scratch. Together they
close the actual gap: **detect on startup → surface as `failed` → retry restarts it.**

## 6. Workspace / Real Execution Interaction

`RealClaudeCodeExecutor` refuses to run against anything but `task.executionWorkspace` (throws if
absent or not `"ready"`, per `workspaceOf()`) — it never falls back to `task.repository` directly.
Combined with `GitWorktreeManager.prepare()`'s existing self-healing (prune + force-remove +
recreate on the same path), **retrying a task that already has a workspace is already safe to
implement as "call `prepareRealExecutionWorkspace()` again"**: the old worktree is discarded and a
fresh one is created at the same base revision the *retry* observes at retry time (not the
original attempt's base revision — this is a deliberate, documented choice in the proposal, not an
oversight: re-inspecting from the current `HEAD` is what lets a developer fix something in their
repo and have a retry actually pick it up).

The one behavior that must never happen, per the brief's explicit warning: retry must never call
`executor.implement()` against a workspace it did not just (re)prepare — i.e., retry cannot resume
"from implementing onward" reusing the *original* attempt's worktree without first re-running
`prepareRealExecutionWorkspace()`, because that worktree's state (partially committed changes,
possibly a failed mid-commit) is not verified safe to build on. The proposal's restart-from-
inspection design sidesteps this entirely by always re-preparing before any real execution call.

## 7. Memory Interaction Under Retry

`generateCandidateLessons()` is only ever called from `handoff()`, which is only ever reached via
`continueAfterReconciliation()` completing successfully — i.e., **only a task that reaches
`completed` can produce candidate lessons today.** A `failed` or `blocked` task, retried or not,
never has generated any candidate lesson to worry about duplicating, and a task that fails *after*
completing (impossible in the current state machine — `completed` is terminal, nothing transitions
out of it) cannot happen. This means the retry design does not need new candidate-lesson
deduplication logic for its initial scope: **a retried task that eventually completes runs
`generateCandidateLessons()` exactly once, exactly like a fresh task, because retry always produces
a normal `completed` transition through the normal `handoff()` call.** The existing invariant from
Phase 29 — "failed or incomplete engineering work must not silently become trusted memory" — is
preserved automatically, not by new code.

The one nuance worth documenting rather than solving: two *separate* attempts at the same
underlying task requirement (an original run plus a retried run, both reaching `completed`, e.g.
if a developer retries a task that had already actually finished successfully but was cancelled by
mistake) could each generate their own candidate lessons from what may be near-duplicate
reconciliation decisions. This was already possible before Phase 31 (nothing stops two *separate*
tasks with the same requirement from both completing and both generating similar candidates), and
human approval (Phase 29's gate) is exactly the existing mechanism that catches it — no new
deduplication is proposed.

## 8. Conflict Interaction Under Retry

`resumeAfterConflictResolution()` (Phase 30) is a *distinct, narrower* mechanism from the retry
being proposed here, and the two must stay distinct rather than merge:

- **Resume** (existing): only for `blocked` tasks whose *sole* remaining obstacle is an unresolved
  material conflict. Reuses the already-computed `reconciliation.json`, the already-computed
  `task.selectedAgents`, and does not re-run inspection, routing, memory retrieval, or specialist
  analysis. This is precisely correct for its scope — the developer's resolution *is* the missing
  input, and everything else is still valid.
- **Retry** (proposed): for any `failed`/`blocked`/`cancelled` task, restarts from Repository
  Inspection. If retry is invoked on a `blocked`-by-conflict task instead of using the resolve
  endpoint, reconciliation runs fresh — the old `reconciliation.json` (including any resolution
  provenance already recorded on it) is archived under the task's attempt history, not reused, and
  a brand-new reconciliation is computed from brand-new specialist reports. If the same conflict
  still exists in the (possibly changed) repository, it will simply reappear as a *new* conflict
  record needing a *new* resolution — this is correct, not a regression: retry's whole premise is
  "re-derive everything from current ground truth," and an already-resolved conflict is not ground
  truth, it's a developer decision about a specific prior analysis.

Put plainly: **resolving a conflict should almost always use the resolve endpoint, not retry** —
retry is the fallback for cases resume cannot handle (genuine failures, non-conflict blocks,
crash-orphaned tasks), and it intentionally does not try to be a superset of resume. The proposal
states this as an explicit UX/API design point, not an implementation detail.

## 9. Architecture Assessment

| Component | Assessment | Why |
|---|---|---|
| `TaskStore` / `JsonFileTaskStore` | **EXTEND** | Structurally sufficient (durable, serialized writes) for a retry's needs — just needs a new field or two on `Task` (attempt count, prior-attempt references) and, for the startup sweep, a `list()` call it already supports. No storage-engine change needed at this scale (18 tasks / 1.1MB observed). |
| `ArtifactStore` | **EXTEND** | The one-JSON-file-per-artifact layout under `tasks/<id>/` needs an attempt-namespacing convention (e.g. archiving the previous attempt's files under `tasks/<id>/attempts/<n>/` before a retry overwrites the top-level ones) so a retried task doesn't destroy its own audit trail. This is additive, not a rewrite. |
| `MemoryStore` | **KEEP** | No interaction change required — see §7. |
| `ClaudeCodeExecutor` (interface + Mock/Real) | **KEEP** | The interface is already attempt-agnostic (stateless per call, keyed by `task.id`). `RealClaudeCodeExecutor`'s per-task `activeProcesses`/`cancelRequested` maps are already keyed correctly for a task being retried after its prior attempt's processes have exited. No change needed. |
| Git/worktree abstraction (`GitWorktreeManager`) | **KEEP** | Already idempotent/self-healing for the same task id (§6). Its unused `remove()` is exactly what a future workspace-lifecycle milestone (Option B) will build on — no rework needed now. |
| Task state machine | **EXTEND** | No new `TaskStatus` values are needed for retry (it reuses the existing sequence starting from `inspecting`); only a new `EventType` (`TASK_RETRIED`) and a couple of `Task` fields. A genuinely new status is warranted only if a future milestone needs to distinguish "first attempt" from "retry" *while in progress* in the UI — not required for this milestone's acceptance criteria. |
| Orchestrator (`TaskOrchestrator`) | **EXTEND** | `run()` already re-derives everything from `task` + repository state each time it's called; a `retry()` entry point is a thin wrapper that resets the relevant `Task` fields and archives prior artifacts before delegating to the same `run()` — this is a natural extension of the exact refactor Phase 30 already did (`continueAfterReconciliation()` extracted specifically to be a shared tail). |
| SSE / `TaskEventBus` | **KEEP** | Already replay-safe across reconnects (§5). No change needed for retry; a startup sweep publishing a synthetic `TASK_FAILED` for crash-orphaned tasks uses the existing `publish()` path unmodified. |

No component needs **REFACTOR** or **REPLACE** for the recommended milestone — this is consistent
with the brief's instruction not to over-engineer: the existing abstractions were already built
with enough seams (the Phase 30 `continueAfterReconciliation()` extraction, the already-idempotent
`GitWorktreeManager.prepare()`) that retry is additive.

## 10. Candidate Milestone Comparison

| Candidate | Developer Value | Risk Reduction | Complexity | Dependencies | Unlocks |
|---|---|---|---|---|---|
| **Retry/Resume** (general, restart-from-inspection scope) | High — every task that currently dead-ends (`failed`, non-conflict `blocked`, `cancelled`) becomes actionable without recreating the task and losing its history. Directly fixes a UI/API state (disabled cancel on `blocked`, no retry anywhere) a developer would hit on their very first non-happy-path task. | High — closes the server-restart silent-hang gap (§5), which is a correctness bug, not a missing feature, once paired with the startup sweep. | Medium — no new `TaskStatus`, no new external dependency; mainly artifact-namespacing and a new orchestrator entry point reusing existing `run()`. | None beyond what exists (reuses `GitWorktreeManager.prepare()`'s idempotency, `TaskStore`, `ArtifactStore`). | A real cleanup policy becomes definable (§4) once "is this task still retryable" is answerable; also unblocks meaningfully testing real-mode failure paths end-to-end. |
| **Workspace Lifecycle / Cleanup** | Medium — real mode only, and disk cost is currently trivial (1.1MB / 18 workspaces in this project's own dev history). No mock-mode developer is affected at all. | Medium — prevents *future* unbounded disk growth, not a present incident. | Medium — retention states, safety checks against touching the developer's original repo (already handled at creation time by `assertSafeRepositoryPath`, but cleanup needs its own equivalent care), discovery of "stale" worktrees after a crash. | Weak dependency on retry: cleanup policy is safer to define once retry exists, so it can distinguish "terminal and done" from "terminal but retryable." Doing cleanup first risks deleting a workspace a developer would have wanted to retry against. | Predictable disk usage at scale; not currently blocking anything else. |
| **Other candidate considered: task-level operation timeout / hang detection** (e.g. bounding `inspect()`/`routeTask()` themselves, not just the Claude CLI call) | Low-medium — no evidence in the codebase of this ever having actually hung (routing/inspection are fast, local filesystem/git operations); speculative. | Low — no observed incidents. | Low, but solves a problem that hasn't been shown to exist. | None. | Marginal — would mostly matter for pathological repositories, not the platform's core reliability gap. |

The comparison itself, not a score, is the basis for the recommendation: retry/resume is the only
candidate that (a) fixes something demonstrably and completely broken today (dead-end `blocked`/
`failed` tasks, the disabled-cancel dead end) rather than a cost that is merely growing, and (b)
directly addresses the restart-safety gap the brief flagged as especially important, with the least
new surface area given how much of the groundwork (idempotent worktree prep, the
`continueAfterReconciliation()` extraction) Phase 28/30 already laid.

## 11. Recommended Phase 31

See `docs/PHASE_31_PROPOSAL.md` for the full implementation-ready specification. Summary:

**Task Retry for `failed` / `blocked` / `cancelled` tasks, restarting from Repository Inspection,
plus a startup crash-recovery sweep that surfaces orphaned in-flight tasks as retryable `failed`
tasks.**

## 12. Proposed Architecture

`POST /tasks/:id/retry` → validates the task is in a retryable status → archives the current
attempt's artifacts under `tasks/:id/attempts/<n>/` → resets the task record (new `attempt` number,
cleared `error`/`executionWorkspace`, status back to `created`) → invokes the existing
`orchestrator.run(taskId)`, unchanged. A startup routine in `index.ts` (invoked once, before
`app.listen()`) lists all tasks via the existing `taskStore.list()`, finds any whose status is one
of the mid-flight values (`inspecting`, `routing`, `analyzing`, `reconciling`, `planning`,
`implementing`, `reviewing`), and transitions each to `failed` with a specific "orchestrator
restarted while this task was in progress" error via the existing `handleRunFailure`-equivalent
path, publishing `TASK_FAILED`. No new services, no new stores, no new runtime processes.

## 13. Acceptance Criteria

See `docs/PHASE_31_PROPOSAL.md` §Acceptance Criteria for the full list.

## 14. Testing Strategy

See `docs/PHASE_31_PROPOSAL.md` §Testing Strategy.

## 15. Risks

See `docs/PHASE_31_PROPOSAL.md` §Risks.

## 16. Non-Goals

See `docs/PHASE_31_PROPOSAL.md` §Explicit Non-Goals.

## Future Roadmap (beyond Phase 31)

1. **Workspace lifecycle / cleanup (Option B)**, once retry has shipped and "retryable" is a real,
   checkable predicate a cleanup policy can consult — likely the direct next milestone after this
   one, per §10's dependency note.
2. **Fine-grained checkpoint resume** (e.g. "retry only implementation, reusing existing specialist
   reports and reconciliation") — deliberately deferred here as an over-engineering risk relative
   to demonstrated need; restart-from-inspection is cheap enough in both mock and real mode for an
   MVP's task volume, and re-deriving from current repository state is arguably *more* correct for
   the common case (developer fixed something, then retried) than resuming a stale checkpoint would
   be. Revisit only if real-mode Claude CLI cost/latency makes full re-analysis genuinely expensive
   at observed usage.
3. **Task-level operation timeouts** beyond the existing Claude CLI timeout, if a real hang is ever
   observed (not speculative-only, per §10).
4. Semantic/vector memory retrieval — unrelated to this review, carried over from the existing
   Phase 29/30 known-gaps list, unaffected by this milestone either way.
