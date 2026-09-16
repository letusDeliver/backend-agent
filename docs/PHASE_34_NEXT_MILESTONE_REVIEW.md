# Phase 34 — Next Milestone Review

**Status**: Architecture review only. No implementation code changed. Working tree confirmed clean
before and after this review; `main` confirmed in sync with `origin/main` at `716fbde`.

---

## 1. Current state

```
git status        → clean
git branch        → main
origin/main       → 716fbde (in sync, no divergence)
```

Phase 33 (Review Intelligence — Ground-Truth Diff Content) is the latest completed phase.

## 2. Phase 33 verification

Independently re-checked, not assumed from the completion report:

- `GitWorktreeManager.diff()` (`server/src/execution/gitWorktree.ts:157-186`) captures real patch
  text via `git diff <base> HEAD`, bounded by `maxPatchChars` with a `boundPatch()` helper that
  truncates at a file boundary and appends an explicit marker. Confirmed present, unchanged.
- `RealClaudeCodeExecutor.review()` (`server/src/execution/RealClaudeCodeExecutor.ts:333-345`)
  embeds `diff.patch` in the review prompt with the "UNTRUSTED REPOSITORY CONTENT / CODE DIFF"
  framing and an explicit truncation warning. Confirmed present, unchanged.
- `FinalHandoff.diffTruncated` (`server/src/types/index.ts:340`, set at
  `taskOrchestrator.ts:625`) confirmed present.
- Task Detail's "Implementation Diff" panel (`web/src/app/pages/task-detail/task-detail.component.html:397-425`)
  confirmed present with the truncation notice and collapsible patch.
- Full suite re-run clean: **205 backend / 49 frontend / 254 via `npm test`** — matches the
  completion report exactly, no drift.

Phase 33 landed correctly. This review builds on a verified, not assumed, foundation.

## 3. Reconstructed current lifecycle

```
Developer
   ↓
Create Task ──────────────────────────────────────────────┐
   ↓                                                       │
Repository Inspection (shallow, dependency-name-driven)    │
   ↓                                                       │
Routing (deterministic keyword table)                      │
   ↓                                                       │
[real mode only] Isolated workspace prepared                │
   ↓                                                       │
Memory Retrieval (validated-only, keyword/tag filtered)     │
   ↓                                                       │
Specialist Analysis (parallel, independent — Promise.all)   │
   ↓                                                       │
Reconciliation (deterministic conflict detection)           │
   ↓                                                       │
Conflict Gate ── unresolved material conflict ──→ BLOCKED ──┤
   ↓ clear                                                  │
Planning (deterministic template)                            │
   ↓                                                       │
Implementation (real CLI or mock; ground-truth diff+patch)   │
   ↓                                                       │
Tests (whole-suite gate)                                     │
   ↓                                                       │
Review (now diff-aware) ── blocking, retries exhausted ──→ BLOCKED
   ↓ clean / corrective pass loops back to Implementation    │
Handoff ── COMPLETED                                          │
                                                               │
[any stage] Exception ─────────────────────────────────→ FAILED
[any stage] POST /cancel ──────────────────────────────→ CANCELLED
[any terminal, non-blocked, real-mode] POST /cleanup-workspace
[failed/blocked/cancelled] POST /retry → restarts from Repository Inspection, archives prior attempt
[blocked, conflict resolved] POST /resolve → resumes from Reconciliation
```

This matches the prompt's proposed diagram with one correction worth naming explicitly: **`FAILED`
and `CANCELLED` are not symmetric with `BLOCKED`** in how much of the pipeline's own artifacts the
platform actually surfaces afterward — see §5.

## 4. Failure-path investigation

### What artifacts can exist, by terminal status

| Status | Specialist reports | Reconciliation | Plan | Execution report (+diff) | Reviews | Handoff |
|---|---|---|---|---|---|---|
| `completed` | always | always | always | always | always | always |
| `blocked` (routing) | never | never | never | never | never | never |
| `blocked` (reconciliation gate) | always | always | never | never | never | never |
| `blocked` (review exhausted) | always | always | always | always | always (all attempts) | never |
| `failed` (exception mid-pipeline) | **depends on where it threw — anywhere from none to all of the above** | | | | | never |
| `cancelled` (developer-initiated) | **depends on when cancel landed — same range as failed** | | | | | never |

