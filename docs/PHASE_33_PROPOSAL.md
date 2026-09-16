# Phase 33 Proposal — Candidate Milestones & Recommendation

Companion to `docs/PHASE_33_PLATFORM_REVIEW.md`. This document proposes candidate next milestones and makes one recommendation. No code is authorized by this document.

---

## Candidate next milestones

### 1. Review Intelligence — Ground-Truth Diff Content

**Problem**: The platform's own evidence-first principle ("ground truth over self-report") is honored for *which* files changed but not for *what* changed. Reviewers and the UI both see only a file list and aggregate line counts, never the actual patch.

**Current state**: `GitWorktreeManager.diff()` computes `git diff --numstat` only. `RealClaudeCodeExecutor.review()`'s prompt includes file names and test JSON, never diff content. `ExecutionDiff` (backend type) already carries per-file add/delete counts that the frontend never renders.

**Target state**: `diff()` also captures full patch text (or unified diff per file), the review prompt includes it (with a size-bounded/truncation strategy for large diffs), and the Task Detail UI gets a per-file diff view.

**Why it matters**: This is the most concrete, provable gap between what the platform implies about its own review loop and what the code guarantees. It also closes the matching UX gap (diff shown only as a summary string).

**Architectural impact**: Contained — one backend method, one prompt, one new UI panel. No new services, no new stores, no schema migration (diff content can be stored as a new optional field or a separate artifact file).

**Implementation size**: Small–medium.

**Dependencies**: None beyond existing `GitWorktreeManager`/`ExecutionDiff`.

**Risks**: Large diffs could bloat prompts/artifacts — needs a truncation/summarization strategy, not unlimited raw text. Diff content may contain secrets if the target repo's change touches a config file — same class of risk already accepted for existing artifacts, but worth naming.

**Unlocks**: A materially more trustworthy review loop and a materially more useful Task Detail page, without touching agent intelligence, collaboration, or infrastructure.

**Out of scope**: Line-level review comments, inline diff annotation UI, syntax highlighting polish.

---

### 2. Repository Deep Understanding

**Problem**: `repositoryInspector.ts` is a single shallow, root-level, dependency-name-driven pass. It doesn't see Docker/compose, `.env`, DB connection config, migrations, folder structure, framework versions, existing API routes, or README content.

**Current state**: Enough to route correctly (language/framework/DB family); not enough to ground a specialist's recommendation in the repository's actual architecture.

**Target state**: A richer, still-deterministic (no LLM needed here) inspection pass that surfaces: Docker/compose presence, `.env.example` keys (not values), migrations folder presence + count, a lightweight API route enumeration (e.g. regex/AST-light scan for route-registration calls), framework version strings, and test-framework identification beyond "a test script exists."

**Why it matters**: Every downstream stage — routing, specialist prompts, the implementation plan's file-path guesses — inherits whatever `detectedStack` contains. This is the platform's shared foundation.

**Architectural impact**: Contained to `repositoryInspector.ts` and the `DetectedStack` type; ripples usefully into specialist prompts and the implementation plan without requiring changes to either's architecture.

**Implementation size**: Medium.

**Dependencies**: None.

**Risks**: Scope creep toward a full static-analysis engine; must stay deterministic/fast (no AST parsing rabbit hole) to preserve the "inspection is instant" property the pipeline currently relies on.

**Unlocks**: More grounded specialist prompts, more realistic implementation-plan file paths, better routing precision for repositories with ambiguous or mixed stacks.

**Out of scope**: True static analysis, dependency-graph construction, architecture diagramming.

---

### 3. Agent Intelligence Upgrade

**Problem**: Specialist contracts are 84 lines total across 4 files — role/scope lists, no encoded domain patterns. Mock mode is honestly thin (and clearly labeled); real mode already gets genuine LLM reasoning with live repo access via the CLI, so the contracts matter most as the *initial framing* the CLI receives, not as the sole source of intelligence.

**Current state**: Contracts work as a role brief; they carry no concrete architectural patterns, anti-patterns, or repository-specific checklists.

