# PHASE 36 — AUTONOMOUS STACK & DIRECTION DECISION

Status: APPROVED AND IMPLEMENTED (developer explicitly authorized drafting and implementation
together, no separate approval gate — see Completion Report).

---

## Problem

The developer asked for a longer-term direction: turn this platform into something that can (1)
decide a direction itself when the developer is ambiguous, (2) act as a contributor inside an
already-in-progress codebase, and (3) take an empty repository and a high-level instruction and
build the whole thing. This proposal covers the first concrete, evidence-backed slice of that
direction — not the full scope.

The original framing for "next phase" (from the same conversation, before code was re-checked) was
"Deep Repository Understanding" — extend `repositoryInspector.ts` to read READMEs, Docker files,
migrations, monorepo structure, etc. That framing does not survive contact with
`docs/PHASE_35_PLATFORM_REVIEW.md`, which already investigated exactly this candidate in depth and
rejected it with hard evidence, re-verified again in this phase directly against
`RealClaudeCodeExecutor.ts`:

- `implement()` and `review()` already bypass the deterministic inspector entirely. `implement()`'s
  prompt tells Claude to follow "existing repository conventions" and then relies on Claude's own
  live, agentic file-reading tools inside the real worktree to discover them — `DetectedStack` is a
  hint alongside the plan, not the ground truth Claude is confined to. `review()` does not pass
  `detectedStack` at all.
- `analyze()` also instructs Claude to "inspect the repository at the current working directory as
  needed" — so specialist analysis, in real mode, already gets a live repository read too.
- No completion report, test failure, or bug across Phases 28-35 traces back to the inspector's
  shallowness. Widening it would not improve the stages where repository understanding matters most
  for output quality, because those stages already have better information than any bounded,
  deterministic inspector could produce.

So goal (2) — contributor mode on an in-progress repo — is already substantially served today, in
real-execution mode, by Claude's own live reads. The actual wall standing between the developer's
three goals and the current pipeline is narrower and different: **routing**.

`routeTask()` (`server/src/orchestrator/routingEngine.ts`) returns `agents: []` and
`needsEscalation: true` the moment repository inspection resolves `language: "unknown"` and the
requirement text names no backend technology — confirmed directly against source, then confirmed
empirically via the running server (`POST /tasks` against a bare repository with only a `README.md`,
followed by `/start`, produces `status: "blocked"`, `currentStage: "routing"`,
`error: "No specialist could be confidently selected..."`). `TaskOrchestrator.run()` then calls
`block()` unconditionally — there was no code path that did anything else.

This is exactly the shape both goal (1) and goal (3) take in this codebase:

- Goal (1) ("if I'm confused, decide for me") is, mechanically, "don't block at routing — decide
  instead."
- Goal (3) ("empty repo, build it yourself") always starts from `language: "unknown"` — an empty
  repository has no manifest by definition — so it hits this exact wall as step one, before anything
  else in the pipeline even gets a chance to run.

## Current Behavior

- A task against a repository with no recognizable manifest, and a requirement that names no
  language/database keyword, always blocks at routing with zero specialists selected, regardless of
  developer intent.
- There is no way to ask the platform to make that one call itself. The only escape is for the
  developer to either name a technology in the requirement or add a manifest to the repository.

## Evidence

- `server/src/orchestrator/routingEngine.ts:48-61` — the exact short-circuit, re-confirmed by a
  targeted code review this session before this proposal was written.
- `server/src/orchestrator/taskOrchestrator.ts` (pre-change) lines 76-89 — `routing.agents.length ===
  0` unconditionally calls `this.block(...)`.
- `server/tests/taskStageIntegrity.test.ts`'s existing "blocked at routing" test — already proves
  this exact scenario against the real orchestrator.
- Manual validation this session: a disposable git repo with only a `README.md`, requirement "Build
  whatever backend makes sense for this project," `POST /tasks` + `/start` against the running dev
  server (mock mode) — produced `status: "blocked"`, confirming the wall exists exactly as read from
  source.
- `docs/PHASE_35_PLATFORM_REVIEW.md` §"Real Claude Compensation" / §"Recommended Direction" — the
  evidence that deep repository understanding would not serve this need, re-verified against current
  `RealClaudeCodeExecutor.ts` in this phase.

## Target Architecture

### A. `AutonomyLevel` — an explicit, narrow, per-task opt-in

`Task.autonomyLevel: "advisory" | "autonomous"`, defaulting to `"advisory"` at creation. `"advisory"`
is every existing human-gated behavior, completely unchanged — this is not a platform-wide behavior
change, it is a new opt-in path a developer must deliberately choose per task. This directly follows
the developer's own stated preference: safety net stays default-on, autonomy is opt-in, matching
ADR-0005 (memory) and ADR-0006 (reconciliation conflicts), which this phase does not touch or revisit.

