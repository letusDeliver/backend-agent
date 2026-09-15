# Next Steps — Architecture & Product Review

Status: analysis only. No source, config, tests or dependencies were modified to produce this document. All findings are grounded in the actual repository state as of this review, not the project-memory source documents (`docs/source/backend_engineering_agent_platform_project_memory_v2.0.docx`) or the architecture package (`claude-code-platform-architecture-v0.1/`), which describe intent — the code is authoritative for what exists.

---

## 1. Executive Summary

The MVP is real, not a shell: the full pipeline (inspect → route → analyze → reconcile → plan → implement → review → handoff) runs end-to-end against a real local repository, over real SSE, with 56 passing tests and two clean Angular migrations (18→22, then zoneless+signals) already shipped. The documentation is unusually honest about its own limitations — `docs/MVP_COMPLETION_REPORT.md` already names most of the gaps this review independently found by reading the code.

Two things stand out as more urgent than anything on the original roadmap:

1. **The platform's core promise — Claude Code actually implementing a backend change — has never been exercised.** `RealClaudeCodeExecutor` is fully coded, typed, and unit-untested, and it operates directly on whatever repository path the user types, in `acceptEdits` mode, with no git isolation, no diff review, and no cancellation. The mock executor (which is what every test and every demo has ever run) proves the *orchestration* works. It proves nothing about whether the *execution* is safe or correct.
2. **The engineering-memory layer described in the platform's own vision — "Validated Engineering Memory" at the end of the pipeline diagram — is dead code.** `JsonFileMemoryStore` is instantiated in `container.ts` and never referenced anywhere else in the codebase. `ORCHESTRATOR.md`'s own Responsibility #3 ("Retrieve relevant memory/context") is simply skipped by `TaskOrchestrator.run()`.

Neither of these is a surprise buried in the code — both are implicitly or explicitly flagged in the project's own docs. This review's contribution is prioritizing them correctly and turning them into a concrete, scoped milestone.

**Overall assessment: 7/10.** Strong architecture, unusually honest self-documentation, clean separation of concerns, real (not simulated) verification of everything that *has* been exercised. The score isn't higher because the platform's single most consequential capability — mutating a real repository — is both unproven and unsafe as wired, and because a designed, storage-complete subsystem (memory) contributes zero product value today.

---

## 2. Current System Assessment

### What exists and works

- **Frontend** (`web/`): Angular 22, fully signals-based, zoneless (no `zone.js` in the bundle). Three routed pages (Dashboard, Create Task, Task Detail), an `EventSource`-backed `TaskService`, 13 Jest tests, verified live via Playwright against the real dev stack with zero console errors.
- **Backend** (`server/`): Express + TypeScript, ~2,140 lines across 24 files. Clean layering: `routes/` (HTTP) → `orchestrator/` (workflow) → `execution/` (Claude Code abstraction) → `artifacts/` + `store/` (persistence). 43 Vitest tests, including a full Python+PostgreSQL end-to-end happy path.
- **Agent package** (`claude-code-platform-architecture-v0.1/`): three concise specialist contracts (Python, Node, Database), an orchestrator contract, three skill docs, an artifact-contracts schema. Small, readable, and — notably — actually followed by the code (the artifact filenames in `protocols/artifact-contracts.json` match `artifactStore.ts` exactly).
- **Docs**: README, API.md, MVP_ARCHITECTURE.md, AGENT_WORKFLOW.md, LOCAL_DEVELOPMENT.md, MVP_COMPLETION_REPORT.md, MVP_IMPLEMENTATION_ASSESSMENT.md — all current, cross-referenced, and (unusually) already list most of this review's findings under "Known limitations."

### What's thin or missing

