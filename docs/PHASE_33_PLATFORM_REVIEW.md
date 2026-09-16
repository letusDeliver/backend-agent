# Phase 33 — Platform Evolution & Next Milestone Review

**Status**: Architecture review only. No implementation code changed.
**Scope**: Full audit of `origin/main` after Phase 32 (Manual Workspace Cleanup), traced through actual source, not documentation alone.

---

## 1. Current platform baseline

### Backend

Node/Express + TypeScript. JSON-file `TaskStore`/`ArtifactStore` under `tasks/<id>/`. `TaskOrchestrator` drives a fixed pipeline: `created → inspecting → routing → analyzing → reconciling → planning → implementing → reviewing → completed/failed/blocked/cancelled`. Real-mode execution runs in an isolated git worktree (`GitWorktreeManager`), gated by `assertSafeRepositoryPath()`. Phase 31 added `retry()` (restart from inspection, archiving prior attempts) and startup crash recovery (`recoverOrphanedTasks()`). Phase 32 added manual, server-eligibility-enforced workspace cleanup. All of this is implemented and tested — confirmed by direct code inspection, not just the completion reports.

### Frontend

Angular **22.1.6**, genuinely zoneless (`provideZonelessChangeDetection()`, no `zone.js`), signals used consistently. Four routes: Dashboard, Create Task, Task Detail, Memory. Task Detail is the primary surface and is detailed for reconciliation and reviews, thinner for the diff and for terminal states other than `completed`.

### Agent layer — what actually exists today

| Component | Status | Evidence |
|---|---|---|
| Specialist contracts (Node/Python/DB/Orchestrator) | **INTERFACE ONLY** | 4 files, 84 lines total, role/scope lists only — no encoded domain patterns, no code examples (`claude-code-platform-architecture-v0.1/agents/*/CLAUDE.md`) |
| Mock specialist analyze/implement/review | **MOCKED** (self-labeled) | Templated string interpolation, confidence hardcoded `0.7`, explicit "MOCK / SIMULATED EXECUTION" markers (`MockClaudeCodeExecutor.ts`) |
| Real specialist analyze/implement/review | **IMPLEMENTED** | Genuine `claude` CLI subprocess call with live repo access via `--add-dir`; gated behind `CLAUDE_EXECUTION_MODE=real` |
| Routing engine | **IMPLEMENTED** (deterministic) | Pure keyword-array matching, `routingEngine.ts` — no LLM call |
| Reconciliation / conflict detection | **IMPLEMENTED** (deterministic) | `decisionExtraction.ts` — own docstring confirms "No LLM call anywhere in this file" |
| Memory retrieval/injection | **PARTIALLY IMPLEMENTED** | Genuinely retrieved/filtered (`contextPack.ts`), but usage inside the LLM call is advisory/discretionary, not enforced or verified |
| Multi-agent collaboration | **NOT PRESENT** | `Promise.all()` parallel dispatch in both analyze and review stages (`taskOrchestrator.ts`); no specialist ever sees another's output before finalizing its own |
| Implementation plan | **IMPLEMENTED** (deterministic template) | Conditional file-path generation from stack + agent list, explicitly documented as a "best-effort" convention guess, not literal |
| Repository inspector | **PARTIAL / SHALLOW** | See §7 |

Repository grounding is mode-dependent: mock mode touches only pre-computed evidence strings; real mode delegates actual file reading to the `claude` CLI's own agentic tool use — the orchestrator itself never pre-injects file contents into any prompt.

---

## 2. Measured against the original vision

Original vision: `Developer → Requirement → Backend Engineering Control Center → Repository Understanding → Agent Selection → Specialist Collaboration → Reconciliation → Implementation → Review → Developer Handoff`, with specialists behaving like a coordinated senior engineering team.

| Capability | Classification |
|---|---|
| Repository understanding | **PARTIAL** — root-level, dependency-name-driven only |
| Agent selection (routing) | **FUNCTIONAL MVP** — deterministic, works for its stated scope |
| Specialist collaboration | **MISSING** — parallel-independent, not collaborative |
| Reconciliation | **FUNCTIONAL MVP** — genuinely the platform's strongest layer |
| Implementation | **FUNCTIONAL MVP** — real CLI call, ground-truth diff verification |
| Review | **PARTIAL** — real loop exists, but reviewer input is file names + test summary, not diff content |
| Developer handoff | **PARTIAL** — solid for `completed`, absent for `failed`/`blocked`/`cancelled` |
| Memory / learning | **FOUNDATION** — human-approved-only loop works, no freshness/dedup/semantic retrieval yet |
| Workspace lifecycle | **FUNCTIONAL MVP** — retry, crash recovery, cleanup all real and tested |