### B. `ClaudeCodeExecutor.decideDirection()` — a fourth executor capability

A new method on the existing `ClaudeCodeExecutor` interface, implemented by both `MockClaudeCodeExecutor`
(deterministic keyword heuristic, clearly labeled `MOCK / SIMULATED EXECUTION`, confidence fixed low)
and `RealClaudeCodeExecutor` (a real `claude` CLI call). It decides a backend language and a set of
specialists from the requirement text alone, with a rationale and a confidence score.

Deliberately **not given repository file access** — it runs with `cwd: config.tasksDir` (the
platform's own artifact directory), never `task.repository`, and needs no isolated worktree. This
call exists precisely because there is no stack signal to read; giving it repository access would
add a real-execution dependency (worktree preparation, which currently happens *after* routing) for
no benefit, and would blur the trust boundary this phase is careful about (see Safety Boundaries).

### C. Orchestrator integration — one narrow branch, one place

In `TaskOrchestrator.run()`, the existing `routing.agents.length === 0` check gains one branch:
if `task.autonomyLevel === "autonomous"`, call `decideDirectionAutonomously()` instead of blocking
immediately. On success, the decided agents replace the empty routing result and the pipeline
proceeds exactly as if routing itself had resolved them (same `selectedAgents` assignment, same
downstream stages, no other code path touched). On failure (the executor call throws, or returns no
valid agents), the task still blocks — with a reason that says autonomous mode was tried and didn't
reach a confident answer, never a silent fallback to an empty/wrong selection.

### D. Audit trail — `AutonomousDecision`

Every autonomous call, successful or not (only successful ones are recorded — a failed call produces
no decision, just a block reason), is appended to `Task.autonomousDecisions[]` and published as an
`AUTONOMOUS_DECISION_MADE` event. This is deliberately append-only and separate from the routing
event itself: the event log shows both the original inconclusive routing decision *and* the
autonomous override, never just one — nothing about what happened is hidden.

## Explicitly Out of Scope

- **Reconciliation-conflict arbitration.** A material conflict still always blocks, even under
  `autonomyLevel: "autonomous"` — this phase touches only the routing decision point. Extending
  autonomous arbitration to conflicts is a plausible future phase, not this one; ADR-0006 is
  untouched.
- **Multi-step/greenfield build decomposition.** This phase unblocks the *first* wall an empty-repo
  task hits (routing). It does not add backlog decomposition, multi-task iteration, or anything that
  turns one requirement into many implementation passes. A greenfield task still gets exactly one
  plan → implement → review pass, same as any other task today.
- **Deep repository understanding**, per the Problem section above — not evidence-supported as a
  target for this or the developer's stated goals.
- Any change to the UI's stage timeline, retry, or workspace cleanup semantics.

## Repository Evidence Model / Inspection Categories

Not applicable — `repositoryInspector.ts` is unchanged by this phase.

## Context Pack Integration

Unaffected. `decideDirection()` does not read or write memory; it runs before `retrieveMemory()` in
the pipeline and its result only changes which agents `retrieveMemory()` is later called with.

## Persistence

Additive only: `Task.autonomyLevel` (optional, absent ≡ `"advisory"`, no migration written — same
convention as `RealExecutionWorkspace.cleanupStatus`) and `Task.autonomousDecisions` (optional array,
absent ≡ `[]`). No existing field changes shape. No new artifact file — the decision lives on
`task.json` itself, next to `detectedStack` and `selectedAgents`, since it is exactly that kind of
routing-adjacent fact.

## Safety Boundaries

- `decideDirection()` never receives repository file access (Target Architecture §B) — it cannot be
  used as a channel to read the target repository before a worktree exists, and it cannot be
  influenced by repository-controlled content, only by the developer's own requirement text.
- The same untrusted-content framing pattern Phase 33/35 established (`REQUIREMENT_TRUST_FRAME`) is
  reused verbatim for the requirement text in this new prompt — no new framing pattern was invented.
- `autonomyLevel` defaults to `"advisory"` and must be explicitly set to `"autonomous"` per task —
  never inferred, never a server-wide default.
- A failed/invalid autonomous decision always blocks; it never proceeds with an empty or
  partially-valid agent list. `RealClaudeCodeExecutor.decideDirection()` validates the returned
  `language` and filters `agents` against the closed `AgentType` set before returning.

## Performance Boundaries

One additional `claude` CLI call (real mode) or one synchronous heuristic (mock mode), only on the
already-rare path where routing would otherwise have blocked. No change to the cost of any task that
routes normally.

## Symlink Safety

Unaffected — no new filesystem path is introduced; `decideDirection()`'s `cwd` is the platform's own
`config.tasksDir`, already trusted, already subject to no new access pattern.

## Testing Strategy

- `server/tests/autonomousDecision.test.ts` (new):
  - Unit coverage of `MockClaudeCodeExecutor.decideDirection()`'s deterministic heuristic (Node
    default, Python keyword match, database-keyword inclusion).
  - An end-to-end test driving the real `TaskOrchestrator`/HTTP API against a genuinely bare
    repository with `autonomyLevel: "autonomous"`, asserting the task reaches a non-blocked terminal
    status, `selectedAgents` is non-empty, `autonomousDecisions` has exactly one entry, and an
    `AUTONOMOUS_DECISION_MADE` event was published — driving the real production code path, not a
    hand-built fixture, per this project's established testing convention.
  - A regression check that a task created without `autonomyLevel` defaults to `"advisory"`.
  - A failure-path test with a fixture executor whose `decideDirection()` throws, asserting the task
    still blocks with a reason naming that autonomous mode was tried.