`failed` and `cancelled` are not "less complete" than `blocked` in some uniform way — they are
**variably complete**, because an exception or a cancellation can land at any pipeline stage. A task
that fails on the very last review retry, or is cancelled mid-review, can have a full set of
specialist reports, reconciliation, a plan, an execution report (including a real ground-truth
diff), and every review attempt already written to disk — genuinely rich evidence for a developer to
act on.

### What the UI actually shows — and a concrete, verified bug

`web/src/app/pages/task-detail/task-detail.component.ts:178-201` (`refreshPanelsFor()`) gates every
artifact fetch by task status:

```ts
if (['reconciling', 'planning', 'implementing', 'reviewing', 'completed', 'blocked'].includes(task.status)) { … reconciliation … }
if (['planning', 'implementing', 'reviewing', 'completed', 'blocked'].includes(task.status)) { … plan … }
if (['implementing', 'reviewing', 'completed', 'blocked'].includes(task.status)) { … execution report … }
if (['reviewing', 'completed', 'blocked'].includes(task.status)) { … reviews … }
if (task.status === 'completed') { … handoff … }
```

**`'failed'` and `'cancelled'` do not appear in any of these four conditionals.** Only the
unconditional `getAgents()`/`getTaskMemory()` calls run for them. This is not a backend limitation —
independently verified: `GET /tasks/:id/reconciliation`, `.../implementation-plan`,
`.../execution-report`, `.../reviews` (`server/src/routes/tasks.ts:208-291`) apply **no status
gating at all**; they read whatever artifact exists and return `null` if it doesn't. The data these
routes would return for a rich `failed` or `cancelled` task — reconciliation, plan, execution report
(and, since Phase 33, the actual diff patch), reviews — is sitting on disk and reachable by URL, but
the frontend never asks for it. A developer looking at a `failed` task that died on review retry 2
sees only the top-level error string and the specialist reports — not the plan that was being
followed, not the diff that was implemented, not which review findings blocked it.

This is a frontend-only gating oversight (`blocked` was clearly added deliberately for Phase 30's
conflict UI; `failed`/`cancelled` were never revisited afterward), not a missing backend capability
— which makes it a materially different, and smaller, fix than "build new artifact generation for
failure paths."

### A second, related bug: the stage timeline goes blank for blocked and cancelled tasks

`TaskOrchestrator.block()` (`server/src/orchestrator/taskOrchestrator.ts:391-397`) does:

```ts
task.status = "blocked";
task.currentStage = "blocked";   // ← overwrites the real stage name
```

But `task.currentStage` had just been set to the *actual* pipeline stage (e.g. `"reconciling"`,
`"reviewing"`) by the most recent `setStage()` call moments earlier. `block()` immediately
overwrites it with the literal string `"blocked"` — which is not a member of the frontend's
`STAGE_SEQUENCE` (`inspecting, routing, analyzing, reconciling, planning, implementing, reviewing,
completed` — `web/src/app/pages/task-detail/task-detail.component.ts:28-38`).

The frontend's `stageState()` (`task-detail.component.ts:204-220`) was clearly written expecting
`currentStage` to hold a real stage name for a blocked task, so it can mark stages before it `done`
and the stage it stopped at specially (`'blocked'`, rendered as a `✕` icon with dedicated CSS —
`web/src/app/pages/task-detail/task-detail.component.html:97`, confirmed present in markup):

```ts
if (task.status === 'failed' || task.status === 'blocked') {
  const reachedIndex = STAGE_SEQUENCE.findIndex((s) => s.key === task.currentStage); // always -1
  if (sequenceIndex < reachedIndex) return 'done';      // -1 comparison — never true
  if (sequenceIndex === reachedIndex) return 'blocked'; // never true
  return 'pending';                                      // always hits this
}
```

Because `findIndex` returns `-1` for `"blocked"` (a string never in `STAGE_SEQUENCE`), **every stage
renders `'pending'` for every blocked task in production** — the entire stage timeline goes blank,
and the dedicated "✕ blocked-here" marker the UI was built to show never appears. The same applies to
`cancelled`: `POST /tasks/:id/cancel` (`server/src/routes/tasks.ts:125`) sets
`task.currentStage = "cancelled"`, and `stageState()` has no cancelled-specific branch at all, so it
falls through to the generic comparison against `STAGE_SEQUENCE.findIndex(s => s.key === task.status)`
— also `-1` — also always `'pending'`.