The platform is not "specialists behaving like a coordinated senior engineering team" yet — it is closer to *"three independently-briefed consultants file separate memos, and a deterministic clerk checks the memos for contradictions."* That clerk (reconciliation) is well-built. The consultants (specialists) are thin in mock mode and, in real mode, are only as good as the underlying `claude` CLI's own unaided judgment, since the platform gives them almost no repository-specific grounding beyond dependency names.

---

## 3. Biggest remaining gaps (evidence-based, not assumed)

1. **Review never sees the diff.** The platform's own stated principle is evidence-first, ground-truth-diff-over-self-report. That principle is honored for `changedFiles` (real `git diff`) but not for content: `GitWorktreeManager.diff()` uses `git diff --numstat` (path + add/delete counts only). The review prompt (`RealClaudeCodeExecutor.review()`) passes only a file list and test JSON — never the patch itself. A reviewer *can* independently run its own `git diff` inside the CLI session (it has repo access), but nothing requires or verifies that it does. This is the sharpest gap between what the platform implies ("review inspects the actual diff") and what the code guarantees.
2. **Repository understanding is a single shallow pass.** `repositoryInspector.ts` never reads Docker/compose files, `.env`, DB connection config, migrations folders, framework versions, existing API routes, or README content. It knows "this is probably FastAPI" from a dependency name; it does not know what the app's routes, DB schema, or deployment shape actually look like. Every downstream stage (specialist prompts, implementation plan file paths, routing) inherits this shallowness.
3. **No auth, no CORS restriction, unfiltered env passthrough to the CLI subprocess.** Every API route is unauthenticated; `cors()` has no origin restriction; the `claude` subprocess inherits the full parent environment with nothing stripped, and up to 4000 chars of raw test output is persisted verbatim as an artifact. For a single-developer local MVP this is a lower-urgency finding than for a shared/networked deployment, but it is real, current, and would need to be closed before this platform could ever run somewhere other than one developer's own machine.
4. **Multi-agent collaboration doesn't exist.** Specialists never see each other's output. This may or may not matter for the MVP (see §6 below) — the evidence shows reconciliation-after-the-fact catches genuine contradictions reasonably well — but it means claims like "specialists challenge each other" describe an aspiration, not current behavior.
5. **Failure-path handoff is missing entirely.** `handoff()` is only ever called on the success path. A `failed`/`blocked`/`cancelled` task gets a single error string, no structured summary of what was attempted, what the specialists concluded, or what a developer should do next.

---

## 4. Biggest architectural risks