**Target state**: Contracts enriched with concrete, reusable engineering patterns per specialist (e.g., specific things a Node backend reviewer should check for, common Postgres migration pitfalls) — still static text, no code change to the executor.

**Why it matters**: A better-briefed specialist produces a better-grounded recommendation, especially in real mode where the CLI's own exploration is only as well-directed as its brief.

**Architectural impact**: Content-only change (markdown files), zero code risk.

**Implementation size**: Small (content), but return on investment is uncertain — the evidence shows real-mode specialists already reason well via the CLI's own general knowledge, so the incremental value of a longer contract is unproven without usage data.

**Dependencies**: None.

**Risks**: Longer contracts consume more prompt budget; risk of the contract becoming stale advice that fights the CLI's own better judgment on a specific repository.

**Unlocks**: Marginally better-grounded specialist output; primarily benefits mock-mode fidelity, which is lower-stakes since mock mode is never used to actually change code.

**Out of scope**: Any change to `analyze()`/`implement()`/`review()` code itself.

---

### 4. Multi-Agent Collaboration

**Problem**: Specialists run in parallel and never see each other's output before finalizing their own recommendation; reconciliation is entirely post-hoc.

**Current state**: `Promise.all()` dispatch, independent reports, deterministic post-hoc comparison. Catches genuine polarity contradictions; cannot catch a consideration one specialist never thought to raise.

**Target state**: Some form of turn-based exchange or shared context before finalization — architecturally the largest candidate here (a second LLM round per specialist, or a shared draft-then-critique pass).

**Why it matters**: Closest to the platform's original "coordinated senior engineering team" vision.

**Architectural impact**: Large — new orchestration sequencing, roughly doubles LLM calls per analysis phase (cost/latency), new prompt design for "here's what your peers said."

**Implementation size**: Large.

**Dependencies**: Would benefit from Repository Deep Understanding first (richer shared context to disagree productively about).

**Risks**: No usage evidence yet shows the current post-hoc model is actually insufficient for the MVP's task complexity; risk of building expensive collaboration machinery the data doesn't yet justify.

**Unlocks**: Potentially catches classes of disagreement the current model structurally cannot (missed considerations, not just contradictions).

**Out of scope**: Fully autonomous multi-turn negotiation without a bounded round limit.

---

### 5. Security Hardening

**Problem**: No authentication on any API route, unrestricted CORS, deny-list-only (non-realpath-resolved) path safety, unfiltered environment passthrough to the `claude` subprocess, and no defense against prompt injection from repository content.

**Current state**: Acceptable for a single-developer localhost MVP; several items (env passthrough, symlink bypass, no diff-content redaction) are real regardless of deployment context.

**Target state**: `fs.realpath()`-based path resolution before the safety check; an explicit, minimal env allow-list passed to the CLI subprocess instead of full inheritance; a documented (not necessarily code-enforced) stance on prompt-injection risk since true mitigation lives partly outside this codebase's control.

**Why it matters**: These are concrete, currently-exploitable gaps, not speculative ones — found by direct code inspection, not conjecture.

**Architectural impact**: Small-to-medium, mostly additive (an allow-list, a realpath call) rather than restructuring.

**Implementation size**: Small–medium for the concrete fixes (realpath, env allow-list); larger and open-ended for "solve prompt injection," which likely has no full code-level solution.

**Dependencies**: None.