This was not caught by existing tests because the frontend's own spec fixtures
(`task-detail.component.spec.ts:177,195,284,349`) construct `Task` objects directly with
hand-picked, plausible `currentStage` values (e.g. `currentStage: 'reconciling'`) — which is exactly
what a developer would *expect* the real backend to produce, but is not what `block()`/`cancel`
actually write. The bug is invisible to frontend tests because they never exercise the real
backend's `block()` method, and invisible to backend tests because none of them assert on
`task.currentStage` after a genuine block/cancel. This is a textbook API/UI-assumption mismatch —
found only by reading both sides together, not by testing either in isolation.

**Classification**: both are genuine **bugs** (not "known limitations" or "future enhancements") —
small, mechanical, and contained (a one-line fix for the gating conditionals; a one-line removal or
correction for the `currentStage` overwrite). They are not milestone-sized on their own, but they sit
squarely inside the same problem the "Failure-Path Handoff Completeness" candidate was already
pointing at, and they make the case for that candidate concretely stronger than "the error message
could be nicer" — real, already-computed information is being actively withheld or destroyed on the
way to the screen.

### Attempt history has the same gap

The "Previous Attempts" panel (`task-detail.component.html:118-166`) shows archived
reconciliation/plan/execution/review/handoff artifacts per attempt once expanded, but never shows
*why* that attempt ended — there's no archived `status`/`error` surfaced anywhere in the attempt row
or detail card. A developer has to infer "this attempt failed" from the *absence* of a handoff, not
from being told directly.

### Next-actionable-step affordances

Retry availability is correct and already well-tested (Phase 31): offered for
`failed`/`blocked`/`cancelled`, gated server-side via `RETRYABLE_STATUSES`. Conflict resolution is
offered correctly for blocked-with-conflicts tasks. Cleanup is correctly withheld for `blocked`.
These are not part of the gap — the gap is specifically informational (what happened), not
actionable (what can I do next).

## 5. The important question, answered with evidence

> What information does a developer need to understand and act on a non-successful task without
> manually reconstructing the entire execution history?

The platform already computes and persists nearly all of it — specialist findings, reconciliation
decisions and conflicts, the plan, the ground-truth diff, review findings, which attempt, which
stage was reached. The gap is not missing data generation; it is **display logic that was extended
for `blocked` (Phase 30) and never extended to `failed`/`cancelled`**, plus **one line of backend
code that destroys stage information the frontend already depends on**. This changes the shape of
the recommended milestone from "design and build a new failure-summary artifact" (larger, riskier)
to "stop withholding/destroying data the platform already has, and add one synthesized summary on
top of it" (smaller, lower-risk, directly evidenced).

## 6. Non-happy-path survey

| Path | What happened is knowable from artifacts? | UI shows it today? | Retry? | Resolve? | Cleanup? |
|---|---|---|---|---|---|
| `failed` (exception) | Yes, variably rich | **No** (gating bug) | Yes | N/A | Yes (real mode) |
| `blocked` (routing) | Yes (nothing to show — genuinely empty) | Yes (correctly empty) | Yes | N/A | No |
| `blocked` (reconciliation) | Yes | Partial (timeline blank — bug) | Yes | Yes | No |
| `blocked` (review exhausted) | Yes, rich | Partial (timeline blank — bug) | Yes | Maybe (if conflict) | No |
| `cancelled` | Yes, variably rich | **No** (gating bug + blank timeline) | Yes | N/A | Yes (real mode) |
| startup-recovered | Yes (`task.error` names the interrupted stage) | Same as `failed` — gating bug applies | Yes | N/A | Yes (real mode) |
| retried | Prior attempt fully archived | Attempts panel (no per-attempt outcome reason) | N/A | N/A | N/A |
| cleanup-failed | `cleanupError` on `executionWorkspace` | Yes (Phase 32 built this correctly) | — | — | Re-triable |

The inconsistency is concrete and specific: **`blocked` is meaningfully better-supported than
`failed`/`cancelled` today, for no reason grounded in what data actually exists** — it's an artifact
of `blocked` having gotten Phase 30-era UI attention that `failed`/`cancelled` never received.

## 7. Other candidates, re-evaluated

