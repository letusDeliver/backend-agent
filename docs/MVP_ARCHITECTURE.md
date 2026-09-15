# MVP Architecture

## System diagram

```
Developer (browser)
   │
   ▼
Angular UI (web/)                          Dashboard · Create Task · Task Detail
   │  REST + SSE
   ▼
Express Orchestrator API (server/)
   │
   ├─ Repository Inspector ──── real filesystem read of the given repo path
   │
   ├─ Routing Engine ────────── Phase 24 cross-stack benchmark matrix
   │
   ├─ Memory Retrieval ───────  MemoryStore.retrieve() -> Context Pack (validated only)
   │
   ├─ Specialist Analysis ───── ClaudeCodeExecutor.analyze() × selected agents (parallel)
   │        uses: claude-code-platform-architecture-v0.1/agents/<agent>/CLAUDE.md
   │        + per-agent-filtered memory context
   │
   ├─ Reconciliation ────────── AGREED / CONFLICT / UNKNOWN / NEEDS_USER_DECISION
   │
   ├─ Implementation Plan ────  files expected to change + validation commands
   │
   ├─ ClaudeCodeExecutor ────── .implement() + .runTests()   [mock | real]
   │
   ├─ Review Loop ────────────  .review() × selected agents, bounded retries
   │
   └─ Final Handoff ─────────── final-handoff.json + final-handoff.md
```

Every task's intermediate state is written to `tasks/<task-id>/`, matching `claude-code-platform-architecture-v0.1/workspaces/TASK-WORKSPACE.md` and named per `protocols/artifact-contracts.json`:

```
tasks/<task-id>/
├── task.json
├── context/
│   └── memory-retrieval.json   (Phase 29 — what memory was retrieved/included/excluded)
├── specialist-reports/
│   ├── specialist-python-backend.json
│   ├── specialist-node-backend.json
│   └── specialist-database.json
├── reconciliation.json
├── implementation-plan.json
├── execution-report.json
├── reviews/
│   └── review-<agent>-attempt-<n>.json
├── events.log.jsonl
├── final-handoff.json
└── final-handoff.md
```

The UI reads these same artifacts back through the API rather than maintaining a separate parallel representation — what you see in the Task Detail screen is what's on disk.

## Why this shape (and not the earlier custom runtime)

Project Memory Phases 0–18 designed and partially scaffolded a full custom agent runtime (Task/AgentRun/ToolCall/ContextManifest/Handoff contracts, a Tool Gateway with a policy engine, a Context Engine, a Model Adapter). **Phase 19 (AD-065 → AD-069) explicitly retires that direction**: Claude Code already provides repository exploration, file edits, test execution and git-aware coding loops, so the platform's differentiated layer is orchestration, specialist engineering intelligence, and governance around Claude Code — not a reimplementation of it. This MVP follows that pivot: there is no Tool Gateway, policy engine or Model Adapter here. The orchestrator calls a narrow `ClaudeCodeExecutor` abstraction instead (see below), and specialist "intelligence" is the repository-local `CLAUDE.md` contracts, not a custom prompt-assembly runtime.

## Task state machine

```
created → inspecting → routing → analyzing → reconciling → planning → implementing → reviewing → completed
                                                                              ↑___________________|
                                                                    (blocking review finding, bounded retries)
```

Terminal states: `completed`, `failed`, `blocked`. A task is `blocked` when: routing cannot confidently select a specialist (ambiguous stack with no named technology), reconciliation reaches `NEEDS_USER_DECISION` or `UNKNOWN`, or the review loop exhausts `MAX_REVIEW_RETRIES` (default 2) with unresolved blocking findings.

## Routing engine

Implements the Phase 24 cross-stack routing benchmark matrix (`server/src/orchestrator/routingEngine.ts`), not just the worked example:

| Scenario | Agents | Escalates? |
|---|---|---|
| Python-only API | Python | No |
| Node-only API | Node | No |
| Python + PostgreSQL | Python + Database | No |
| Node + MongoDB | Node + Database | No |
| Cross-stack migration | Python + Node (+ Database) | Yes |
| Database-only | Database | No |
| Ambiguous stack, no technology named | (none) | Yes |

Two principles enforced in code: (1) a database dependency in the repository is **not** by itself a reason to invoke the Database Agent — the requirement text has to show a material persistence concern (schema, migration, index, transaction, query, etc.); (2) when repository inspection can't resolve a backend language and the requirement doesn't name one, routing returns no agents and flags escalation rather than guessing.

