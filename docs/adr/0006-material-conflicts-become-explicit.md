# ADR 0006 — Material specialist disagreements become explicit reconciliation conflicts

**Status**: Accepted (Phase 30)

## Context

`ReconciliationStatus` has included `CONFLICT` since the platform's original design, but until
Phase 30 no code path ever assigned it — `reconcile()` only ever compared routing-escalation and
specialist-failure signals, never specialists' actual recommendations against each other. Two
specialists could recommend directly contradictory things (a transaction vs. an explicitly
eventually-consistent design) and the orchestrator would report `AGREED`, then hand both an
implementation plan built from whichever text happened to be concatenated first
(`buildImplementationPlan()`'s summary). This is exactly the kind of silent conflict-resolution
`ORCHESTRATOR.md`'s "Do Not" section already prohibited in principle, just not yet enforced in
code.

## Decision

- Reconciliation now runs a deterministic, keyword-based comparison (category → subject →
  polarity, see `docs/RECONCILIATION_CONFLICTS.md`) over every pair of specialist decisions that
  address the same category and subject. A genuine disagreement — same decision, opposite
  polarity — produces a structured `ReconciliationConflict`, not a discarded difference.
- No LLM call is introduced anywhere in the reconciliation core. Detection must be reproducible
  from the same inputs; an LLM-assisted classifier would make "why was this a conflict"
  unanswerable in the way ground-truth `git diff` evidence (Phase 28) and validated-only memory
  (Phase 29) were both explicitly designed to avoid for every other trust boundary in this
  platform.
- A conflict is classified `material` or `non-material` from a fixed, documented category table.
  Only an unresolved *material* conflict blocks implementation; `status: "CONFLICT"` itself is
  shown for any unresolved conflict, material or not — the platform does not hide a disagreement
  just because it happens not to be blocking.
- The orchestrator never picks a side. An unresolved material conflict blocks the task exactly
  the way `NEEDS_USER_DECISION`/`UNKNOWN` already did before this phase; a developer resolves it
  through `POST /tasks/:id/reconciliation/conflicts/:conflictId/resolve`, and that resolution —
  not confidence score, not which agent ran first, not verbosity — is what unblocks the pipeline.
- Resolving the last unresolved material conflict on a blocked task resumes orchestration from
  planning. This is scoped narrowly to the conflict gate this ADR introduces, not a general
  blocked/failed-task retry mechanism (still an open, documented gap for a later milestone).

## Alternatives considered

- **Naive string diff (`if (a.recommendation !== b.recommendation) CONFLICT`)**: rejected —
  explicitly the wrong approach per the milestone's own brief. Two specialists almost never
  produce byte-identical text even when they agree; this would make every reconciliation a
  conflict and destroy the signal.
- **LLM-based conflict classification**: rejected for the reconciliation core specifically, for
  the same reason Phase 28 insisted on ground-truth diffs over self-reported execution — a
  non-deterministic classifier inside a gate that blocks implementation would make "is this
  actually a conflict" unauditable and unreproducible in a way this platform has consistently
  refused to accept at every other trust boundary.
- **Auto-resolve using the higher-confidence or first-run specialist**: rejected — confidence is
  self-reported per specialist, not a measure of which recommendation is actually correct, and
  "first agent wins" is exactly the silent-resolution behavior `ORCHESTRATOR.md` already
  prohibited.

## Consequences

- Conflict detection is a precision-favoring heuristic, not an exhaustive one: some negation
  phrasing (keyword preceding its negation, e.g. "a transaction should not be used") is missed.
  This is accepted — a missed conflict degrades to the pre-Phase-30 behavior for that one case; a
  false conflict blocks a task on nothing, which is the worse failure mode.
- `Reconciliation.conflicts` changed shape from `string[]` to a structured array. Historical task
  directories under `tasks/` keep their old shape on disk; the UI treats a missing/old-shaped
  field as empty rather than crashing. No migration tooling was written, consistent with how
  every prior phase's artifact-shape change (Phase 28, Phase 29) has been handled in this
  JSON-file-store MVP.
- General blocked/failed task retry/resume remains unimplemented outside this specific gate — see
  `docs/PHASE_30_IMPLEMENTATION_PLAN.md` section 11 for the scope reasoning.