### B. Repository Deep Understanding
Unchanged since Phase 33 — no commits have touched `repositoryInspector.ts` since. Still a single
shallow, root-level, dependency-name pass (confirmed: no Docker/.env/DB-config/migrations/routes/
README signal). Still real, still foundational, still larger and more diffuse in payoff than the
failure-path gap — nothing new elevates its urgency this cycle.

### C. Security Hardening
Unchanged since Phase 33 — no commits have touched `repositorySafety.ts`, `app.ts`, or
`RealClaudeCodeExecutor.ts`'s subprocess env handling. The realpath/symlink gap, no-auth/open-CORS
posture, and unfiltered env passthrough are all still exactly as documented. All three remain
"localhost-only acceptable, but real" — no new evidence this cycle promotes any of them to urgent
given the platform's still-local, single-developer deployment model.

### D. Multi-Agent Collaboration
Unchanged. Still `Promise.all()`-parallel, independent, reconciled post-hoc. No failure evidence
from this review (or any test, log, or artifact inspected) suggests specialists missing each other's
reasoning has caused an actual bad outcome — the gap remains theoretical relative to the concrete,
observed failure-path gaps above. Not recommended now, for the same reason Phase 33 didn't recommend
it: no usage evidence, largest implementation cost of any candidate.

### E. Agent Contract / Domain Intelligence
Unchanged. Contracts are still short role briefs; real-mode specialists still reason live via the
CLI's own repository access. Nothing in this review's code-level investigation (including the
failure-path artifacts inspected above) shows contract brevity as the cause of any concrete problem
— specialist reports themselves are consistently well-formed and evidence-referencing in every
artifact sampled. Still not evidenced as the bottleneck.

### F. SSE / Event Architecture
Unchanged: "event → refetch," not payload-driven. Directly relevant to this review only in that the
same `refreshPanelsFor()` gating bug governs both the initial load and every SSE-triggered refetch —
fixing the gating fixes both paths uniformly, since they share the same function. No independent case
for restructuring SSE itself emerged from this review.

### G. Workspace Lifecycle
No new evidence this cycle to reopen automatic/time-based retention. Phase 32's manual-only decision
stands; nothing in the failure-path investigation touched workspace cleanup logic or found a new
gap there.

## 8. Other hidden gaps found (not already documented)

Beyond the two bugs detailed in §4, a broader pass surfaced:

- **`startup-recovered` tasks inherit the same display gating bug as `failed`** — `recoverOrphanedTasks()`
  sets a task to `failed` with a stage-naming error message; since `failed` is excluded from every
  artifact-fetch conditional, a crash-recovered task with a fully-populated execution report shows
  exactly as little as any other failed task. Same root cause, same fix.
- **No test asserts `task.currentStage` after a real `block()` call** (backend) and **no test
  constructs a `Task` fixture by actually driving the orchestrator to a blocked/failed state and then
  rendering it** (frontend) — the reason this bug went undetected. This is a testing-methodology gap
  worth naming, not a separate milestone: both suites test "does the component render X correctly
  given Y state" and "does the orchestrator reach the right terminal status," but nothing currently
  tests "does the exact state the orchestrator produces survive being rendered correctly."
- **Not a new bug, re-confirmed as still accurate**: `runTests()` cannot be cancelled independently
  of the overall timeout (documented in `REAL_EXECUTION.md`); the real Claude CLI still has zero
  automated (non-fixture) coverage in CI (ADR 0004, most recently manually re-validated in Phase 33).

Nothing else found in this pass rose above "already-documented known limitation" or "cosmetic."

## 9. Test coverage — current, verified numbers

**255 total** (re-verified via `npx vitest run` / `npx jest`, not assumed): 205 backend, 49 frontend,
1 Playwright. `npm test` runs 254 (backend+frontend).

Given this review's findings, the specific coverage gap that matters is narrow and precise: **no
test — frontend or backend — verifies what the Task Detail page actually renders for a `failed` or
`cancelled` task that has real reconciliation/plan/execution/review artifacts on disk.** Every
existing failed/cancelled-related frontend test constructs its own plausible-looking fixture rather
than exercising this path, which is exactly why the two bugs in §4 shipped undetected across Phases
28–33. This is not "more tests needed" in general — it's this one specific, nameable, high-value gap.

## 10. Real execution safety

