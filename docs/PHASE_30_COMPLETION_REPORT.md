# Phase 30 Completion Report — Reconciliation CONFLICT Detection

## What changed

Before this phase, `Reconciliation.status: "CONFLICT"` was declared in the type system but no code
path ever produced it — `reconcile()` only compared routing-escalation and specialist-failure
signals, never specialists' actual recommendations against each other. Phase 30 adds a
deterministic, keyword-based conflict-detection engine and wires it through reconciliation, the
review loop, the task state machine, the API, and the Task Detail UI.

## Reconciliation architecture

`server/src/orchestrator/decisionExtraction.ts` (new) implements the comparison engine as pure
functions: `extractDecision()` turns a completed `SpecialistReport` into an `ExtractedDecision`
(category, polarity, significant terms, memory-influence metadata); `groupBySubject()` groups
decisions that are plausibly about the same engineering decision; `materialityOf()` classifies a
category as blocking or not. `server/src/orchestrator/reconciliation.ts` was rewritten to use
this engine: `reconcile()` now takes `detectedStack` and `contextPack` in addition to the
existing `reports`/`routing`, produces `agreements`/`conflicts`/`unresolvedQuestions` alongside
the unchanged `decisions` field, and derives `CONFLICT` status whenever any conflict (material or
not) is unresolved.

## Conflict model

`ReconciliationConflict` (in `server/src/types/index.ts`, mirrored in
`web/src/app/models/task.model.ts`) carries `kind` (`specialist-disagreement` |
`evidence-contradiction`), `category`, `subject`, `participants[]` (agent, recommendation,
rationale, evidence, confidence, polarity, memory-influence), `materiality`, a deterministic
`reason` string, and `resolution: ConflictResolution | null`. `Reconciliation.conflicts` changed
type from `string[]` to this structured array; the former narrative strings (routing-escalation
rationale, failed-analysis notes) moved to the new `unresolvedQuestions: string[]` field, which
also gains one line per open conflict.

## Detection strategy

Three deterministic stages, no LLM call anywhere in the reconciliation core:

1. **Category** — an ordered keyword table (13 categories + `architecture` as fallback), with a
   concurrency-signal pre-check so "an asynchronous transaction boundary" classifies as a
   concurrency statement rather than colliding with the literal substring "transaction".
2. **Subject** — narrow categories (`transaction`, `authentication`, `authorization`,
   `data-model`) group by category alone; broader categories additionally require shared
   significant terms between the two recommendations.
3. **Polarity** — a small explicit antonym table for the two cases the brief names directly
   (transaction vs. eventually-consistent; synchronous vs. asynchronous), plus a generic negation
   scan that only counts when the negated word is followed within ~40 characters by one of the
   category's own keywords — this precision gate is what prevents phrases like "so partial writes
   never occur" or "to avoid malformed rows" from being misread as negating the actual
   recommendation.

This algorithm underwent real iteration: the first draft of the test suite (see Testing, below)
caught three genuine defects — an over-eager negation scan flagging goal-oriented phrasing as
negative, a category-priority collision on the brief's own "asynchronous transaction boundary"
example, and an evidence-contradiction check gated too narrowly by category — all fixed before
the suite went green.

## Evidence precedence

Repository evidence remains authoritative. A recommendation naming a specific database technology
that differs from `detectedStack.database` is recorded as `kind: "evidence-contradiction"`
(always `materiality: "material"`) — the recommendation itself is never rewritten, only flagged
alongside the actual repository evidence.

## Memory interaction

Each conflict participant's `memoryInfluenced`/`memoryIds` come from the same per-agent-filtered,
validated-only memory (`memoryForAgent()`) Phase 29 already feeds into specialist analysis — not
from parsing free-text `assumptions`. Precedence is unchanged from Phase 29 (current repository
evidence still wins); this phase only makes a memory-influenced disagreement visible when one
exists.

## Implementation blocking & review-loop interaction

`TaskOrchestrator.run()` blocks the task when any *unresolved material* conflict exists,
alongside the pre-existing `NEEDS_USER_DECISION`/`UNKNOWN` blocks. The planning → implementing →
review → handoff tail was extracted into `continueAfterReconciliation()`, shared between the
normal pipeline and a new `resumeAfterConflictResolution()` entry point. The review loop
(`reviewLoop()`) runs the same detection engine across each attempt's *blocking* findings; if two
agents' blocking findings materially conflict, the orchestrator appends the conflict to the same
`reconciliation.json` (`detectedAt: "review"`) and blocks immediately rather than attempting a
corrective pass that can't satisfy both sides. Ordinary, non-conflicting blocking findings still
trigger a corrective pass exactly as before Phase 30.

## Resolution & continuation — scope note

`resumeAfterConflictResolution()` is a narrowly-scoped continuation mechanism specific to the
conflict gate this milestone introduces, not a general blocked/failed-task retry system (which
remains a documented, open gap, per the implementation plan's section 11). It reuses the task's
persisted `selectedAgents` rather than recomputing routing, since those values are already
deterministic outputs of the original run.

## API

`POST /tasks/:id/reconciliation/conflicts/:conflictId/resolve` — validates task/conflict
existence and unresolved state, requires a non-empty `resolution`, persists a server-set
`resolvedAt`. The client can never write to any field but the resolution itself. If this clears
the last unresolved material conflict on a `blocked` task, orchestration resumes and the response
reports `resumed: true`.

## UI

Task Detail's Reconciliation card now renders `agreements`, structured `conflicts` (materiality
badge, each participant's recommendation/evidence/polarity, an inline resolve form for unresolved
conflicts, resolution provenance for resolved ones), and `unresolvedQuestions`.

