# Phase 39 Completion Report — Backlog Decomposition

**Status**: Complete.

## Problem

A real-mode test against a genuinely empty repository (School-Management-Backend-Nodejs-Agentic-development,
this session) proved the platform's single-pass pipeline has a hard ceiling: `implement()` is one
non-interactive `claude` CLI call, and a full greenfield backend (auth + several entities + tests)
was killed by `config.claudeTimeoutMs` (120s) on all 3 attempts, every time, confirmed from raw
event-log timestamps almost exactly 120s apart. Zero files were ever committed; review correctly
found nothing implemented and the task honestly blocked. Named as a next-milestone candidate in both
the Phase 36 and 37 completion reports.

## Implementation

### A. Types

- `Task.decomposeRequirement?: boolean` (default `false` — every existing/default task behaves
  exactly as before) and `Task.subtasks?: Subtask[]`.
- `Subtask { id, index, total, title, description, status }` — status mirrors the pipeline's own
  implement → review cycle, scoped to one step.
- `TaskCreateInput.decomposeRequirement?: boolean`.
- New `EventType`s: `SUBTASKS_DECOMPOSED`, `SUBTASK_STARTED`, `SUBTASK_COMPLETED`, `SUBTASK_BLOCKED`.

### B. Executor capability

`decomposeRequirement({ task, plan, reconciliation }): Promise<SubtaskDefinition[]>` — one call per
task, right after planning, only when opted in. `MockClaudeCodeExecutor`'s heuristic splits a
numbered requirement ("(1) ... (2) ...") into one subtask per marker — deliberately matching how
this session's own requirement prompts are already written — or returns a single subtask (identical
in effect to not decomposing) when the requirement isn't numbered. `RealClaudeCodeExecutor`'s
implementation runs *inside* the task's isolated workspace (unlike `decideDirection()`/
`decideConflictResolution()`, which run outside any workspace) since planning always happens after
workspace preparation in real mode, and letting Claude see the actual repository state produces a
materially better backlog than reasoning from the plan text alone.

`ImplementParams`/`ReviewParams` both gained an optional `activeSubtask` (index/total/title/
description). `RealClaudeCodeExecutor.implement()`'s prompt, when set, instructs Claude to implement
*only* that step and build on whatever earlier steps already committed. `review()`'s prompt, when
set, explicitly tells the reviewer it's judging one step's own scope — directly closing the failure
mode observed in the real-world test, where a reviewer correctly but unhelpfully flagged "nothing
implemented" against the *whole* plan; decomposed review now judges only the current step.

### C. Orchestrator

`continueAfterReconciliation()` branches to a new `runDecomposedImplementation()` when
`task.decomposeRequirement` is true — everything else about routing, reconciliation, and the
non-decomposed path is byte-for-byte unchanged. The new method: calls `decomposeRequirement()` once
(a failure here blocks cleanly, same "never proceed on an untrusted response" posture as Phase
36/37); persists the backlog and publishes `SUBTASKS_DECOMPOSED`; then loops each step through
`implement()` → `reviewLoop()` (both now subtask-aware), publishing `SUBTASK_STARTED`/`_COMPLETED`/
`_BLOCKED` per step and updating `Subtask.status` as it goes. The loop stops at the *first* step that
can't clear review — later steps are never attempted on top of an unreviewed foundation — and the
block message names which step, why, and how many steps completed before it. Every step's own
`ExecutionReport.diff` is already cumulative (`GitWorktreeManager.diff()` always diffs against the
same fixed `baseRevision`), so the final handoff reuses the *last* completed step's report directly
rather than manually merging changedFiles/tests across steps — simpler and more correct than
aggregation would have been.

### D. Frontend

