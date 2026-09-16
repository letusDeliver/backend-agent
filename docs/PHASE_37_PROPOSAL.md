# PHASE 37 — AUTONOMOUS RECONCILIATION-CONFLICT ARBITRATION

Status: APPROVED AND IMPLEMENTED (developer selected this as the next milestone from
`docs/PHASE_36_COMPLETION_REPORT.md`'s two named candidates, then said to go ahead — no separate
approval gate).

---

## Problem

Phase 36 gave a task an opt-in (`autonomyLevel: "autonomous"`) to let the orchestrator decide a
direction itself instead of blocking, but scoped that narrowly to the routing decision point only.
Reconciliation's material-conflict block — `hasUnresolvedMaterialConflict(reconciliation)` in
`TaskOrchestrator.run()` — was explicitly named out of scope in `docs/PHASE_36_PROPOSAL.md` and
carried forward as the first of two named next-milestone candidates in
`docs/PHASE_36_COMPLETION_REPORT.md`. The developer picked it over the other candidate (greenfield
backlog decomposition).

Today, when two specialists produce a materially opposing recommendation on the same subject (Phase
30's deterministic conflict-detection engine), the task blocks unconditionally — `autonomyLevel:
"autonomous"` has no effect here, since Phase 36 only touched the routing branch.

## Current Behavior

- `reconcile()` classifies specialist recommendations and flags a `ReconciliationConflict` with
  `materiality: "material"` when two agents genuinely disagree (not just differently-worded
  agreement).
- `TaskOrchestrator.run()`'s `hasUnresolvedMaterialConflict(reconciliation)` check blocks the task
  unconditionally — confirmed unchanged by Phase 36 (that phase only added a branch to the earlier
  `routing.agents.length === 0` check).
- The only existing path past this block is the human-driven `POST
  /tasks/:id/reconciliation/conflicts/:conflictId/resolve` API, which writes a `ConflictResolution`
  with `resolvedBy` set to whatever the developer's request supplies (defaulting to `"developer"`)
  and, if that clears every remaining material conflict, calls
  `TaskOrchestrator.resumeAfterConflictResolution()`.

## Evidence

- `server/src/orchestrator/taskOrchestrator.ts` (pre-change) — the `hasUnresolvedMaterialConflict`
  branch in `run()`, re-confirmed unconditional before this phase touched it.
- `server/tests/reconciliationConflict.e2e.test.ts` — the existing test proving the human-resolution
  path; still passes unmodified, confirming the default (`"advisory"`) behavior this phase must not
  change.
- `docs/PHASE_36_COMPLETION_REPORT.md` §"Next Recommended Milestone" — names this exact candidate and
  the audit pattern to reuse (`AutonomousDecision` with `subject: "reconciliation-conflict"`).

## Target Architecture

### A. `ClaudeCodeExecutor.decideConflictResolution()` — a fifth executor capability

One call per conflict, not a batch: `decideConflictResolution({ task, conflict })`. Given the full
`ReconciliationConflict` (category, subject, kind, reason, `repositoryEvidence`, and every
participant's `decision`/`rationale`/`evidence`/`confidence`/`polarity`), it decides which position
to adopt — or a synthesized resolution — with a reason and confidence. Implemented by both executors:
`MockClaudeCodeExecutor` deterministically adopts whichever participant reported the highest
confidence (clearly labeled `MOCK / SIMULATED EXECUTION`, fixed low confidence); `RealClaudeCodeExecutor`
calls the `claude` CLI, reusing `REQUIREMENT_TRUST_FRAME` and a new, analogous
`CONFLICT_TRUST_FRAME` for the conflict's captured specialist-report text. Like `decideDirection()`,
this call gets **no repository file access** — `cwd: config.tasksDir` — because it is reasoning over
already-captured report text, not repository content.

### B. Orchestrator integration — attempt every unresolved conflict independently

A new private `decideConflictsAutonomously(task, reconciliation)`: for each currently-unresolved
material conflict, call the executor independently. A conflict whose call succeeds gets its
`resolution` written (`resolvedBy: "autonomous-arbitration"`) and an `AutonomousDecision` appended
(`subject: "reconciliation-conflict"`, `conflictId` naming which one). A conflict whose call throws
is simply left unresolved — no partial or speculative resolution. `TaskOrchestrator.run()`'s existing
block branch gains one line: if `autonomyLevel === "autonomous"`, call this helper, then **re-run the
exact same `hasUnresolvedMaterialConflict()` check** before deciding to block. If every material
conflict got resolved, the check now returns `false` and the task proceeds to
`continueAfterReconciliation()` exactly as the human-resolution API's resume path already does. If
anything remains unresolved (partial success, or every attempt failed), the task blocks with the
same message as before, now correctly reflecting only what's actually still outstanding.

### C. Deliberately not touched: review-stage conflicts

`detectReviewConflicts()`'s block inside `reviewLoop()` (conflicts found from blocking review
findings, *after* an implementation pass already happened) is **not** wired to autonomous
arbitration in this phase. Resolving a review-stage conflict — human or autonomous — re-runs the
entire shared tail (`continueAfterReconciliation`: planning → implement → review, from scratch),
which is materially more complex to reason about safely than the reconciliation-stage case (which
blocks *before* any implementation exists). Kept out of scope, named explicitly below — the same
"one wall at a time" discipline Phase 36 used for routing vs. reconciliation conflicts.

## Explicitly Out of Scope

- Review-stage conflict arbitration (§C above).
- Any change to the `NEEDS_USER_DECISION`/`UNKNOWN` reconciliation-status block, which is a different
  kind of ambiguity than a material conflict and untouched by this phase.
- Greenfield backlog decomposition — the other Phase 36 candidate, not chosen this round.
- Any change to the human-resolution API (`POST .../resolve`) — it is untouched; autonomous
  arbitration is a parallel path to the exact same `ConflictResolution` shape, not a replacement.

## Safety Boundaries

- Same as Phase 36: no repository file access for this call, `autonomyLevel` must be explicitly
  `"autonomous"` per task, and a failed/unusable arbitration response is simply left unresolved —
  never applied speculatively.
- `CONFLICT_TRUST_FRAME` reuses the exact framing convention Phase 33/35/36 already established.
- `resolvedBy: "autonomous-arbitration"` is a distinct, greppable value from `"developer"` (or
  whatever a human types) — nothing about an autonomous resolution is disguised as a human one, in
  the reconciliation artifact or in the UI (which renders `resolvedBy` as free text either way).

## Persistence

Additive only: reuses `Task.autonomousDecisions` (Phase 36) with a second `subject` value, and the
already-existing `ReconciliationConflict.resolution` field — no new artifact file, no schema change
beyond widening `AutonomousDecision.subject` to a two-value union and making `agents` optional /
adding optional `conflictId` (both backward compatible: every existing `"routing"` record already has
`agents` populated and no reader requires `conflictId`).

## Testing Strategy

- `server/tests/autonomousConflictResolution.test.ts` (new):
  - Unit coverage of `MockClaudeCodeExecutor.decideConflictResolution()` (adopts the highest-confidence
    participant; still returns a usable low-confidence result with zero participants).
  - An end-to-end test reusing the same genuinely-disagreeing fixture pattern as
    `reconciliationConflict.e2e.test.ts`, extended with a working `decideConflictResolution()`,
    driving the real `TaskOrchestrator` with `autonomyLevel: "autonomous"` — asserts the task
    completes instead of blocking, exactly one `AutonomousDecision` is recorded
    (`subject: "reconciliation-conflict"`, `conflictId` matching the real conflict's id), the
    persisted `reconciliation.conflicts[0].resolution.resolvedBy` is `"autonomous-arbitration"`, and
    an `AUTONOMOUS_DECISION_MADE` event exists in the real event history.
  - A failure-path test with a fixture whose `decideConflictResolution()` throws, asserting the task
    still blocks with the original message and records no decision.
- All five pre-existing `ClaudeCodeExecutor` fixtures gained a `decideConflictResolution()` stub for
  the same reason they gained `decideDirection()` in Phase 36 (interface completeness; none exercise
  it) — compile-time-only, no behavior change.
- Manual real-HTTP validation was **not** performed for this phase specifically, because the
  scenario requires two specialists to genuinely disagree — the platform's stock
  `MockClaudeCodeExecutor.analyze()` heuristic never produces that (by design — it's a simple,
  non-conflicting synthetic report), so reaching this state at all requires a custom executor, which
  is exactly what the automated end-to-end test already drives against the real
  `TaskOrchestrator`/`ArtifactStore`/`TaskEventBus`. This is the same limitation the *pre-existing*
  human-resolution conflict test already has (see `reconciliationConflict.e2e.test.ts`) — stated
  plainly rather than papered over.

## Migration / Compatibility

Fully additive, same posture as Phase 36. Every existing `AutonomousDecision` record (`subject:
"routing"`) is unaffected by widening the type — `agents` was already populated for every one that
exists.

## Risks

- Same inherent LLM-decision risk as Phase 36 (a plausible-but-wrong arbitration) — mitigated
  identically: full rationale + confidence recorded, `resolvedBy: "autonomous-arbitration"` never
  disguised as a human decision.
- Partial resolution (some conflicts resolved, others not) is a deliberate design choice, not an
  edge case slipping through — it keeps each conflict's arbitration independent and simple, and the
  existing block message already correctly reflects only what's left.

## Known Limitations

- No real-`claude`-CLI validation of `decideConflictResolution()` this session — same category of
  gap Phase 36 already had for `decideDirection()`, now carried by a second method. Both should be
  validated together before relying on autonomous mode in real execution.
- Review-stage conflict arbitration remains unimplemented (§C) — a material conflict discovered
  during review still always blocks, even in autonomous mode.

## Non-Goals

Review-stage conflict arbitration, greenfield backlog decomposition, any change to the
`NEEDS_USER_DECISION`/`UNKNOWN` block, any change to the human-resolution API.

## Acceptance Criteria

- A task with `autonomyLevel: "autonomous"` whose reconciliation surfaces a material conflict that
  the executor can resolve completes instead of blocking, with the resolution and an
  `AutonomousDecision` both recorded — proven by an automated test driving the real orchestrator.
- The exact same scenario under `autonomyLevel: "advisory"` (default) still blocks unmodified —
  proven by the pre-existing `reconciliationConflict.e2e.test.ts` passing unchanged.
- A failed arbitration call still blocks, with the conflict left unresolved and no decision
  recorded.
- Full existing regression suite (backend + frontend) passes unmodified.
- `npm run build`, `npm run lint`, backend `vitest`, and frontend `jest` all pass.

## Estimated Implementation Size

Small. One new executor method (interface + two implementations, reusing Phase 36's patterns
directly), one new orchestrator branch plus one new private helper, an additive type widening, and a
minimal frontend template fix to render both decision shapes correctly.

## Dependencies

Builds directly on Phase 36's `AutonomyLevel`/`AutonomousDecision` infrastructure. Independent of
review-stage arbitration or greenfield decomposition, either of which could still be built later
without touching this phase's code.

## Rollback / Failure Considerations

Fully revertable as a single additive unit, same posture as Phase 36 — reverting restores exactly
the pre-Phase-37 unconditional conflict block, since `"advisory"` (unaffected by this phase) is the
only behavior any task not opting in can produce.
