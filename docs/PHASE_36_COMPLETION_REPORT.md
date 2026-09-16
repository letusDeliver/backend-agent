# Phase 36 Completion Report — Autonomous Stack & Direction Decision

**Status**: Complete.

## Problem

See `docs/PHASE_36_PROPOSAL.md` for the full write-up, including why this phase replaced the
originally-discussed "Deep Repository Understanding" milestone: `docs/PHASE_35_PLATFORM_REVIEW.md`
had already investigated and rejected that candidate with evidence (`implement()`/`review()` already
bypass the deterministic inspector via Claude's own live agentic reads), re-confirmed directly
against `RealClaudeCodeExecutor.ts` in this phase before any code was written. The actual wall
standing between the developer's stated goals — autonomous decisions when ambiguous, contributor
mode, greenfield builds — and the current pipeline is `routeTask()`'s ambiguous-stack short-circuit,
which unconditionally blocked the task with zero specialists selected.

## Implementation

### A. Type system (`server/src/types/index.ts`)

- `AutonomyLevel = "advisory" | "autonomous"`.
- `Task.autonomyLevel?: AutonomyLevel` (absent ≡ `"advisory"`, no migration) and
  `Task.autonomousDecisions?: AutonomousDecision[]`.
- `AutonomousDecision { subject: "routing"; decision; agents; rationale; confidence; executionMode;
  createdAt }` — `subject` is a closed union of one value today, deliberately typed to make future
  extension (e.g. `"reconciliation-conflict"`) an additive change, not a redesign.
- `TaskCreateInput.autonomyLevel?: AutonomyLevel`.
- New `EventType`: `"AUTONOMOUS_DECISION_MADE"`.

### B. Executor capability (`ClaudeCodeExecutor.ts`, `MockClaudeCodeExecutor.ts`,
`RealClaudeCodeExecutor.ts`)

