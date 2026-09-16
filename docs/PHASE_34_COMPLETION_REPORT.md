# Phase 34 Completion Report — Non-Success Task Visibility

**Status**: Complete.

## Problem

`docs/PHASE_34_NEXT_MILESTONE_REVIEW.md` traced Phase 33's own "Failure-Path Handoff Completeness"
candidate to two concrete, code-level bugs rather than a missing-feature gap:

1. Task Detail's `refreshPanelsFor()` never fetched reconciliation/plan/execution-report/reviews for
   `failed` or `cancelled` tasks, even though the corresponding backend routes apply no status
   gating at all and the data was already sitting on disk.
2. `TaskOrchestrator.block()` and the cancel route both overwrote `task.currentStage` with the
   literal string `"blocked"`/`"cancelled"` — a task *status*, not a pipeline *stage* — which broke
   the frontend's `stageState()` stage-timeline logic (every stage rendered `'pending'` for every
   blocked/cancelled task, regardless of real progress), leaving an already-built "stopped here" UI
   marker permanently unreachable.

## Root cause

Both bugs trace to the same underlying gap: display logic that was extended for `blocked` when
Phase 30 added conflict resolution, and never revisited for `failed`/`cancelled` — combined with
`currentStage` being treated, in two call sites, as if it were free to hold any string describing
"what happened" rather than strictly a pipeline-stage key. Neither bug was caught by existing tests
because every frontend fixture for a failed/blocked task hand-picked a plausible `currentStage`
value (e.g. `'reconciling'`) rather than exercising what the real orchestrator actually writes.

## Implementation

### A. Artifact visibility (frontend)

`refreshPanelsFor()` no longer branches on hardcoded per-status arrays. It computes
`reachedIndex = stageIndex(task.currentStage)` once and gates each artifact fetch on
`reachedIndex >= stageIndex(<stage the artifact is first written at>)` — a single mechanism correct
for every status, live or terminal, because `currentStage` is now (see B) always a trustworthy real
stage name. `getHandoff` remains gated on `task.status === 'completed'` specifically, since reaching
the `reviewing` stage doesn't imply success.

### B. Stage timeline correctness (backend)

`TaskOrchestrator.block()` no longer writes `task.currentStage = "blocked"` — it leaves whatever the
most recent `setStage()` call already set. The cancel route (`POST /tasks/:id/cancel`) no longer
writes `task.currentStage = "cancelled"` for the same reason. `stageState()` was simplified to
always derive `reachedIndex` from `task.currentStage` (previously it only did this for
`failed`/`blocked`, and even then against the now-fixed-to-be-trustworthy field); the old `'blocked'`
`StageState` value was renamed to `'stopped'` since it now correctly covers `blocked`, `failed`, and
`cancelled` alike.

### C. Non-success outcome summary (frontend)

A new "Outcome" section (shown only for `failed`/`blocked`/`cancelled`) states, in one deterministic
sentence built only from `status` + `currentStage`, which stage the task stopped at; lists which
already-fetched panels actually have data; and lists next actions (Retry / Resolve the conflict /
Clean up the workspace) only when the existing eligibility computed signals (`canRetry`,
`hasUnresolvedMaterialConflict`, `canCleanupWorkspace`) already say so — no new eligibility logic was
written, only reused.

### D. Previous Attempts outcome (backend + frontend)