- No CI of any kind (no `.github/workflows`, no pipeline). Every verification so far has been a human (or an agent, standing in for one) running commands locally.
- `RealClaudeCodeExecutor` has zero dedicated tests (no mocked `child_process` coverage of prompt construction, JSON-extraction, or failure paths) and has never been run against a live repository.
- The Playwright browser verification that's been run manually several times this session lives only in a scratchpad script, not in the repository — there's no committed, automated UI regression test.
- Memory: fully typed, fully storage-complete, zero runtime callers.
- No task cancellation, no retry/resume for `blocked`/`failed` tasks, no crash recovery (a server restart mid-task orphans it silently in whatever status it was in).
- `Reconciliation.status` can be `"AGREED" | "CONFLICT" | "UNKNOWN" | "NEEDS_USER_DECISION"` per the type, but `reconcile()` (`server/src/orchestrator/reconciliation.ts`) never assigns `CONFLICT` — there is no code path that detects two specialists materially disagreeing.

---

## 3. Architecture Assessment

The Phase 19 pivot (documented in `docs/MVP_ARCHITECTURE.md` and `MVP_IMPLEMENTATION_ASSESSMENT.md`) — retiring a custom agent runtime (Model Adapter, Tool Gateway, Context Engine) in favor of Claude Code as the execution substrate — was the right call and the code honors it cleanly. The orchestrator is a thin coordination layer over a narrow `ClaudeCodeExecutor` interface; it does not reimplement anything Claude Code already does. This keeps the codebase small (2,140 lines) and the differentiated logic (routing, reconciliation, review gating) easy to read and test in isolation from any LLM.

The `TaskStore` / `ArtifactStore` / `ClaudeCodeExecutor` / `MemoryStore` interfaces are all narrow and swap-ready — a `PostgresTaskStore` or a semantic `MemoryStore` could be dropped in without touching the orchestrator. This is good design discipline that should be preserved rather than "fixed."

The weak point is not the shape of the architecture but its **least-exercised edge**: everything downstream of `ClaudeCodeExecutor.mode === "real"`. The abstraction is correct; the concrete implementation behind it has run zero times in anger.

---

## 4. Product Capability Matrix

| Capability | State | Evidence |
|---|---|---|
| Task creation & validation | COMPLETE | `routes/tasks.ts`, `paths.test.ts`, `api.test.ts` |
| Repository inspection (Node/Python) | COMPLETE | `repositoryInspector.ts` + 4 tests |
| Repository inspection (monorepo/workspaces) | MISSING | inspector only reads root `package.json`; this repo's own `web`/`server` workspaces would be invisible to it |
| Cross-stack routing | COMPLETE | `routingEngine.ts` + 8 tests covering the full Phase 24 matrix |
| Specialist analysis (mock) | COMPLETE | `MockClaudeCodeExecutor.analyze()` |
| Specialist analysis (real) | PARTIALLY COMPLETE | implemented, zero tests, never run |
| Reconciliation (AGREED/UNKNOWN/NEEDS_USER_DECISION) | COMPLETE | `reconciliation.ts` + 4 tests |
| Reconciliation (CONFLICT detection) | MISSING | type exists, never assigned |
| Implementation planning | COMPLETE (heuristic) | `implementationPlan.ts` — file-path guesses, by design deferred to real Claude Code conventions |
| Implementation execution (mock) | COMPLETE | `MockClaudeCodeExecutor.implement()` |
| Implementation execution (real) | NEEDS REDESIGN | works but mutates the caller's live working tree directly, no isolation |
| Test execution (real) | COMPLETE | `RealClaudeCodeExecutor.runTests()` shells the repo's own detected command, independent of the LLM |
| Review loop with bounded retries | COMPLETE | `taskOrchestrator.reviewLoop()` + review-routing skill |
| Final handoff | COMPLETE | JSON + Markdown, matches artifact contract exactly |
| Task cancellation | MISSING | no endpoint, no UI |
| Task retry/resume (blocked/failed) | MISSING | dead-end terminal states |
| Crash recovery | MISSING | in-process fire-and-forget orchestration |
| Live SSE progress | COMPLETE (coarse) | stage-level events; no live Claude Code stdout |
| Task history (memory) | COMPLETE | artifact trail on disk |
| Project/global/lesson memory | MISSING (wiring) | fully typed and stored, zero callers |
| Memory retrieval in orchestration | MISSING | `ORCHESTRATOR.md` responsibility #3, unimplemented |
| Knowledge ingestion (Phase 26 vector/RAG) | NOT YET NECESSARY | explicitly deferred by the project's own instructions; no lessons exist yet to ingest |
| UI: task visualization | COMPLETE | verified live via Playwright |
| UI: memory visibility | MISSING | no page/section exists |
| UI: cancel/retry actions | MISSING | no buttons |
| Auth | NOT YET NECESSARY | explicit single-developer local-tool scope |
| CI | MISSING | no workflow of any kind |
| Automated browser/E2E test | MISSING | manual Playwright only, not committed |
| Structured logging/observability | MISSING | two `console.log` lines at boot, `console.error` on 500s |
| CLI one-command target (`/backend-task`) | NOT YET NECESSARY | stated vision in `CLAUDE.md`, UI already delivers the core value |
| Additional specialists (security, DevOps, QA...) | NOT YET NECESSARY | no evidence yet that the 3-agent set is insufficient |