## Claude Code execution layer

`server/src/execution/ClaudeCodeExecutor.ts` defines the abstraction the orchestrator depends on:

```ts
interface ClaudeCodeExecutor {
  readonly mode: "real" | "mock";
  analyze(params): Promise<SpecialistReport>;
  implement(params): Promise<ExecutionReport>;
  runTests(params): Promise<TestRunResult[]>;
  review(params): Promise<ReviewReport>;
}
```

- **`MockClaudeCodeExecutor`** (default) — deterministic, grounded in real repository-inspection evidence where available, but never touches the filesystem and never claims a test ran. Every artifact it produces is tagged `executionMode: "mock"`, and every `assumptions`/`notes` field says so explicitly.
- **`RealClaudeCodeExecutor`** — shells out to the local `claude` CLI in non-interactive print mode (`claude -p ... --output-format json --permission-mode <mode>`), scoped to an **isolated git worktree** (see Phase 28 below), never the repository's own checked-out working tree. `analyze()` and `review()` run in `plan` mode (read-only reasoning); `implement()` runs in `acceptEdits` mode (can modify files, but only inside the worktree). `runTests()` runs the repository's own detected test command directly via `child_process`, independent of the LLM, so test evidence is never something Claude merely claims happened.

Selection is a single config value (`CLAUDE_EXECUTION_MODE`), defaulting to `mock`. This default is deliberate: automatically mutating a real repository as a side effect of a web UI button click is a hard-to-reverse action, so real execution requires an explicit operator opt-in — never a default. The UI never hides which mode produced a given result (`REAL EXECUTION` vs `MOCK / SIMULATED EXECUTION` banner on every task).

## Storage

No PostgreSQL instance is configured in this environment. Rather than introduce infrastructure the MVP doesn't need, task records live in a single JSON file (`data/tasks-index.json`) behind a narrow `TaskStore` interface (`server/src/store/taskStore.ts`):

```ts
interface TaskStore {
  create(task: Task): Promise<Task>;
  update(task: Task): Promise<Task>;
  get(id: string): Promise<Task | null>;
  list(): Promise<Task[]>;
}
```

A future `PostgresTaskStore` (the durable store the project memory ultimately intends, AD-009) can implement this same interface without touching the orchestrator, routes, or UI.

## Memory

Per the explicit instruction not to overbuild memory in the MVP, `server/src/memory/` implements the type distinctions from Project Memory Phase 25 (global knowledge / project memory / task history / candidate lessons / validated lessons) plus a lightweight technology-tag + keyword-overlap `retrieve()` — not a vector/RAG pipeline. Since Phase 29 this is wired into orchestration: memory is retrieved before specialist analysis, a completed task can generate candidate lessons, and only a human-approved lesson ever influences a later task. See "Phase 29 — Memory: First Real Loop" below and `docs/MEMORY_LAYER.md` for the full lifecycle. This is the seam Phase 26's ingestion pipeline would plug into later.

## Events

Server-Sent Events (`GET /api/tasks/:id/events`) backed by an in-memory `EventEmitter` for live subscribers and a persisted `events.log.jsonl` artifact for replay — a client that connects late (or a server restart) can reconstruct full task history from disk, per Project Memory §124.

## Security

- Repository paths are resolved and validated to exist and be a directory before any inspection; a nonexistent or non-directory path is rejected with 400.
- All artifact writes are confined to the task's own workspace directory (`resolveWithinRoot`); a path that tries to escape via `..` is rejected.
- Repository *content* is treated as untrusted evidence (findings, not instructions) — this is a documented boundary, not a runtime sandbox, consistent with the MVP's non-production scope.
- No secrets are ever written to task artifacts or returned in API responses.
- Real execution requires explicit operator configuration (`CLAUDE_EXECUTION_MODE=real`), never triggered implicitly.
- **Since Phase 28**: real execution additionally runs only against an isolated git worktree (never the developer's live working tree — see below) and is preceded by a dedicated repository-safety check (home directory, system directories and the platform's own source tree are all refused).

## Phase 28 — Trustworthy Real Execution

Phase 28 addressed the two largest gaps identified by the architecture review that preceded it (`docs/NEXT_STEPS_ARCHITECTURE_REVIEW.md`): real execution had never been run end-to-end and had no isolation from the developer's working tree, and the whole system had zero CI. Full detail lives in `docs/REAL_EXECUTION.md` and `docs/PHASE_28_COMPLETION_REPORT.md`; summarized here for the architecture record:

