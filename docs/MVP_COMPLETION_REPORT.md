# MVP Completion Report

## What was implemented

A runnable, end-to-end vertical slice of the Backend Engineering Agent Platform, built from a greenfield repository (only the two source documents existed beforehand):

- **Orchestrator API** — Express + TypeScript, running the full pipeline (inspect → route → analyze → reconcile → plan → implement → review → handoff) asynchronously per task, with SSE progress streaming.
- **Angular UI** — standalone components, three screens (Dashboard, Create Task, Task Detail) with a live execution timeline driven by real Server-Sent Events.
- **Routing engine** encoding the Phase 24 cross-stack benchmark matrix (not just the worked example), including repository-first handling for ambiguous stacks and a "material persistence concern, not just an incidental dependency" rule for the Database Agent.
- **Real repository inspection** — reads actual `package.json` / `requirements.txt` / `pyproject.toml` / `setup.py` files to detect language, framework, database and test/lint/typecheck commands. Never assumes stack from the requirement text alone.
- **Claude Code execution layer** — a `ClaudeCodeExecutor` abstraction with a default `MockClaudeCodeExecutor` (deterministic, evidence-grounded, filesystem-untouched, clearly labeled) and an opt-in `RealClaudeCodeExecutor` that shells out to the local `claude` CLI in non-interactive print mode and runs real test commands via `child_process`.
- **Artifact-first task workspaces** at `tasks/<task-id>/`, matching the architecture package's `protocols/artifact-contracts.json` exactly, readable both from disk and through the API.
- **Review loop** with bounded corrective retries (default 2) before a task is marked `blocked`.
- **Engineering memory, wired into orchestration since Phase 29** (global knowledge / project memory / task history / candidate lessons / validated lessons) with technology-tag + keyword-overlap retrieval — deliberately not a vector/RAG system. Memory is retrieved before every specialist analysis, a completed task can generate candidate lessons from its own reconciliation decisions, and only a human-approved lesson ever influences a later task. See `docs/MEMORY_LAYER.md`.
- **118 automated tests** (101 backend + 16 frontend) including a full Python+PostgreSQL end-to-end happy-path integration test and an end-to-end memory-loop test proving candidate → approval → retrieval actually closes.

## Architecture