**Risks**: Diminishing returns without a broader deployment-model decision (this is still explicitly a local MVP; full auth/multi-tenancy is out of scope per this review's own constraints).

**Unlocks**: A materially reduced (not eliminated) attack surface; a defensible answer to "what happens if the repository tries to manipulate the agent."

**Out of scope**: Enterprise auth, multi-tenant isolation, network-level sandboxing/containers.

---

### 6. Failure-Path Handoff Completeness

**Problem**: `handoff()` is only ever called on the success path. A `failed`/`blocked`/`cancelled` task gets a single error string and nothing else.

**Current state**: Rich handoff for `completed`; effectively nothing structured for every other terminal state.

**Target state**: A minimal handoff-equivalent for non-completed terminal states — what was attempted, which specialists ran, what they concluded, why it stopped — reusing the same artifacts already written (specialist reports, reconciliation, partial plan) rather than inventing new data.

**Why it matters**: A blocked/failed task is exactly the moment a developer most needs context, and today gets the least of it.

**Architectural impact**: Small — assembling already-existing artifacts into a second handoff variant.

**Implementation size**: Small.

**Dependencies**: None.

**Risks**: Low. Mostly a completeness gap, not a design risk.

**Unlocks**: A materially better experience for the (likely common, given review retries are capped at 2) non-happy-path outcome.

**Out of scope**: Retrying or auto-remediating the failure itself — that's already Phase 31's job.

---

## Recommended next milestone

### PHASE 33 — REVIEW INTELLIGENCE: GROUND-TRUTH DIFF CONTENT

**Why this**: Of all six candidates, this is the one where the evidence most directly shows a gap between what the platform's own architecture implies ("review inspects the actual diff," "ground truth over self-report") and what the code actually guarantees today. It is also the smallest, most contained candidate with the clearest immediate payoff — closing it doesn't require a new subsystem, a new concurrency model, or a policy decision about collaboration architecture.

**Why now**: Phase 32 just finished hardening the *lifecycle* around execution (retry, crash recovery, cleanup). The natural next step is hardening the *quality signal* the pipeline produces at its most safety-critical stage — review — rather than jumping to a much larger, less evidence-backed architectural change (multi-agent collaboration) or a diffuse one (repository understanding, security).

**Why not the other candidates right now**:
- *Repository Deep Understanding* is real but its payoff is diffuse and indirect (better inputs to a system that still can't show its own output clearly); it's a reasonable follow-up once review can actually surface what changed.
- *Agent Intelligence Upgrade* has uncertain ROI given real-mode specialists already reason well via the CLI's own capability — no evidence yet that thin contracts are the binding constraint.
- *Multi-Agent Collaboration* is the largest, most expensive candidate with no usage evidence yet that the current post-hoc reconciliation model is actually insufficient.
- *Security Hardening*'s concrete fixes (realpath, env allow-list) are worth doing but are risk-reduction, not developer-productivity-facing, and the platform's current single-developer-localhost posture makes this less urgent than it would be for a shared deployment.
- *Failure-Path Handoff* is genuinely small and valuable — a strong candidate for immediately after this one, but it's a completeness fix, not a correctness-of-the-core-loop fix.

**Evidence supporting this pick**: `GitWorktreeManager.diff()` (`server/src/execution/gitWorktree.ts`) computing `--numstat` only; `RealClaudeCodeExecutor.review()`'s prompt construction never including diff content; `ExecutionDiff.files` (backend type, `server/src/types/index.ts`) already modeling per-file data the frontend never renders — all found by direct code inspection during this review, not inferred.

**Existing architecture to reuse**: The ground-truth-diff pattern already exists and is trusted (`implement()`'s `commitChanges()` + `diff()` sequence); this phase extends its *content*, not its *existence*. The review prompt-construction pattern, the `ExecutionDiff` type, and the Task Detail panel structure are all already in place and just need extending, not replacing.

**New architecture actually necessary**: A patch-capture step in `GitWorktreeManager.diff()` (or a sibling method), a size-bounding/truncation strategy for prompt inclusion, and one new UI panel for per-file diff rendering. Nothing else.

---

## PHASE 33 — REVIEW INTELLIGENCE: GROUND-TRUTH DIFF CONTENT

*(Definition only — not an implementation authorization.)*

**Objective**: Make the actual patch content — not just file names and line counts — a first-class, ground-truth artifact that both the reviewer and the developer can see.

**Current problem**: `git diff --numstat` discards patch content; reviewers and developers alike currently only ever see "3 files changed, +42/-11" with no way to know what those 42 lines actually are without leaving the platform.

**Current implementation**: `GitWorktreeManager.diff()` → `ExecutionDiff{files: [{path, additions, deletions}], summary}` → stored in `execution-report.json` → rendered in Task Detail as a single summary string; review prompt never receives it.

**Target architecture**: `diff()` additionally captures unified patch text per file (bounded — e.g. a byte/line cap per file and in aggregate, with an explicit "diff truncated" marker past the cap, never a silent drop). Stored either as a new field on `ExecutionDiff` or as a sibling artifact file (`tasks/<id>/diff.patch`) if size makes embedding in JSON impractical. Review prompt includes the (possibly-truncated) patch text. Task Detail UI adds a collapsible per-file diff view using the existing `ExecutionDiff.files` structure plus the new patch content.

**Developer workflow**: Unchanged shape (`implementing → reviewing → completed/blocked`), but at review time and at handoff time, a developer can read the actual change without checking out the branch.

**Backend changes**: `gitWorktree.ts` diff capture; `types/index.ts` `ExecutionDiff` (or new artifact) schema addition; `RealClaudeCodeExecutor.review()` prompt construction; `artifactStore.ts` read/write if a sibling file is chosen.

**Frontend changes**: `task.model.ts` mirror of the new field; `task-detail.component.ts/html` new diff panel (likely per-file, collapsed by default given potential size).

**Agent changes**: Only the review prompt's input changes; no change to specialist contracts, routing, or reconciliation.

**Data model changes**: One new optional field or one new artifact-file type — no migration needed (optional field, well-defined absence for pre-Phase-33 tasks) if following the same no-migration convention Phase 32 established.

**API changes**: If a sibling artifact file is chosen, one new read-only `GET /tasks/:id/diff` (or extend the existing execution-report response) — additive only, no breaking change to existing endpoints.

**Testing strategy**: Unit test for patch capture (including the truncation boundary); real-git integration test (same fixture-executor pattern used throughout Phases 28–32) verifying patch content matches an actual `git diff` independently; frontend component test for the new diff panel (rendered/collapsed/empty states); a test confirming the review prompt actually includes diff content in real mode.

**Real-world validation**: Manual validation against a live server + real git repo (the same technique used for Phase 31/32 manual validation) — create a real diff, confirm the artifact/API returns patch content matching independently-run `git diff`, confirm truncation triggers correctly for an oversized diff.

**Security considerations**: Diff content may contain secrets accidentally introduced by the change (e.g., a hardcoded key in a config file). This artifact should be treated with the same sensitivity as existing execution-report content — no new exposure beyond what's already true today (unauthenticated local API), but worth a documentation note, not a new access-control mechanism (out of scope per this review's own MVP-scope guidance).

**Migration considerations**: None required if the new field is optional; existing tasks simply have no patch content, same pattern as Phase 32's `cleanupStatus`.

**Documentation**: Update `docs/API.md` (new field/endpoint), `docs/REAL_EXECUTION.md` (diff capture description), `docs/AGENT_WORKFLOW.md` (review loop section).

**Acceptance criteria**: A completed real-mode task's diff panel shows actual patch content matching independently-verified `git diff` output; the review prompt (verifiable via a captured-prompt test, same technique already used elsewhere) includes patch content; an oversized diff truncates visibly rather than silently or by crashing; all existing Phase 28–32 tests continue passing unmodified.

**Non-goals**: Inline review comments, syntax highlighting, line-level approve/reject UI, any change to the reconciliation or specialist-analysis stages.

**Known risks**: Prompt-size growth for large diffs (mitigated by truncation); patch content increasing artifact storage size (bounded by the same truncation).

**Estimated implementation complexity**: Small–medium — comparable in scope to Phase 32 (Manual Workspace Cleanup), touching fewer subsystems (no new orchestrator method, no new concurrency concern).

---

## Documents produced

- `docs/PHASE_33_PLATFORM_REVIEW.md`
- `docs/PHASE_33_PROPOSAL.md`

No implementation code was changed as part of this phase.