`Subtask` type mirrored; Create Task gained a checkbox ("Break this into a backlog and implement it
step by step") with inline copy naming the real-world timeout as the reason it exists; Task Detail
gained a "Backlog (N/M steps done)" card listing each step's title, description, and a color-coded
status badge, shown only when `task.subtasks` is populated.

## A real bug found and fixed while testing this phase

Writing this phase's end-to-end test surfaced a **pre-existing, previously undetected bug**: `config.ts`
computed every `process.env`-derived value once, at module-import time, not per access. Any test
file where something imported `config.js` (even transitively) before that file's own `beforeAll` set
`DATA_DIR`/`TASKS_DIR` would silently have those overrides ignored — the orchestrator would then
write real task artifacts into *this project's own* `tasks/`/`data/` directories instead of the
test's isolated temp dirs. This was not unique to this phase's new test: `reconciliationConflict.e2e.test.ts`
(Phase 30) and this session's own `autonomousDecision.test.ts`/`autonomousConflictResolution.test.ts`
(Phases 36/37) all had the identical latent bug (a real, non-type top-level import of
`MockClaudeCodeExecutor`/`recomputeStatus` that triggered it), confirmed by finding their task
directories physically present in this project's real `tasks/` folder. Fixed at the root:
`config.ts`'s properties are now `get` accessors that re-read `process.env` on every access — the
three affected test files were also fixed to defer their real imports past their own env-setup, and
all leaked directories were deleted. Verified the fix by running the full suite three times in a row
and confirming zero accumulation.

## Testing

- `backlogDecomposition.test.ts` (6 tests): the mock heuristic (numbered-split, single-subtask
  fallback); a scripted-executor end-to-end run proving the real orchestrator calls
  implement+review exactly once per subtask, in the right order, with the right `activeSubtask`
  passed each time, and completes; the same driving a blocking finding on step 2 — proving step 1 is
  marked `completed`, step 2 `blocked`, step 3 stays `pending` and is never attempted, and the retry
  count inside step 2 matches `config.maxReviewRetries` exactly; a decomposition-call-failure case
  blocking cleanly with no subtasks recorded; and a regression check that a non-decomposed task never
  calls `decomposeRequirement()` at all.
- Backend `vitest`: **250 passed** (39 files), up from 244 — the 6 new tests, zero regressions, run
  three consecutive times to confirm the config.ts fix holds.
- Frontend `jest`: **67 passed**, up from 66.
- `npm run build` and `npm run lint`: both clean.
- Real-CLI validation of `decomposeRequirement()` was **not** performed this session — see Known
  Limitations; it joins `decideDirection()` and `decideConflictResolution()` on the same still-open
  gap.

## Known Limitations

- **No real-CLI validation of `decomposeRequirement()`** — same category of gap Phase 36/37 already
  carry for their own autonomous methods. All three should be validated together before relying on
  this in real execution.
- **`detectedStack.testCommand` is still captured once, before any code exists.** For a genuine
  greenfield decomposed build, `runTests()` will keep reporting "skipped" for every step, even after
  step 1 scaffolds a real `package.json` with a test script — inspection is never re-run mid-task.
  Not fixed by this phase; a real, separate gap.
- **No mid-backlog resume.** If a decomposed task is cancelled or crashes partway through, retrying
  it (Phase 31) restarts from repository inspection like any other task — it re-decomposes from
  scratch rather than resuming at the step it stopped on. Given `decomposeRequirement()` isn't
  guaranteed deterministic in real mode, this is arguably correct behavior, not just an omission, but
  it's untested and unstated until now.
- **Reconciliation-conflict arbitration (Phase 37) and backlog decomposition are independent and
  untested together** — a decomposed task that also hits a reconciliation conflict uses Phase 37's
  autonomous arbitration (if enabled) exactly as before, since decomposition only changes what
  happens *after* reconciliation succeeds; no test exercises this specific combination.

## Next Recommended Milestone (proposed, not implemented)

Real-CLI validation of all three autonomous/decomposition methods together
(`decideDirection`/`decideConflictResolution`/`decomposeRequirement`) against the actual `claude`
CLI — ideally by re-running the School-Management-Backend real-mode test now that decomposition
exists, to see whether the original goal (a working greenfield build) is actually achievable end to
end.