`GET /tasks/:id/attempts` gained an additive `attemptSummaries: { attempt, reachedStage }[]` field
(the pre-existing `attempts: number[]` field is unchanged). `ArtifactStore.describeArchivedAttempt()`
determines `reachedStage` purely from which archived artifact files exist (cheapest-first existence
checks, no JSON parsing) — it deliberately never claims a specific terminal status, since
`failed`/`blocked`/`cancelled` is never archived per-attempt (only `task.json`'s live copy has that,
per Phase 31's own archiving contract). The Previous Attempts row now shows this label inline,
without requiring expansion.

## Bugs fixed

1. **Artifact-fetch gating never included `failed`/`cancelled`.** `web/src/app/pages/task-detail/task-detail.component.ts:refreshPanelsFor()`. A failed or cancelled task with real, already-persisted reconciliation/plan/execution-report/review data now shows it.
2. **`currentStage` was overwritten with a non-stage value on block/cancel.** `server/src/orchestrator/taskOrchestrator.ts:block()` and `server/src/routes/tasks.ts`'s cancel route. The stage timeline now correctly marks completed stages `done` and the stopped-at stage `stopped` for blocked, failed, and cancelled tasks alike.

## Tests

- **Backend**: 208 passing (was 205; +3 net — a new `taskStageIntegrity.test.ts` with 3 tests
  driving the *real* orchestrator/route code to `blocked` (at reconciliation, via a genuine conflict
  fixture; at routing, via a genuinely stack-ambiguous repository) and through the real cancel route,
  asserting `currentStage` is a real stage and never the literal `"blocked"`/`"cancelled"` — plus
  `describeArchivedAttempt()` assertions reusing those same real states; one existing test in
  `retryApi.test.ts` extended with an `attemptSummaries` assertion).
- **Frontend**: 63 passing (was 49; +14 — an `it.each` proving artifact-fetch gating is now
  correctly keyed by `currentStage` across five status/stage combinations including two
  failed/cancelled cases that previously fetched nothing; a rendering test proving a failed task
  that reached review now actually displays its plan/diff/review findings; Outcome-summary tests for
  failed and cancelled (including the case where `task.error` is empty); tests proving no Outcome
  section renders for completed or live tasks; a next-actions eligibility test proving Cleanup is
  correctly never offered for a blocked task even inside the new summary; an `it.each` proving
  `stageState()` now correctly marks done/stopped/pending using real backend-shaped `currentStage`
  values for blocked, failed, and cancelled tasks).
- **Playwright**: 2 passing (was 1) — a new `nonSuccessVisibility.spec.ts` drives a task to a
  genuinely `blocked` state through the real application (a fixture repository with no detectable
  stack + a requirement naming no backend technology, causing routing to legitimately select zero
  specialists — not a fixture-executor swap), then asserts the Outcome section, the correct
  stage-timeline classes, and zero console errors, all in a real Chromium browser.
- **Total**: 273 (up from 255). `npm test` runs 271 (208 backend + 63 frontend).

## Validation

```
npm test              → 208 backend + 63 frontend = 271 passing
npm run test:e2e       → 2 passing
npm run build           → server (tsc) PASS, web (ng build) PASS
npm run lint             → PASS (tsc --noEmit)
```

One `npm run test:e2e` invocation, run immediately after a prior one in quick succession, showed a
single transient failure on the pre-existing `happy-path.spec.ts` test (unrelated to any file this
phase touched). Re-ran three consecutive times afterward — both tests passed cleanly all three
times, and running `happy-path.spec.ts` alone also passed — consistent with a one-off dev-server
startup timing flake between back-to-back Playwright invocations, not a regression.

## Regression verification (Phases 28–33)

Full suite re-run confirms: real-mode isolation/cancellation/timeout tests unchanged and passing;
`taskRetry.test.ts`/`taskRetryRealMode.test.ts`/`retryApi.test.ts` (Phase 31) unchanged and passing;
`reconciliationApi.test.ts`/`reconciliationConflict.e2e.test.ts` (Phase 30) unchanged and passing,
including the specific "blocks the task on a genuine specialist disagreement, then resumes to
completion once resolved" scenario that depends on the blocked task's workspace/state remaining
intact; `workspaceCleanup.test.ts`'s 15 tests (Phase 32) unchanged and passing, including the
dedicated "Blocked-task regression — Phase 30 conflict resolution must keep working" test;
`reviewDiffContent.test.ts`/`reviewDiffTruncation.test.ts`/`gitWorktree.test.ts`'s diff-patch tests
(Phase 33) unchanged and passing. No test was weakened or removed to make this phase's changes pass.

## Final architectural check

| Question | Answer |
|---|---|
| Q1: Can a failed task display artifacts generated before failure? | Yes — `it.each` proves reconciliation/plan/execution-report/reviews are fetched once `currentStage` shows they'd exist. |
| Q2: Can a cancelled task display artifacts generated before cancellation? | Yes — same mechanism, same test, covers `cancelled` explicitly. |
| Q3: Does a blocked task retain the actual pipeline stage where it became blocked? | Yes — `taskStageIntegrity.test.ts` proves this against the real orchestrator for both a reconciliation-stage and a routing-stage block. |
| Q4: Does a cancelled task retain the actual pipeline stage where cancellation occurred? | Yes — `taskStageIntegrity.test.ts` proves this against the real cancel route. |
| Q5: Can the developer understand the basic outcome without opening multiple panels? | Yes — the Outcome section and the inline Previous-Attempts label are both visible without expanding anything. |
| Q6: Does the summary avoid inventing a root cause? | Yes — every sentence is built only from `status`/`currentStage`/which artifacts exist; no inference, no LLM call. |
| Q7: Does retry still work? | Yes — Phase 31's full test suite passes unmodified. |
| Q8: Does conflict resolution still work? | Yes — Phase 30's full test suite, including the blocked-task regression test, passes unmodified. |
| Q9: Does workspace cleanup still work? | Yes — Phase 32's full test suite, including its own blocked-task regression test, passes unmodified. |
| Q10: Does Phase 33's ground-truth diff remain visible? | Yes — Phase 33's tests pass unmodified, and it's now also visible for failed/cancelled tasks that reached the implementing stage, which it previously was not. |

## Main architectural change

Two small, targeted bug fixes (stop overwriting `currentStage` with a synthetic value; gate artifact
fetching by real stage reached instead of by hardcoded status lists) that turn out to reinforce each
other: fixing `currentStage`'s correctness (B) is what makes a single, uniform stage-index comparison
(A) possible in the first place, replacing four separate hand-picked status arrays with one shared
mechanism. On top of that verified-correct foundation, a small Outcome summary (C) and an inline
per-attempt outcome label (D) synthesize already-persisted facts into two new, concise UI surfaces —
no new artifact type, no new `TaskStatus`, no new pipeline stage, no new backend subsystem.

## Known limitations

- `describeArchivedAttempt()` can only ever report the furthest *stage* an archived attempt reached,
  never its specific terminal status (`failed` vs `blocked` vs `cancelled`) — that fact genuinely
  isn't archived per-attempt (Phase 31's own contract excludes `task.json` from archiving). Stating
  only the stage, not a guessed status, was a deliberate evidence-first choice, not an oversight.
- The Outcome summary's next-action list currently covers Retry, Resolve, and Cleanup — it does not
  surface "review the implementation diff" as an action, since that's informational rather than an
  eligibility-gated affordance with its own button; the diff itself is already visible in the
  Implementation Diff panel now that artifact fetching is correctly gated for failed/cancelled tasks.
- This phase did not touch per-phase timing, CLI-call counting, or any other observability capability
  named but not scoped in the Phase 33/34 reviews — those remain separate, larger candidates.

## Next recommended milestone

Unchanged from the Phase 34 review's own alternatives, re-affirmed now that this milestone is
complete: **Repository Deep Understanding** remains the largest, most foundational open candidate
(the repository inspector is still a single shallow, dependency-name-only pass). **Security
Hardening** (realpath resolution for the path-safety guard; a subprocess environment allow-list for
the `claude` CLI) remains a smaller, contained, concrete pair of fixes worth doing independently of
product-facing work. Neither is authorized by this report.