See [MVP_ARCHITECTURE.md](MVP_ARCHITECTURE.md) for the full system diagram, task state machine, routing matrix, execution-mode design and security boundaries. See [MVP_IMPLEMENTATION_ASSESSMENT.md](MVP_IMPLEMENTATION_ASSESSMENT.md) for how this was derived from the two source documents, including the identified conflict (pre-pivot Python/FastAPI control-plane decision vs. this session's explicit Node/Express/Angular instruction) and its resolution.

## Routes

All under `/api`; see [API.md](API.md) for full request/response shapes.

```
GET  /health
POST /tasks                          GET /tasks                    GET /tasks/:id
POST /tasks/:id/start                GET /tasks/:id/events (SSE)
GET  /tasks/:id/agents               GET /tasks/:id/reconciliation
GET  /tasks/:id/implementation-plan  GET /tasks/:id/execution-report
GET  /tasks/:id/reviews              GET /tasks/:id/handoff
GET  /tasks/:id/memory               GET /stats
GET  /specialists
GET  /memory  ·  GET /memory/candidates  ·  GET /memory/:id
POST /memory/:id/approve  ·  POST /memory/:id/reject  ·  PATCH /memory/:id
```

## UI screens

- **Dashboard** — active/completed/failed/blocked counts, specialist availability, recent tasks.
- **Create Task** — requirement, repository path, optional preferred technology/database/constraints.
- **Task Detail** — execution timeline (derived from real task status, backed by an expandable raw SSE activity log), REAL/MOCK execution banner, repository evidence, memory panel (retrieved/included/excluded counts, conflicts, why each item was included), specialists panel (findings/risks/confidence per agent, "Not required" for unselected agents), reconciliation (decisions/evidence/risks/conflicts), implementation (file list matched against actual changed files, test results, status), reviews (PASS/FAIL, blocking/warning findings, retry note), final handoff (summary grid + `final-handoff.md` viewer).
- **Memory** — overview counts (validated/candidate/rejected), candidate lesson review (approve/edit/reject with provenance back to the source task), validated memory list.

## Agent workflow

See [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md). Specialist contracts are loaded at runtime from `claude-code-platform-architecture-v0.1/agents/*/CLAUDE.md` — never duplicated into the orchestrator, per that package's own "Do Not" rule.

## Claude Code integration status

**Both modes are real code paths, not one real and one stubbed:**

- `mock` (default) — fully implemented, deterministic, never touches the filesystem, every output explicitly labeled `MOCK / SIMULATED EXECUTION` in both the artifacts and the UI.
- `real` (opt-in via `CLAUDE_EXECUTION_MODE=real`) — fully implemented against the actual `claude` CLI installed in this environment (`claude -p ... --output-format json --permission-mode plan|acceptEdits`), with real test execution via `child_process`. As of Phase 28, execution runs against an isolated git worktree/branch rather than the caller's live repository, and **has been exercised end-to-end** — against a disposable repository created specifically for that purpose, never against a repository whose history mattered — with the full real output documented in `docs/PHASE_28_COMPLETION_REPORT.md`. A user opting into real mode should still validate it against their own disposable/test repository first before pointing it at anything they care about.

## Tests executed

```
Backend (vitest):  101 passed (routing engine × 8, repository inspector × 4, reconciliation × 4,
                                path sanitization × 6, event bus × 2, API integration × 15,
                                end-to-end Python+PostgreSQL happy path × 7, repository safety × 7,
                                git worktree isolation × 9, real executor unit (mocked) × 4,
                                real execution integration (fixture CLI) × 2, timeout × 1, cancel × 3,
                                memory store retrieval/CRUD × 7, context pack × 5, candidate
                                lessons × 8, memory API × 7, end-to-end memory loop × 2)
Frontend (jest):    16 passed  (app shell × 2, dashboard × 3, create-task × 3, task-detail × 5,
                                memory × 3)
E2E (playwright):    1 passed  (dashboard → create task → live SSE completion, mock executor, headless)
Backend build:     tsc -p tsconfig.json — clean
Backend lint:      tsc --noEmit — clean
Frontend build:    ng build — clean (270 kB initial, well under budget)
CI:                .github/workflows/ci.yml runs all of the above on every push/PR (added Phase 28)
```

Additionally verified manually, in a browser, via a headless-Chromium Playwright session against the live `npm run dev` stack: dashboard renders, task creation form submits, task detail page live-updates through the full pipeline via real SSE events to a `completed` state with zero browser console errors, screenshots captured at each step. Phase 28 additionally ran one full task through **real** (non-mock) Claude Code execution against a disposable repository — see `docs/PHASE_28_COMPLETION_REPORT.md` for the actual output, including the isolated branch's real diff.

## Known limitations

- ~~Real Claude Code execution mode is implemented but not exercised end-to-end~~ — **resolved in Phase 28**: real execution now runs in an isolated git worktree and has been exercised end-to-end against a disposable repository, with the actual output documented in `docs/PHASE_28_COMPLETION_REPORT.md`.
- The JSON-file task store is fine for single-developer local use; it is not designed for concurrent multi-writer or multi-machine use. The `TaskStore` interface is the intended swap point for a future PostgreSQL implementation.
- ~~Memory retrieval is keyword-overlap and entirely unwired into the orchestration pipeline~~ — **resolved in Phase 29**: memory is now retrieved before every specialist analysis, gated by a human-approval workflow. Retrieval itself is still technology-tag + keyword-overlap, not semantic/vector search — deliberately, per this phase's explicit scope (see `docs/MEMORY_LAYER.md`). `task_history`/`project_memory`/`global_knowledge` are still not auto-written into the memory store (task history is covered by the existing artifact trail instead).
- No authentication — this is a local, single-developer tool, matching the MVP's explicitly non-production scope.
- The implementation plan's file-path guesses are heuristic (framework-convention-based); `RealClaudeCodeExecutor.implement()` is expected to follow the actual repository's real conventions rather than treat the plan's paths as literal. Since Phase 28, `changedFiles`/`diff` reflect a real `git diff` of the isolated worktree, not Claude's self-report — but the *plan's* suggested file list is still just a guess and commonly won't match what actually changed (this is expected, not a bug).
- Routing's keyword-based text analysis (for "material persistence concern," cross-stack detection, etc.) is a reasonable heuristic layer, not a language-model judgment — documented as such in `MVP_ARCHITECTURE.md` and covered by the routing engine's test suite, but it can be fooled by unusual phrasing.
- Reconciliation's `CONFLICT` status is defined in the type system but no code path currently assigns it — two specialists materially disagreeing isn't yet detected as distinct from one of them failing (tracked as a P2 roadmap item).
- Real-execution cancellation is fully wired for `claude` CLI calls but not for an in-flight `runTests()` shell command specifically (see `docs/REAL_EXECUTION.md`).
- No CI existed before Phase 28; CI now runs the full suite + a browser E2E test on every push, but real-CLI validation (as opposed to the fixture-CLI-backed automated tests) remains a manual, documented step, not part of the automated pipeline (see ADR 0004).

## Future improvements

- Swap `JsonFileTaskStore` for a `PostgresTaskStore` behind the existing interface once persistence needs to scale beyond a single developer machine.
- ~~Wire the memory layer's candidate/approved-lesson types to something that actually writes them~~ — **done in Phase 29**.
- Add semantic/vector retrieval behind the existing `MemoryStore.retrieve()` interface once keyword+tag matching proves insufficient in practice.
- Add the Phase 26 knowledge ingestion pipeline for repository documentation/ADRs once the platform has more than one active project to learn from.
- Detect real cross-specialist conflicts in reconciliation instead of only escalation/failure-triggered blocking.
- Add cancel/retry/resume for the full task lifecycle (today cancellation exists, but `blocked`/`failed` tasks are still dead ends).

## Exact local startup instructions

```bash
npm install
npm run dev
```

Open **http://localhost:4300**.

To run tests: `npm test`. To build: `npm run build`. Full details, environment variables and troubleshooting: [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md).