---

## 5. Gap Analysis (Narrative)

**Core orchestration** is the strongest part of the system — every stage of the state machine is real, tested, and matches its own documentation. The one structural hole is that `blocked` and `failed` are true dead ends: there is no way, short of creating a brand-new task, to retry a task that failed a transient real-execution call or was blocked pending a human decision that has since been made.

**Agent architecture** is honest about its own limits: specialists run fully in parallel (`Promise.all`) with no cross-consultation during analysis, which is a correct simplification for the current 3-agent scope — but `agents/python-backend/CLAUDE.md` and `node-backend/CLAUDE.md` both say "for material database concerns, consult the Database Agent through the defined artifact protocol," and no such mid-flight consultation mechanism exists. Reconciliation happens only after all specialists finish, at the orchestrator level. This isn't a bug today (no test or real scenario has needed it), but the specialist contracts currently promise a capability the runtime doesn't have.

**Repository intelligence** covers the common case well (single-language repo, root manifest) but doesn't handle the platform's own repository shape (npm workspaces monorepo) — worth fixing if only because it's the most natural "eat your own dog food" test repository available locally.

**Claude Code integration** is where the gap between "designed" and "battle-tested" is widest. The abstraction (`ClaudeCodeExecutor`) is clean. The concrete real implementation is a single, un-mocked, un-tested shell-out that runs directly against the caller-supplied path with file-write permission and no containment. `docs/MVP_COMPLETION_REPORT.md` says this outright: "Not exercised end-to-end in this session." That was true when written and is still true today.

**Memory** is the clearest example of "built but not connected" in the whole codebase — a working store, a working (if simple) retrieval function, correct types matching the documented five-way memory model, and precisely zero production code paths that call any of it.