`decideDirection(params: DirectionDecisionParams): Promise<DirectionDecision>` added to the executor
interface. `MockClaudeCodeExecutor`'s implementation is a deterministic keyword heuristic (Python
keywords → Python, database keywords → add the Database Agent, otherwise defaults to Node.js — this
platform's own stack), fixed confidence `0.4`, rationale always prefixed `MOCK / SIMULATED
EXECUTION`. `RealClaudeCodeExecutor`'s implementation shells out to the `claude` CLI with
`cwd: config.tasksDir` (never the target repository — this call needs no repository file access, see
proposal §Safety Boundaries), reuses the exact `REQUIREMENT_TRUST_FRAME`/`DETECTED_STACK_TRUST_FRAME`
framing Phase 35 established, and validates the response (`language` must be `"python"`/`"node"`,
`agents` filtered against the closed `AgentType` set) before returning — an invalid or empty response
throws rather than returning a partially-trusted decision.

### C. Orchestrator integration (`taskOrchestrator.ts`)

`run()`'s existing `routing.agents.length === 0` branch gained one condition:
`task.autonomyLevel === "autonomous"` now calls a new private `decideDirectionAutonomously()` instead
of blocking immediately. On success, `routing` is replaced with the decided agents (same shape
`routeTask()` itself would have produced) and the pipeline continues completely normally from that
point — no other line in `run()` needed to change. The original ambiguous `AGENT_SELECTED` event is
still published first, so the event log shows both what routing actually found and what the
autonomous override decided, never one hiding the other. On failure (`decideDirectionAutonomously()`
returns `null` — executor threw, or returned zero valid agents), the task blocks with a reason
explicitly naming that autonomous mode was tried and didn't reach a confident answer.

### D. Route validation (`routes/tasks.ts`)

`validateCreateInput()` accepts `autonomyLevel` from the request body; anything other than the exact
string `"autonomous"` becomes `"advisory"` — an absent, malformed, or unexpected value can never
accidentally enable autonomous decisions. `POST /tasks` sets `autonomyLevel` and initializes
`autonomousDecisions: []` on every new task.

### E. Frontend

- `web/src/app/models/task.model.ts` mirrors the new types (`AutonomyLevel`, `AutonomousDecision`,
  the two `Task`/`TaskCreateInput` fields, the new `EventType` value).
- `task.service.ts`'s SSE listener list gained `"AUTONOMOUS_DECISION_MADE"` — without this the
  browser's `EventSource` would never dispatch the event, since listeners are registered per named
  type.
- Create Task form gained one checkbox ("Let the orchestrator decide the direction if I'm
  ambiguous") with inline copy explaining exactly what it does and does not change (every other
  human-approval gate is unaffected), defaulting unchecked.
- Task Detail gained an "Autonomous Decisions" card, shown only when
  `task.autonomousDecisions?.length`, listing each decision's chosen agents, confidence, and full
  rationale — no new refresh logic was needed since `onEvent()` already refetches the whole task on
  every SSE event.

## Testing

New file `server/tests/autonomousDecision.test.ts` (6 tests):

- 3 unit tests against `MockClaudeCodeExecutor.decideDirection()` directly (Node default, Python
  keyword match, database-keyword inclusion).
- An end-to-end test creating a task via the real HTTP API against a genuinely bare repository
  (only a `README.md`, no manifest) with `autonomyLevel: "autonomous"`, starting it, and asserting
  against the real orchestrator's output: `status` is not `"blocked"`, `selectedAgents` is
  non-empty, exactly one `AutonomousDecision` was recorded with `subject: "routing"`, and an
  `AUTONOMOUS_DECISION_MADE` event exists in the real event history.
- A regression check that omitting `autonomyLevel` at creation defaults to `"advisory"` with an
  empty decision list.
- A failure-path test building the orchestrator directly with a fixture executor whose
  `decideDirection()` throws, asserting the task still blocks with a reason naming that autonomous
  mode was tried and failed, and that no decision was recorded.

All five pre-existing fixture classes implementing `ClaudeCodeExecutor`
(`reconciliationConflict.e2e.test.ts`, `taskStageIntegrity.test.ts`, `taskRetry.test.ts`,
`taskRetryRealMode.test.ts`, `workspaceCleanup.test.ts`) gained a `decideDirection()` stub to satisfy
the widened interface — none of them exercise it; this is a compile-time-only change confirmed by
the full suite passing unmodified otherwise.

`create-task.component.spec.ts` updated: both existing `setValue()` fixtures gained the new
`autonomousMode` control, and a new test asserts `autonomyLevel: "autonomous"` is sent when the
checkbox is checked.

### Results

- `npm run lint` (backend `tsc --noEmit`): pass.
- `npm run build` (backend `tsc` + frontend `ng build`): pass, both clean.
- Backend `vitest`: **229 passed** (35 test files), up from 223 (208 at Phase 34 + Phase 35's
  additions) — the 6 new tests, zero regressions.
- Frontend `jest`: **64 passed** (5 test files), up from 63 — the 1 new test, zero regressions.
- Manual real-HTTP validation (mock mode, disposable repo, this session): started the actual dev
  server against isolated `DATA_DIR`/`TASKS_DIR`, created a bare git repo with only a `README.md`,
  and drove both branches through the live API:
  - Without `autonomyLevel`: `status: "blocked"`, `currentStage: "routing"`, the exact original
    error message — confirming zero behavior change for the default path.
  - With `autonomyLevel: "autonomous"`: `status: "completed"`, `selectedAgents: ["node-backend"]`,
    one `AutonomousDecision` recorded with the mock executor's labeled rationale and `confidence:
    0.4`.
- Real `claude` CLI validation for `RealClaudeCodeExecutor.decideDirection()` specifically was **not**
  performed this session (no real-mode run was executed) — see Known Limitations.

## Known Limitations

- **No real-CLI validation of `decideDirection()`.** Every other real-execution method in this
  platform has, per project convention, been manually validated against the actual `claude` CLI at
  least once. This method was not — mock-mode coverage (automated + manual) and a clean `tsc` build
  are the only evidence for the real-mode code path. This is a real gap, not a claim of full
  validation, and should be closed before relying on autonomous mode in real execution.
- **Confidence is not independently calibrated** — it is the model's own self-reported number (real
  mode) or a fixed placeholder (mock mode), the same posture `SpecialistReport.confidence` already
  has elsewhere in this platform.
- **This phase does not make greenfield builds fully autonomous.** It removes the first wall
  (routing) that an empty-repo task hits. A task still gets exactly one plan → implement → review
  pass; "build a whole product" from one instruction is not claimed as achieved by this phase alone.
- **Reconciliation-conflict arbitration is untouched** — a material conflict still always blocks,
  even under `autonomyLevel: "autonomous"`. This was deliberately scoped out (see proposal).

## Next Recommended Milestone (proposed, not implemented)

Two independent candidates, either reasonable next:

1. **Reconciliation-conflict arbitration** — extend the same `autonomyLevel: "autonomous"` opt-in to
   the reconciliation material-conflict block, using the same append-only `AutonomousDecision` audit
   pattern this phase established (`subject: "reconciliation-conflict"`). Directly continues the
   developer's goal (1).
2. **Greenfield backlog decomposition** — for a task where `detectedStack.language` started
   `"unknown"` and was resolved by an autonomous decision (i.e., a plausible greenfield build), add a
   step that decomposes the requirement into an ordered set of implementation passes instead of one,
   looping the existing plan → implement → review pipeline per item. This is the larger, riskier
   piece of the developer's goal (3) and was explicitly named as out of scope for this phase.

Real-CLI validation of `decideDirection()` should happen before either, regardless of which is chosen
next.