No changes to `RealClaudeCodeExecutor`, worktree handling, timeout, or cancellation logic since
Phase 33 — nothing here changed and nothing new was found in this pass that should precede
productivity-focused work. The known gaps (env passthrough, no realpath resolution, zero real-CLI
CI coverage) are unchanged and, as in Phase 33's assessment, don't block proceeding with a
UI/data-visibility milestone that touches none of this code.

---

# PHASE 34 — NON-SUCCESS TASK VISIBILITY

## Current state

`blocked` tasks get a partial view (broken stage timeline, but full artifact panels).
`completed` tasks get the full view. `failed` and `cancelled` tasks get almost nothing — not because
the data doesn't exist, but because the frontend never asks for it, and because one backend method
destroys stage-progress information on the way to being blocked.

## Problem

A developer whose task fails or gets cancelled partway through — plausibly the single most common
"something needs my attention" moment in daily use of this platform — sees a bare error string (or,
for cancelled tasks, no explanation at all) and a blank stage timeline, even when the platform has
already computed and stored a plan, a ground-truth diff, and review findings that would tell them
exactly what to look at.

## Evidence

- `refreshPanelsFor()` (`task-detail.component.ts:178-201`) omits `'failed'`/`'cancelled'` from
  every artifact-fetch conditional; the corresponding backend routes apply no status gating at all
  (`routes/tasks.ts:208-291`) — the data is one unconditional fetch away.
- `TaskOrchestrator.block()` (`taskOrchestrator.ts:393`) overwrites `task.currentStage` with the
  literal string `"blocked"`, which is not in `STAGE_SEQUENCE`, making `stageState()`
  (`task-detail.component.ts:210-215`) return `'pending'` for every stage of every blocked task —
  verified by tracing the exact `findIndex`/comparison logic, not by observation alone. The same
  applies to `cancelled` via the cancel route's `currentStage = "cancelled"` write.
  A dedicated `'blocked'` stage-state UI (a `✕` marker with its own CSS class) already exists and is
  currently unreachable dead code as a direct result.
- The "Previous Attempts" panel shows archived artifacts but never the archived attempt's own
  outcome/error, requiring inference from absence rather than a direct statement.

## Why this matters now

It is the most concretely evidenced gap found across two consecutive review cycles (Phase 33's
audit named it qualitatively; this cycle traced it to two exact, small, fixable defects plus a
frontend data-fetching bug affecting real, already-persisted data). It requires no new artifact
generation, no new backend subsystem, no schema redesign — it is a correctness fix to existing
display logic plus one new synthesized summary, which keeps it small while still closing the
platform's most visible remaining "the evidence exists but the developer can't see it" gap.

## Target workflow

A `failed` or `cancelled` task's Task Detail page shows: the same specialist/reconciliation/plan/
execution/review panels a `blocked` or `completed` task shows, populated from whatever artifacts
actually exist for that run; a correct stage timeline showing real progress up to the point of
failure/cancellation, with the interrupted stage visually marked; and one synthesized "what
happened, what's known, what you can do next" summary — built from data the platform already has
(status, error, last stage, attempt number, whether reconciliation/plan/execution/reviews exist),
not a new inference engine. The "Previous Attempts" panel additionally shows each archived attempt's
final status/error inline, not only on expansion.

## Architecture impact

Small. No new `TaskStatus`, no new artifact type, no new store, no new API route (the existing
per-artifact GETs already work for any status). Two corrections to existing logic
(`refreshPanelsFor()`'s conditionals; `block()`'s `currentStage` assignment, and giving `cancel`'s
route the same correct treatment) plus one new lightweight synthesis function/UI section reusing
already-fetched data.

## Implementation size

Small–medium — smaller than Phase 33 in backend scope (one corrected field write, no new git/patch
logic), comparable in frontend scope (one panel plus a fetch-gating correction plus a stage-timeline
fix).

## Main risks

- `currentStage` is read by other code paths (attempt archiving, startup recovery's stage-naming
  error message) — changing what `block()`/`cancel` write to it must be checked against every
  reader, not just the Task Detail UI, to avoid a narrow fix that breaks a different consumer.