## Tests

**149 backend** (vitest) + **18 frontend** (jest) + **1 Playwright E2E** = **168 total**, up from
118 before this phase. New coverage:

- `server/tests/decisionExtraction.test.ts` (26 tests) — category classification, the brief's own
  concurrency-vs-transaction example, negation precision (including the two false-positive cases
  the naive first draft got wrong), narrow/broad subject grouping, materiality table.
- `server/tests/reconciliation.test.ts` (20 tests, rewritten) — agreement, explicit disagreement
  (including the two canonical examples from the brief), different-subjects-never-conflict,
  same-subject/different-rationale, evidence contradiction (with alias handling:
  postgres/postgresql), memory-influence metadata, the three-agent case, multiple independent
  conflicts in one task, materiality gating, and a dedicated false-positive section (different
  code examples for a compatible approach, agent-specific unrelated concerns, empty/irrelevant
  output).
- `server/tests/reconciliationConflict.e2e.test.ts` (1 test) — the full pipeline against a
  deterministic conflicting-fixture executor: task → CONFLICT → blocked → resolve → resume →
  completed, run through the real `TaskOrchestrator`, not a mock of it.
- `server/tests/reconciliationApi.test.ts` (5 tests) — the resolve endpoint's validation (404 on
  unknown task/conflict, 400 on empty resolution, 409 on already-resolved) and the resume
  behavior, against the real Express app and container wiring.
- `web/src/app/pages/task-detail/task-detail.component.spec.ts` (+2 tests) — a rendered
  `CONFLICT` reconciliation shows both participants, evidence, materiality, and a working
  resolve control (disabled until text is entered, calls the service with the right payload); a
  resolved conflict renders its resolution provenance and no resolve form.

Regression: the full pre-existing 118-test suite passes unmodified in assertions. One pre-existing
test, `memoryLoop.e2e.test.ts`, had a tighter poll budget (50 × 50ms = 2.5s) than its sibling e2e
tests (50 × 100ms = 5s); this surfaced as intermittent local flakiness once the added test files
raised background CPU contention (confirmed via `ps aux` to correlate with an IDE Jest-extension
`--watch` process auto-rerunning on save, not anything in this phase's product code). Fixed by
aligning its poll budget with the established 5s convention; verified stable across 20+ repeated
full-suite `npm test` runs after the fix (this is a pure timing-budget change, not a logic
change — the test's assertions are untouched).

## Manual validation

`server/tests/reconciliationConflict.e2e.test.ts` is the deterministic-fixture manual-validation
demonstration required by the brief: a real `TaskOrchestrator` (real routing, real `reconcile()`,
real `ArtifactStore`, real `JsonFileTaskStore`) driven with a small fixture executor whose two
specialists genuinely disagree, proving `Task → Multiple specialists → Contradictory
recommendations → CONFLICT → inspect evidence (assert on participants/evidence/materiality) →
Resolution → Reconciliation updated (status flips to AGREED) → Task continues → completed`
end to end. Additionally verified live:

- Full `npm run build` (backend `tsc`, frontend production `ng build`) — clean.
- Full `npm run lint` — clean.
- Playwright `happy-path.spec.ts` against the real dev stack (mock executor) — passing, zero
  browser console errors, confirming the rewritten Reconciliation template renders correctly for
  the (unchanged) `AGREED` path in an actual browser.
- The Angular component spec renders the `CONFLICT` state (both participants, evidence,
  materiality badge, resolve form) through real `TestBed` change detection and exercises the
  resolve click end to end against a mocked `TaskService`.

**Not performed**: a live-browser session showing a genuine `CONFLICT` produced by the running
dev server. `MockClaudeCodeExecutor` was deliberately left unchanged (to avoid any risk to its
own existing, already-covered heuristic output), and it never names contradictory recommendations
across agents, so the live dev server's mock mode cannot organically produce a conflict. Wiring a
conflict-producing executor into the live server would require restructuring
`server/src/container.ts`'s dependency injection (routes import the orchestrator singleton
directly) — out of proportion to a one-time demo. The orchestrator-level e2e test above exercises
the identical code path (`TaskOrchestrator`, real `reconcile()`, real API-equivalent resolution
logic, real resume) that the live server would run; only the executor is swapped, exactly as the
brief's own "use a deterministic fixture where possible" / "do not require real Claude Code for
standard CI" guidance anticipates.

## Limitations

- Negation detection is precision-favoring, not exhaustive: a negation that grammatically
  precedes its governing keyword ("a transaction should not be used") is missed. Documented in
  `docs/RECONCILIATION_CONFLICTS.md`.
- One decision per specialist report (matching the existing `recommendation: string` shape) — a
  report that bundles two unrelated engineering decisions into one recommendation string can only
  be compared as a whole, not decomposed into separate conflicts.
- General blocked/failed-task retry/resume remains out of scope; only the conflict-resolution
  continuation path introduced here exists.
- `MockClaudeCodeExecutor` cannot organically produce a conflict (see Manual Validation) — this is
  intentional (the executor was left untouched), not an oversight, but it does mean a developer
  exploring the mock-mode UI casually will never see the conflict UI without either real-mode
  execution genuinely disagreeing, or a task whose specialists happen to.

## Next recommended milestone

General task retry/resume for `blocked`/`failed` tasks outside the conflict-resolution path
introduced here (still the top of the priority list carried over from Phase 29), or automatic
workspace cleanup for completed/abandoned real-mode git worktrees.
