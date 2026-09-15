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
- **Lightweight memory interfaces** (global knowledge / project memory / task history / candidate lessons / approved lessons) with working task history and a keyword-overlap retrieval implementation — deliberately not a vector/RAG system, per the explicit instruction not to overbuild this in the MVP.
- **56 automated tests** (43 backend + 13 frontend) including a full Python+PostgreSQL end-to-end happy-path integration test.

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
GET  /stats                          GET /specialists
```

## UI screens

- **Dashboard** — active/completed/failed/blocked counts, specialist availability, recent tasks.
- **Create Task** — requirement, repository path, optional preferred technology/database/constraints.
- **Task Detail** — execution timeline (derived from real task status, backed by an expandable raw SSE activity log), REAL/MOCK execution banner, repository evidence, specialists panel (findings/risks/confidence per agent, "Not required" for unselected agents), reconciliation (decisions/evidence/risks/conflicts), implementation (file list matched against actual changed files, test results, status), reviews (PASS/FAIL, blocking/warning findings, retry note), final handoff (summary grid + `final-handoff.md` viewer).

## Agent workflow

See [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md). Specialist contracts are loaded at runtime from `claude-code-platform-architecture-v0.1/agents/*/CLAUDE.md` — never duplicated into the orchestrator, per that package's own "Do Not" rule.

## Claude Code integration status

**Both modes are real code paths, not one real and one stubbed:**

- `mock` (default) — fully implemented, deterministic, never touches the filesystem, every output explicitly labeled `MOCK / SIMULATED EXECUTION` in both the artifacts and the UI.
- `real` (opt-in via `CLAUDE_EXECUTION_MODE=real`) — fully implemented against the actual `claude` CLI installed in this environment (`claude -p ... --output-format json --permission-mode plan|acceptEdits`), with real test execution via `child_process`. **Not exercised end-to-end in this session** — doing so would have modified a real repository's files as a side effect of an automated build session, which is exactly the kind of hard-to-reverse action this platform's own security guidance (and this environment's operating rules) says to avoid without explicit user sign-off. The code path is implemented, typed, and builds cleanly; a user who explicitly opts in should validate it against a disposable/test repository first.

## Tests executed

```
Backend (vitest):  43 passed  (routing engine × 8, repository inspector × 4, reconciliation × 4,
                                path sanitization × 6, event bus × 2, API integration × 12,
                                end-to-end Python+PostgreSQL happy path × 7)
Frontend (jest):   13 passed  (app shell × 2, dashboard × 3, create-task × 3, task-detail × 5)
Backend build:     tsc -p tsconfig.json — clean
Backend lint:      tsc --noEmit — clean
Frontend build:    ng build — clean (283 kB initial, well under budget)
```

Additionally verified manually, in a browser, via a headless-Chromium Playwright session against the live `npm run dev` stack: dashboard renders, task creation form submits, task detail page live-updates through the full pipeline via real SSE events to a `completed` state with zero browser console errors, screenshots captured at each step.

## Known limitations

- Real Claude Code execution mode is implemented but not exercised end-to-end in this session (see above) — validate it yourself against a disposable repository before relying on it.
- The JSON-file task store is fine for single-developer local use; it is not designed for concurrent multi-writer or multi-machine use. The `TaskStore` interface is the intended swap point for a future PostgreSQL implementation.
- Memory retrieval is keyword-overlap, not semantic/vector search — adequate for the MVP's scope, explicitly not built further per the build instructions.
- No authentication — this is a local, single-developer tool, matching the MVP's explicitly non-production scope.
- The implementation plan's file-path guesses are heuristic (framework-convention-based); `RealClaudeCodeExecutor.implement()` is expected to follow the actual repository's real conventions rather than treat the plan's paths as literal, and the orchestrator's `changedFiles` reconciliation reflects whatever Claude Code actually reports.
- Routing's keyword-based text analysis (for "material persistence concern," cross-stack detection, etc.) is a reasonable heuristic layer, not a language-model judgment — documented as such in `MVP_ARCHITECTURE.md` and covered by the routing engine's test suite, but it can be fooled by unusual phrasing.

## Future improvements

- Swap `JsonFileTaskStore` for a `PostgresTaskStore` behind the existing interface once persistence needs to scale beyond a single developer machine.
- Wire the memory layer's candidate/approved-lesson types to something that actually writes them (e.g., promoting a validated architecture decision after a human approves a completed task).
- Add the Phase 26 knowledge ingestion pipeline for repository documentation/ADRs once the platform has more than one active project to learn from.
- Exercise and harden `RealClaudeCodeExecutor` against a real benchmark repository, per Project Memory Phase 20's evaluation baseline.

## Exact local startup instructions

```bash
npm install
npm run dev
```

Open **http://localhost:4300**.

To run tests: `npm test`. To build: `npm run build`. Full details, environment variables and troubleshooting: [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md).