- All five existing fixture classes implementing `ClaudeCodeExecutor` across other test files gained
  a `decideDirection()` stub (never exercised by those tests) to satisfy the widened interface —
  no behavior change to any existing test.
- Manual validation (mock mode, disposable repo, real HTTP calls against the running dev server):
  confirmed the exact before/after contrast — the same ambiguous-repo/vague-requirement task blocks
  under `"advisory"` (unchanged) and completes with one recorded `AutonomousDecision` under
  `"autonomous"`.

## Migration / Compatibility

Fully additive. Every existing task record (absent `autonomyLevel`/`autonomousDecisions`) behaves
exactly as `"advisory"` with an empty decision list — no backfill needed, no reader requires the
field to be present.

## Risks

- A real `claude` CLI response for `decideDirection()` that returns a plausible-looking but wrong
  language is possible (this is inherent to any LLM-backed decision) — mitigated by always recording
  confidence and rationale for the developer to review after the fact, never hiding that the decision
  was autonomous.
- Scope-creep risk: it would be easy to also wire this into reconciliation-conflict arbitration in
  the same phase. Deliberately not done here — kept to the one evidenced wall.

## Known Limitations

- Confidence scores are the model's own self-reported number (real mode) or a fixed placeholder
  (mock mode) — not independently calibrated. This is consistent with how `SpecialistReport.confidence`
  already works elsewhere in this platform; no new precedent.
- This phase does not make greenfield builds (goal 3) fully autonomous end-to-end — it removes the
  first blocking wall, not the only one. A single implement/review pass is unlikely to be sufficient
  for "build a whole product," which is exactly why multi-step decomposition is named as future work,
  not claimed as done here.

## Non-Goals

Reconciliation-conflict arbitration, multi-step/backlog decomposition for greenfield builds, any
change to repository inspection depth, any change to the memory-approval or conflict-resolution human
gates.

## Acceptance Criteria

- A task with default (absent) `autonomyLevel` behaves identically to before this phase, proven by
  the existing `taskStageIntegrity.test.ts` "blocked at routing" test passing unmodified.
- A task with `autonomyLevel: "autonomous"` against a repository/requirement pair that would
  otherwise block at routing instead completes, with `autonomousDecisions` recording the decision —
  proven by both an automated test and a manual real-HTTP run against the dev server.
- A failed autonomous decision still blocks, never silently proceeds — proven by a dedicated test.
- Full existing regression suite (all prior phases, backend and frontend) passes unmodified.
- `npm run build`, `npm run lint`, backend `vitest`, and frontend `jest` all pass.

## Estimated Implementation Size

Small-to-moderate. One new executor method (interface + two implementations), one narrow branch in
the orchestrator plus one new private helper, additive type/route changes, a minimal frontend toggle
and audit-trail display. No new subsystem, no schema migration, no new dependency.

## Dependencies

None. Independent of Phase 35's items (all already shipped) and of any future reconciliation-
arbitration or greenfield-decomposition phase.

## Rollback / Failure Considerations

Fully revertable as a single, additive unit — no other phase's code depends on `AutonomyLevel` or
`AutonomousDecision` existing. Reverting restores exactly the pre-Phase-36 blocking behavior for every
task, since `"advisory"` (the only behavior any pre-existing task or client can produce without
opting in) is byte-for-byte what shipped before this phase.