- A "what happened" synthesis, done carelessly, could imply more certainty than the data supports
  (e.g., guessing a root cause instead of stating what's known) — the existing platform-wide
  evidence-first principle should bound this explicitly: state only what's directly derivable from
  persisted fields, never an inferred narrative.

## Testing strategy

Backend: a test that actually drives a task through `block()`/`handleRunFailure()`/the cancel route
via the real orchestrator (not a hand-built fixture) and asserts `task.currentStage` holds a real
stage name afterward — directly closing the coverage gap named in §9. Frontend: a test that renders
Task Detail for a `failed`/`cancelled` task with realistic backend-shaped artifacts present and
asserts the same panels a `blocked` task gets are shown; a `stageState()` test using a `currentStage`
value produced by the actual fix, not a hand-picked plausible one. Regression: full existing suite
(retry, crash recovery, conflict resolution, cleanup, diff capture) must remain green, since the
`currentStage` semantics change touches code several other features read.

## What this unlocks

A developer can act on any non-successful task using the same evidence the platform already
generated for it, closing the gap between "the platform computed rich diagnostic information" and
"the developer can actually see it" — directly advancing the platform along the
"implementation-aware → review-aware → **history-aware**" progression named in Phase 33's own
review principle.

## Known limitations

Does not add any new diagnostic capability the platform doesn't already compute (e.g., no per-phase
timing, no CLI-call counting — those remain separate, larger "Observability" candidates named in
Phase 33's review and not part of this scope). Does not change retry/resolve/cleanup eligibility or
behavior — those are already correct.

## Explicit non-goals

No automatic retry, no new failure-classification taxonomy, no root-cause inference, no changes to
`RETRYABLE_STATUSES`/`WORKSPACE_CLEANUP_ELIGIBLE_STATUSES`, no observability/metrics subsystem, no
changes to reconciliation, review, memory, or real execution logic.

## Dependencies

None — independent of every other open candidate.

## Expected files/subsystems

`server/src/orchestrator/taskOrchestrator.ts` (`block()`, and reviewing whether `retry()`'s reset and
`recoverOrphanedTasks()` need the same correction), `server/src/routes/tasks.ts` (cancel route's
`currentStage` write), `web/src/app/pages/task-detail/task-detail.component.ts`
(`refreshPanelsFor()`, `stageState()`), `web/src/app/pages/task-detail/task-detail.component.html`
(a new non-success summary section; the Previous Attempts row). No changes anticipated to
`server/src/types/index.ts` (the `currentStage: string` field's type doesn't need to change, only
what gets written to it).

## Acceptance criteria

A task driven to `failed` or `cancelled` mid-pipeline with real backend-generated artifacts shows
those artifacts on Task Detail, matching what a `blocked` task with the same artifacts already
shows. A blocked or cancelled task's stage timeline correctly marks stages already passed as done
and the interrupted stage distinctly — verified against the real `currentStage` value the orchestrator
actually writes, not a hand-picked test fixture. The Previous Attempts panel shows each archived
attempt's outcome without requiring expansion. All Phase 28–33 tests continue passing unmodified.

---

## OTHER VALID NEXT OPTIONS

**Repository Deep Understanding** — closing the gap between the platform's shallow, dependency-
name-only repository inspection and genuine architecture awareness (Docker, DB config, routes,
README). Matters because it's the shared foundation every downstream stage inherits. Not the
immediate next step because its payoff is diffuse and indirect compared to the concrete, traceable
bugs found this cycle, and it's a larger, more open-ended body of work.

**Security Hardening (realpath resolution + subprocess env allow-list)** — two concrete, contained
fixes (symlink bypass in the path-safety check; unfiltered environment passthrough to the `claude`
subprocess) identified in Phase 33's review and re-confirmed unchanged this cycle. Matters because
both are real, currently-exploitable gaps, not speculative ones. Not the immediate next step because
neither has any evidence of being hit in practice on this still-local, single-developer platform,
and Non-Success Task Visibility has stronger, code-traced evidence of actually affecting the daily
workflow today.

**Observability (per-phase timing, CLI-call counting)** — the event log already has the raw
timestamps; nothing currently computes or surfaces durations or call counts. Matters because it
would answer real "why is this task slow" questions. Not the immediate next step because it's a
new, if small, computation layer rather than a fix to something already broken, and no user-facing
pain from its absence was found in this review (unlike the failure-path gaps, which are directly
observable defects).

**Testing-methodology fix (drive-the-real-orchestrator fixtures)** — named in §8/§9 as the root
cause the two bugs went undetected. Matters as a durable prevention measure. Not proposed as its own
milestone because it's naturally delivered as part of Phase 34's own testing strategy, not a
separate body of work.