- **Git-worktree isolation** (ADR 0001, ADR 0002): every real-mode task gets an isolated worktree (`tasks/<task-id>/workspace/`) on a dedicated branch (`agent/task-<task-id>`), created from the repository's `HEAD`. The developer's working tree and current branch are never read for mutation or written to. `implement()`'s changes are committed onto the task branch and diffed against the base revision using real `git diff` — ground truth, not Claude's self-report. Nothing is ever auto-merged.
- **Repository safety guard** (`server/src/utils/repositorySafety.ts`): rejects unsafe targets (home directory, system directories, the platform's own source tree) before a worktree is ever created.
- **Process hardening**: timeouts are distinguished from ordinary failures and never reported as success; `POST /tasks/:id/cancel` kills in-flight Claude Code processes and the orchestrator checks for cancellation between every pipeline phase.
- **CI + committed E2E** (ADR 0004): `.github/workflows/ci.yml` runs the full test suite and a Playwright browser E2E test (mock executor only) on every push/PR — the safety net this and every future phase now builds behind.
- **Real-mode opt-in unchanged** (ADR 0003): still off by default, still a server-startup environment variable, never a UI toggle.

Test count: 43 → 72 backend tests, +13 frontend (unchanged) = **85 total**, plus a committed E2E test. A real (non-fixture) `claude` CLI validation was run against a disposable repository as part of this phase — see `docs/PHASE_28_COMPLETION_REPORT.md` for the actual output.

Explicitly not addressed by Phase 28 (deferred to later milestones per the architecture review's roadmap): memory-layer wiring, reconciliation's `CONFLICT` detection, automatic workspace cleanup, container/VM-level sandboxing beyond git isolation, and cancellation of an in-flight `runTests()` call specifically.

## Phase 29 — Memory: First Real Loop

Phase 29 wired `MemoryStore` into orchestration for the first time — it had existed since the MVP but nothing referenced it outside `container.ts`. Full detail lives in `docs/MEMORY_LAYER.md` and `docs/PHASE_29_COMPLETION_REPORT.md`; summarized here for the architecture record:

- **Retrieval-in** (`ORCHESTRATOR.md` responsibility #3, previously unimplemented): after routing, before specialist analysis, `buildContextPack()` queries `MemoryStore.retrieve()` — hard-filtered to `validationStatus === "validated"` inside the store itself — and persists the result to `tasks/<id>/context/memory-retrieval.json`.
- **Trust model**: `MemoryItem.validationStatus` distinguishes `validated | candidate | rejected | historical`. Only `validated` items are ever retrievable for specialist context. A memory item that conflicts with the current repository's detected stack (e.g. names a different database) is flagged, never silently trusted — repository evidence always wins.
- **Per-agent filtering**: `memoryForAgent()` keeps a memory item for a specialist only if its technology tags overlap that agent's stack family, or if the item carries no technology tag at all (general guidance reaches every agent).
- **Candidate lesson generation**: a completed task's reconciliation decisions (confidence ≥ 0.6) become `candidate_lesson` items with full provenance (`taskId`/`agent`/`artifact`/`decision`), filtered through a sensitive-content check before ever being persisted. Never auto-promoted.
- **Human approval gate** (`/api/memory/:id/approve|reject`, `PATCH /api/memory/:id`): the only path from candidate to validated memory. Rejected items are kept (never deleted) but permanently excluded from retrieval.
- **Task history stays the existing artifact trail** — deliberately not duplicated into `MemoryStore`, per `ORCHESTRATOR.md`'s own "do not duplicate repository source into memory unnecessarily" rule.

Test count: 72 → 101 backend tests, 13 → 16 frontend tests = **118 total**, plus the unchanged committed E2E test. The most important new test (`memoryLoop.e2e.test.ts`) proves the loop actually closes: Task A completes → candidate generated → approved via the API → Task B's specialist analysis provably receives it.

Explicitly not addressed by Phase 29 (deferred; see `docs/MEMORY_LAYER.md`'s "Known limitations"): vector/semantic retrieval, automatic candidate promotion, automatic project→global scope promotion, `task_history`/`project_memory`/`global_knowledge` auto-writing, reconciliation's `CONFLICT` detection, task retry/resume, new specialist agents.