- **Prompt injection from repository content is real and currently unmitigated.** Nothing in this codebase sanitizes, filters, or scopes what the `claude` CLI reads from the target repository (READMEs, source comments, etc.) before it acts. Mitigation today is entirely external to this codebase (the CLI's own model-level safety), not defense-in-depth built by this platform.
- **Repository path safety is a deny-list, not a sandbox**, and does not resolve symlinks (`assertSafeRepositoryPath()` checks `path.resolve()`, never `fs.realpath()`). A symlink whose target resolves into a denied path would currently bypass the check.
- **No automated test ever exercises the real `claude` CLI.** Every "real mode" test substitutes a fixture script. This is a known, previously-documented, accepted gap (ADR 0004) — a real CLI flag/output-format change would only surface via manual validation, not CI.
- **No concurrency test exists** despite `TaskOrchestrator` now having two independent in-process concurrency guards (retry, cleanup) — both are trusted by code review, neither by a test that actually races requests.

---

## 5. Developer workflow today

`Create task → repository auto-inspected (shallow) → specialists analyze in parallel (deterministically routed, real or mock) → reconciliation (genuinely good conflict detection) → deterministic implementation plan → real Claude Code implements in an isolated worktree → tests run (whole-suite, not baseline-diffed) → review (file list + test summary, not diff content) → up to 2 corrective passes → completed/blocked → handoff (rich if completed, thin/absent otherwise) → developer manually merges the branch, then optionally retries, resolves a conflict, or cleans up the workspace.`

**Where the platform creates real value today**: automatic stack detection and specialist routing removes the "who should look at this" decision; reconciliation's structured conflict detection is a genuine, evidence-grounded safety net that would be tedious to do by hand; real-mode execution with ground-truth diff verification means a developer can trust that `changedFiles` actually reflects what's on disk, not what the model claims; retry/crash-recovery/cleanup make the whole loop resilient to real failure modes instead of leaving dead tasks behind.

**Where the developer still does manual work**: reviewing the actual patch content (the platform doesn't show it to them beyond a summary string); verifying the implementation is architecturally sound beyond what a thin specialist contract + shallow repo scan can ground; deciding what to do with a `blocked`/`failed` task beyond a single error string; merging the branch themselves (by design, never automated); and trusting review conclusions without being able to see what the reviewer actually looked at.

---

## 6. Multi-agent collaboration — does the MVP need it?

Current architecture: parallel-independent analysis → deterministic post-hoc reconciliation. This is **not** the same as agents genuinely questioning each other, and the evidence shows this is a real simplification, not a documentation gap.

Whether this is a problem depends on what reconciliation is being asked to catch. It currently catches genuine *polarity contradictions* on the same subject (e.g., two specialists recommending opposite things) reasonably well, because the keyword/category/negation model is narrow and well-tested. It cannot catch a *missed* consideration — if Specialist A never thinks to mention something Specialist B would have flagged, there is no mechanism for B's report to prompt A to reconsider, because A already finished before B's report exists. For the MVP's current task complexity (single-repository, backend-focused tasks), the evidence doesn't show this missing-consideration failure mode actually occurring in practice — there's no task history or usage data suggesting reconciliation is currently insufficient. This is a case where the current architecture appears sufficient for the MVP; true agent-to-agent dialogue is a bigger architectural change (shared context window or a turn-based exchange) that the evidence doesn't yet justify.

---

## 7. Repository understanding — detailed findings

Single root-level pass in `repositoryInspector.ts` (145 lines):

| Signal | Status |
|---|---|
| `package.json` deps/scripts/framework | **IMPLEMENTED** (presence-check, not version-aware) |
| Python manifests (`requirements.txt`/`pyproject.toml`) | **SHALLOW** — substring match on concatenated raw text, not real TOML/requirements parsing |
| Database config (connection strings, ORM config, migrations) | **MISSING** — only dependency-name inference |
| Docker / docker-compose | **MISSING** |
| Environment files | **MISSING** |
| Folder-structure conventions | **MISSING** |
| Framework version | **MISSING** (name only) |
| Existing API route enumeration | **MISSING** |
| Test framework detection | **PARTIAL** (script-existence only for Node; pytest name-only for Python) |
| README / architecture parsing | **MISSING** |

**Can the platform understand an unfamiliar backend repository deeply enough to make safe engineering decisions today?** Only at the level of "which language/framework/DB family is this" — enough to route correctly, not enough to ground a specialist's recommendation in the repository's actual architecture, existing endpoints, or persistence layer configuration.

---

## 8. Implementation quality

- Prompt to Claude Code for `implement()` is concrete: task title/requirement, `detectedStack` JSON, plan summary, expected files, an explicit "smallest reviewable change... following existing repository conventions" instruction. Runs with `--permission-mode acceptEdits`. **IMPLEMENTED.**
- Test generation is never explicitly instructed — whether tests get written depends entirely on whether the LLM volunteers to write them. **MISSING** as an enforced step.
- Test execution re-runs the whole configured command (`npm test`/`pytest`) after every implementation and corrective pass — a regression anywhere fails the task. **IMPLEMENTED**, but this is a whole-suite gate, not a before/after baseline diff, so a pre-existing failing test (unrelated to this task) would also block completion.
- `changedFiles`/diff are ground-truth (`git diff` after `git commit` inside the worktree), explicitly overriding Claude's self-report — confirmed correct in code, matching prior-phase documentation. Diff granularity is `--numstat` only (path + counts), not patch content.

---

## 9. Review system

- Reviewer receives: task title, plan summary, file list, test-result JSON. **Not** diff content.
- Reviewer runs with live repo access (`--permission-mode plan`) so it *can* look at the real diff itself, but the prompt never hands it the diff, and nothing verifies that it looked.
- Corrective-pass loop is real: `MAX_REVIEW_RETRIES` (default 2), blocking findings trigger a re-implementation + re-test cycle; conflicting specialist findings short-circuit to reconciliation instead of looping.
- Exhausting retries correctly produces `blocked`, not a silent `completed`.
- Mock mode's reviewer always returns PASS — but this is explicitly and visibly labeled as simulated everywhere it's stamped; it is not a silent trust gap.

---

## 10. Memory system

Phase 29's human-approval gate is real and working: candidate lessons are generated only from completed tasks, require explicit approval, and are retrieved via keyword/tech-tag overlap (`buildContextPack()`), filtered per specialist. Usage inside the LLM call is advisory — nothing enforces that a specialist's recommendation actually reflects the memory it was given, and there is no measurement of whether injected memory changed an outcome. No semantic/vector retrieval, no freshness/invalidation, no dedup. Given the current memory volume is necessarily small (human-approval-gated), keyword retrieval is very likely still adequate — there's no evidence yet that its precision is a practical problem. The highest-value memory improvement isn't visible in the evidence collected here as urgent; it remains a "wait for volume" item, consistent with Phase 32's own prior conclusion for a related deferred item.

---

## 11. Observability

| Question | Answer today |
|---|---|
| Why did this task fail? | `task.error` + `TASK_FAILED` event — a single string, coarse |
| Which agent made a decision? | Reconciliation decisions carry `owner` — **IMPLEMENTED** |
| Which memory influenced it? | `memoryInfluenced` flag on conflict participants — **IMPLEMENTED** |
| Which files changed? | Ground-truth diff file list — **IMPLEMENTED** (counts, not content) |
| Which tests failed? | Structured test results — **IMPLEMENTED** |
| How long did each phase take? | Timestamps exist in the raw event log; **no computed per-phase duration anywhere** — derivable, not surfaced |
| How many Claude CLI calls happened? | Not tracked as a first-class number; derivable by counting `*_STARTED` events, but nothing computes it |
| Why did reconciliation block? | Full structured conflict record with evidence — **the platform's strongest observability surface** |
| What happened across retries? | Task-level retries: fully archived and browsable. Review-loop retries: events-only, one summary line in the UI |

The event/artifact system captures more than the UI or any computed metric currently surfaces. The gap is in aggregation/presentation, not in raw data capture.

---

## 12. Security (concrete attack surfaces found)

1. Repository path safety is a deny-list on `path.resolve()`, never `fs.realpath()` — a symlink pointing at a denied path would bypass it.
2. Git worktree commits run without `--no-verify`; a locally-installed git hook in the target repo executes inside the isolated worktree.
3. All subprocess invocations use argv arrays except `runTests()`, which uses a shell string — safe today only because `testCommand` is a fixed literal chosen by the inspector, never raw repository text.
4. The `claude` CLI subprocess inherits the full parent process environment, unfiltered. Combined with up to 4000 chars of raw test output persisted verbatim as an artifact, any secret present in the server's own environment has a path into a stored, API-exposed artifact.
5. Filesystem scoping to the worktree is CLI-convention-based (`--add-dir`, `--permission-mode`), not OS-level sandboxing.
6. **No mitigation anywhere in this codebase for prompt injection via repository content** — READMEs/source/comments are read directly by the `claude` CLI's own agentic tool use, with zero orchestrator-side filtering.
7. No dependency-install step exists (avoids install-script RCE); running the repo's own test command is a comparable, inherent, and currently accepted risk.
8. **No authentication or authorization on any API route; CORS is unrestricted.** For a single-developer localhost tool this is a known and currently acceptable MVP posture, but it means everything in 1–6 above is reachable by anything that can reach the port.

---

## 13. Human-in-the-loop

Currently exists only for memory approval. Implementation itself runs `Analyze → Implement → Review` with no human checkpoint between plan and execution — consistent with the platform's stated purpose (an agent that does the work, not one that asks permission for every step) and with the fact that real-mode execution is already opt-in, isolated, and reversible (worktree, not the developer's own checkout). The evidence doesn't show a specific incident or pattern where a pre-implementation approval gate would have prevented harm — Phase 30's blocking-conflict mechanism already provides a human checkpoint at exactly the point where the orchestrator would otherwise have to guess. Adding a mandatory plan-approval gate for every task would materially slow the workflow without clear evidence it's needed yet.

---

## 14. Task experience (UX)

Reconciliation and reviews are well-represented in the UI. Specialist findings are shown only as counts, not text. The implementation diff is a single summary string even though the backend model already carries per-file add/delete counts — never rendered. SSE delivers 24 event types that match exactly between backend and frontend, but the UI treats every event as a generic "something changed, refetch" trigger rather than rendering event payloads directly — functionally live, but not incrementally live. Final handoff is well-detailed for `completed` tasks and entirely absent for every other terminal state.

---

## 15. Final handoff

Present: summary (literally `plan.summary`, not an independent rationale), agents used, files changed (names, not diff content), test results, review results, a bare count of architecture decisions (pointing at `reconciliation.json` rather than including them). Missing: any `risks`/`followUps` field — risk information lives only in `reconciliation.json`, never surfaced in the handoff artifact itself. Never generated at all for `failed`/`blocked`/`cancelled` tasks.

---

## 16. Developer workflow friction points

- No visibility into actual patch content anywhere short-of the developer checking out the branch themselves.
- No structured next-step guidance for a `blocked`/`failed` task beyond a single error string.
- Specialist reasoning ("why did it recommend this") is not visible beyond a findings/risks count.

---

## 17. Architectural debt

- `GitWorktreeManager.diff()` computing `--numstat` only is the clearest example of an interface that under-delivers relative to what the rest of the system (and its own "ground truth over self-report" principle) implies it should provide.
- `ExecutionDiff.files` (backend type) already carries per-file additions/deletions that the frontend never renders — a real, currently-inert capability sitting unused.
- The repository inspector is a single, non-extensible root-level pass; adding a new signal (e.g., Docker detection) means another ad hoc `existsSync` check, not a structured extension point — acceptable at current scope, would not scale gracefully to a longer signal list without refactoring.
- No test exercises concurrency despite two independent concurrency guards existing (retry, cleanup) — a documentation/test-coverage divergence worth naming, though not necessarily worth a dedicated phase on its own.

---

## 18. Testing maturity

Actual current counts, independently verified: **198 backend (vitest) + 44 frontend (jest) + 1 Playwright E2E (mock-executor only) = 243 total.** Categorized: unit, integration/API, real-git integration (real git commands against a fixture CLI, not the real `claude` binary), frontend component, one crash-recovery test, no dedicated concurrency test.

**The single biggest, most consequential testing gap**: zero automated coverage of the real `claude` CLI. This is not new — it was identified and accepted in Phase 28 (ADR 0004) — but it remains the largest gap in the suite today, and no phase since has closed it (nor should it necessarily be closed by brute-force CI-invokes-the-real-CLI, given cost/determinism concerns; see Proposal §Testing/Real Execution candidate).

---

## 19. Real execution maturity

The real `claude` CLI has been invoked end-to-end exactly once, manually, in Phase 28, with independently-verified git state. Every automated test since — including all of Phase 31/32's retry, crash-recovery, and cleanup real-git tests — uses a fixture CLI script that mimics the real CLI's JSON envelope, not the actual binary. This is an accepted, previously-documented trade-off, not a new discovery, but it remains the platform's largest confidence gap for anyone running `CLAUDE_EXECUTION_MODE=real` on a real CLI version this codebase hasn't specifically been re-validated against.

---

## 20. Product maturity

**What this platform genuinely saves a developer from doing manually today**: manually figuring out which kind of specialist knowledge a request needs; manually cross-checking multiple engineers' recommendations for contradictions; manually setting up an isolated branch/worktree for an AI agent to work in safely; manually verifying that an agent's self-reported changes match what's actually on disk; manually tracking and recovering from a crashed or failed attempt; manually cleaning up disposable git state after the fact.

**What a developer still has to do manually**: actually read the patch content to judge correctness (the platform doesn't show it to them); independently verify the reviewer's PASS/FAIL against real code, since the reviewer's own basis for that verdict isn't visible; decide what to do next when a task is blocked or failed, beyond a one-line error; merge the resulting branch themselves (by design); and trust that the repository the platform is operating on doesn't contain anything designed to manipulate the agent, since nothing in this codebase currently defends against that.

---

*See `docs/PHASE_33_PROPOSAL.md` for candidate milestones and the Phase 33 recommendation.*