**UI** is complete for what it shows, and shows nothing it doesn't have real data for — consistent with the platform's evidence-first principle. It has no visibility into memory (because there's nothing to show) and no controls for cancel/retry (because the backend has none to call).

**Developer experience** is genuinely good for local setup (LOCAL_DEVELOPMENT.md is thorough, including two hard-won troubleshooting entries from this session's own npm/Angular upgrades) but weak for anyone debugging a running task beyond reading its artifact files — there's no structured server log and no CI to catch a regression before a human notices it.

---

## 6. Risks

1. **Unproven, unisolated real execution.** If a user sets `CLAUDE_EXECUTION_MODE=real` today and points it at a repository with uncommitted work, `implement()` can modify files in that working tree with no snapshot, no branch, and no way to cancel mid-run. This is the highest-severity risk in the system, precisely because the product's value proposition depends on this path eventually being used.
2. **No regression safety net.** Two non-trivial frontend migrations just landed by hand-verification alone. The next change to `taskOrchestrator.ts`, `routingEngine.ts`, or any Angular component ships with no automated gate beyond "someone remembers to run `npm test`."
3. **Silent task orphaning.** A server crash or redeploy mid-task leaves that task permanently stuck in a non-terminal status with no operator-visible signal beyond "it's been a while."
4. **Reconciliation blind spot.** A cross-stack task where two specialists genuinely disagree (not merely one failing) currently reconciles to `AGREED` as long as both technically "completed" — there's no code path that would ever produce `CONFLICT` and surface the disagreement to the developer.
5. **Unbounded repository path.** `resolveRepositoryPath` validates existence and directory-ness, not sensibility — a user (or a scripted client) can point real-mode execution at `$HOME`, `/`, or any directory the server process can write to.
6. **CORS is wide open** (`cors()` with no options). Low risk today (localhost-only tool, no auth-bearing data), but it's a live vulnerability the moment this is ever reachable from anywhere but `localhost`.

---

## 7. Architecture Decisions To Revisit

| Decision | Verdict | Why |
|---|---|---|
| JSON-file task store | KEEP | Correct for single-developer local scale; `TaskStore` interface is already the swap seam |
| Local artifact storage (`tasks/<id>/`) | KEEP | Core to the evidence-first product design, not a bottleneck |
| Server-Sent Events for live updates | KEEP | Simple, works, verified live; no evidence WebSockets would add value |
| Real execution model: direct path + `acceptEdits`, no isolation | **CHANGE NOW** | Highest risk in the system; see Milestone below |
| Repository path validation: existence-only, no sensibility guard | **CHANGE NOW** | Cheap to add alongside the isolation work; prevents pointing real-mode at `$HOME`/`/` |
| Agent invocation: CLI shell-out per call, contract text injected into the prompt | KEEP | Matches the Phase 19 pivot rationale; no evidence it needs to change |
| Memory: typed interfaces + JSON store, unwired | CHANGE LATER (soon) | Storage/types are fine as-is; only the wiring (retrieval-in, promotion-out) is missing — no redesign needed, see Milestone M5 |
| Frontend: Angular standalone + signals + zoneless | KEEP | Just migrated and verified; leave it alone |
| Backend: Express, layered orchestrator/execution/store/artifacts | KEEP | Clean, testable, no rewrite justified |
| CORS: wide open | CHANGE LATER | Tighten to the known frontend origin before any non-localhost exposure; not urgent for today's local tool but a two-line fix |
| No authentication | KEEP for now | Correct for an explicitly single-developer local tool; revisit only if multi-user/hosted use becomes a real goal |

---

## 8. Prioritized Roadmap

### P0 — Critical

**P0-1. CI + committed browser regression test**
- Why it matters: zero automated regression protection exists anywhere in the repo today.
- Current state: MISSING.
- Problem it solves: prevents a future change from silently breaking either test suite or the live SSE/signals UI flow that only manual Playwright runs currently catch.
- Dependencies: none.
- Risk: low.
- Complexity: small.

**P0-2. Isolated, safe real execution**
- Why it matters: the platform's core differentiator — Claude Code actually writing code — is implemented but unproven and unsafe as wired.
- Current state: NEEDS REDESIGN.
- Problem it solves: makes `CLAUDE_EXECUTION_MODE=real` something a developer can turn on without risking uncommitted local work.
- Dependencies: P0-1 (should land first so the riskier change is protected by CI).
- Risk: medium (touches the execution path directly).
- Complexity: medium.

### P1 — High

**P1-1. Task lifecycle completion: cancel, retry, resume**
- Why it matters: `blocked`/`failed` are currently dead ends; a server restart silently orphans in-flight tasks.
- Current state: MISSING.
- Problem it solves: makes the state machine actually operable, not just observable.
- Dependencies: none structurally; benefits from P0-2's task-metadata changes (worktree/branch) landing first.
- Risk: low-medium.
- Complexity: medium.

**P1-2. Live execution streaming + basic observability**
- Why it matters: a multi-minute real `implement()` call currently shows the developer nothing between "started" and "completed."
- Current state: MISSING (coarse SSE only).
- Problem it solves: the product's own "what did the agent do, why" promise, for the one execution mode that actually matters.
- Dependencies: P0-2 (streaming naturally extends the isolated-execution rework).
- Risk: medium.
- Complexity: medium.

**P1-3. Wire the memory layer's first real loop**
- Why it matters: a fully-built, fully-tested-by-type subsystem currently contributes zero product value.
- Current state: MISSING (wiring only — storage and types are complete).
- Problem it solves: makes "Validated Engineering Memory," the last box in the platform's own vision diagram, real for the first time.
- Dependencies: none structurally; more valuable once P0-2/P1-2 have produced a few real (not mock) completed tasks to learn from.
- Risk: low.
- Complexity: small-medium.

### P2 — Medium

**P2-1. Reconciliation: real conflict detection**
- Why it matters: cross-stack tasks are the platform's most interesting case, and `CONFLICT` — a status the type system already promises — can never actually fire.
- Current state: MISSING.
- Dependencies: benefits from real multi-agent task volume (post P0-2) to calibrate what "material disagreement" should mean.
- Risk: low. Complexity: medium.

**P2-2. Repository inspection for monorepos/workspaces**
- Why it matters: the platform can't correctly characterize its own repository.
- Current state: PARTIALLY COMPLETE (root-manifest only).
- Dependencies: none.
- Risk: low. Complexity: small-medium.

**P2-3. CORS tightening + repository-path guard rails**
- Why it matters: cheap defense-in-depth; the guard-rail half should really ship with P0-2.
- Current state: MISSING.
- Dependencies: none.
- Risk: low. Complexity: small.

### P3 — Future (explicitly not yet)

- **PostgreSQL-backed `TaskStore`** — trigger: real multi-developer or high task-volume use; not before.
- **Additional specialists** (security/API, DevOps, QA, performance, etc.) — trigger: a recurring real task that the current 3 specialists structurally cannot judge (e.g., repeatedly blocked/`NEEDS_USER_DECISION` specifically for a security or infra reason) — never speculative.
- **Phase 26 knowledge ingestion / vector retrieval** — trigger: once P1-3 has produced enough approved lessons that keyword-overlap retrieval is visibly insufficient.
- **`/backend-task` CLI target** — trigger: user demand for a non-browser workflow; the UI already delivers the core value today.

---

## 9. Recommended Next Milestone

See `docs/NEXT_MILESTONE_PROPOSAL.md` for the standalone version of this section.

**Milestone: Trustworthy Real Execution** — combines P0-1 and P0-2 into one causally-ordered package: build the regression safety net first, then use it to safely rework the single riskiest, least-tested code path in the system (`RealClaudeCodeExecutor`) into something that runs in git isolation instead of directly against a developer's live working tree, and prove it by actually running it end-to-end for the first time in this project's history.

This is the highest-leverage next step because every other roadmap item (streaming, memory, conflict detection, additional specialists) either depends on real execution actually working, or is only worth building once real (not mock) task runs start happening safely and repeatedly.

---

## 10. Acceptance Criteria

1. `.github/workflows/ci.yml` (or equivalent) runs `npm test` (both workspaces, 56+ tests) and `npm run build` on every push/PR; the pipeline fails the build on any red test.
2. The existing manual Playwright verification flow (create task → start → SSE-driven completion → screenshot → zero console errors) is committed to the repository as an automated test, runnable headless in CI.
3. `RealClaudeCodeExecutor.implement()` (and, if applicable, `analyze()`/`review()`) no longer operates directly on the caller-supplied repository path's current working tree — it runs against an isolated git worktree or a dedicated branch created for the task.
4. A pre-flight guard rejects or clearly warns on suspicious repository paths (home directory root, filesystem root, a path with no `.git`) before real-mode execution is allowed to proceed.
5. The Task Detail UI shows, for real-mode tasks, where the changes actually live (branch/worktree identifier) — never silently implying the developer's current checkout was modified when it wasn't, or vice versa.
6. At least one full real (`CLAUDE_EXECUTION_MODE=real`) task is run end-to-end against a disposable test repository as part of validating this milestone, and the result is documented — closing the "never exercised end-to-end" gap for the first time.
7. All 56 pre-existing tests remain green throughout; new tests are added for the worktree lifecycle and for `RealClaudeCodeExecutor`'s prompt construction / JSON-extraction / failure paths (currently zero coverage).

**Explicitly out of scope for this milestone:** cancel/retry/resume (P1-1), full token-level streaming of Claude's reasoning (P1-2 covers only "isolated + observable," not full streaming), memory wiring (P1-3), Postgres, additional agents, or any ingestion pipeline.

---

## 11. Testing Strategy

**Well covered today:** routing engine (8 tests across the full Phase 24 matrix), repository inspection (4), reconciliation's non-conflict paths (4), path sanitization/traversal (6), event bus persistence/replay (2), API integration (12), one full mock-mode end-to-end happy path (7). Frontend: component rendering and task-flow behavior for all three pages (13), now running against the zoneless TestBed environment.

**Missing / important gaps:**
- **Real-executor unit tests** — zero coverage of `RealClaudeCodeExecutor`'s prompt assembly, JSON-envelope parsing, or failure handling, with `child_process` mocked. This is the least-tested, highest-risk file in the codebase.
- **Integration test for a real (not mocked) `claude` CLI invocation** against a disposable fixture repo — at least one, run manually or in a gated CI job, not part of every PR (too slow/costly for that) but run before any release that touches execution.
- **Concurrency tests** — no test exercises two tasks running simultaneously, or a double `POST /start` race beyond the single guarded status check.
- **Crash-recovery tests** — none, because the capability doesn't exist yet (see P1-1).
- **Browser/E2E tests** — currently manual only; committing the existing Playwright flow (per the milestone above) closes this.
- **Security-path tests** — path traversal is covered (`paths.test.ts`); repository-path sensibility guard rails are not (because they don't exist yet).

**Recommended future pyramid:** keep the current heavy unit-test base for pure-function orchestrator logic (routing, reconciliation, planning) — it's cheap and already good. Add a thin layer of mocked-executor integration tests for the real execution path. Add exactly one committed browser E2E test per major user flow (not one per component) — enough to catch a broken pipeline, not so much that the suite becomes slow or flaky. Keep actual live-CLI execution tests out of the default CI run; gate them behind an explicit, manually-triggered job.

---

## 12. Security Strategy

The current posture (no auth, wide-open CORS, no sandboxing) is *correct for what this tool is today*: a local, single-developer utility, explicitly scoped that way in the project's own assumptions (`MVP_IMPLEMENTATION_ASSESSMENT.md` §9). The security work that actually matters right now is not "add auth" — it's **making the one operation that can cause real, hard-to-reverse damage (`RealClaudeCodeExecutor.implement()`) safe by construction**: git isolation instead of documentation-only caution, plus a repository-path guard rail. Everything else (CORS tightening, auth) is legitimate but should wait for an actual trigger — a second developer, a networked deployment, or hosted use — rather than being built speculatively now.

---

## 13. Future Agent Expansion Strategy

Do not add a specialist because its domain sounds important. Add one only when a recurring real task is repeatedly blocked, escalated to `NEEDS_USER_DECISION`, or produces a low-confidence reconciliation *specifically because* none of the three current specialists (Python, Node, Database) has the domain judgment to answer it. Concretely:

- **Security/API specialist** — trigger: real tasks involving auth, input validation at a security-review depth, or dependency-vulnerability judgment repeatedly show up as blocking review findings the current specialists flag generically but can't assess properly.
- **DevOps/infra specialist** — trigger: a real task requirement materially involves deployment, CI/CD, or infrastructure-as-code changes — none of the current three specialists' contracts cover this scope at all today.
- **QA/testing specialist** — trigger: only if `runTests()`'s pass/fail signal proves insufficient for tasks with complex test strategy needs (e.g., flaky-test triage, coverage-gap analysis) beyond what backend specialists already produce as part of their own review.
- **Performance specialist** — trigger: a real task's blocking review findings repeatedly concern performance regressions the backend specialists' generic review pass doesn't catch.

Each of these should be validated against real task volume (post P0-2), not added speculatively — this matches the project's own explicit "do not overbuild" instruction.

---

## 14. Memory / Knowledge Evolution

The type model (`global_knowledge` / `project_memory` / `task_history` / `candidate_lesson` / `approved_lesson`, with `scope`, `provenance`, `confidence`, `supersedes`) is already correct and doesn't need redesign. What's missing is entirely the wiring:

1. **Retrieval-in**: `TaskOrchestrator.analyze()` should call `memoryStore.retrieve(question, task.repository)` and pass the results into the specialist prompt as additional context — this is literally `ORCHESTRATOR.md` Responsibility #3, currently skipped.
2. **Promotion-out**: after a task reaches `completed`, give a human a single explicit action ("promote this decision to memory") that calls `memoryStore.add()` with `type: "candidate_lesson"` — never auto-promote without a human step, consistent with the project's evidence-first, no-silent-conflict-resolution posture.
3. **Approval**: a `candidate_lesson` becomes an `approved_lesson` only via an explicit second action, not automatically — this is a deliberate, cheap gate against memory pollution.
4. **Staleness**: `supersedes` already exists in the type; use it when an approved lesson is later approved again with revised content, rather than leaving contradictory lessons both retrievable.

Do **not** build the Phase 26 ingestion/vector pipeline yet — there's no lesson volume to justify it, and the project's own instructions explicitly say not to overbuild this in the MVP. Revisit only once P1-3 has produced enough approved lessons that plain keyword-overlap retrieval visibly misses relevant ones.

---

## 15. 6–12 Month Vision

A developer points the platform at a real repository, flips on real execution with confidence because it runs in isolation and shows its work live, and — over weeks of use — the platform's memory starts surfacing "last time in this repo, the Database Agent recommended X for this kind of migration" without anyone having built a heavyweight knowledge base to get there. Cross-stack tasks get genuine conflict surfacing, not just escalation. The task list is something a developer actually manages (cancel, retry, filter, search) rather than a one-way log. A GitHub Actions badge on the README is green because CI actually runs the suite. None of this requires Kubernetes, a queue, a vector database, or a second specialist beyond what real usage has already proven necessary — the throughline of everything in this roadmap is "close the gap between what's designed and what's proven," not "build more."

---

## 16. Open Questions

1. **What does "isolated" mean for real execution in practice** — a git worktree (fast, same clone, needs a clean working tree to create), a full temp clone (slower, always safe), or a dedicated branch checked out in place (simplest, but still touches the user's single working tree)? This is a real design decision for the milestone, not just an implementation detail — recommend resolving it as the first step of that milestone, informed by how disruptive each option is to a developer's actual local git state.
2. **Who approves a diff before it's kept** — does the milestone ship with an explicit "keep these changes" confirmation step in the UI, or is landing on an isolated branch (which the developer can inspect via normal `git` before merging) sufficient for v1?
3. **Should `runTests()`'s arbitrary command execution get any sandboxing**, given it already runs a repository-supplied script directly via `child_process`? Today's answer ("the developer chose to point the tool at this repository, so they trust it") is reasonable but worth stating explicitly as a decision rather than an oversight.
4. **At what task volume does the JSON-file `TaskStore` actually become a problem** — is there a concrete number (tasks/day, concurrent users) the team wants to use as the Postgres-migration trigger, rather than leaving it as "someday"?
5. **Is a CLI (`/backend-task`) actually wanted**, or was that an artifact of an earlier design phase (Phase 27's stated target) that the UI has since superseded in practice?

---

*This document and `docs/NEXT_MILESTONE_PROPOSAL.md` are the only files created by this review. No source, configuration, or test files were modified.*
