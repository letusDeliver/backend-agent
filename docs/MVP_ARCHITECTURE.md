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
   ├─ Specialist Analysis ───── ClaudeCodeExecutor.analyze() × selected agents (parallel)
   │        uses: claude-code-platform-architecture-v0.1/agents/<agent>/CLAUDE.md
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
- **`RealClaudeCodeExecutor`** — shells out to the local `claude` CLI in non-interactive print mode (`claude -p ... --output-format json --permission-mode <mode>`), scoped to the task's repository path. `analyze()` and `review()` run in `plan` mode (read-only reasoning); `implement()` runs in `acceptEdits` mode (can modify files). `runTests()` runs the repository's own detected test command directly via `child_process`, independent of the LLM, so test evidence is never something Claude merely claims happened.

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

Per the explicit instruction not to overbuild memory in the MVP, `server/src/memory/` implements only the type distinctions from Project Memory Phase 25 (global knowledge / project memory / task history / candidate lessons / approved lessons) plus a lightweight keyword-overlap `retrieve()` — not a vector/RAG pipeline. Task history is already real (every task's full artifact trail); the other memory types have working storage and retrieval but nothing yet writes candidate/approved lessons automatically. This is the seam Phase 26's ingestion pipeline would plug into later.

## Events

Server-Sent Events (`GET /api/tasks/:id/events`) backed by an in-memory `EventEmitter` for live subscribers and a persisted `events.log.jsonl` artifact for replay — a client that connects late (or a server restart) can reconstruct full task history from disk, per Project Memory §124.

## Security

- Repository paths are resolved and validated to exist and be a directory before any inspection; a nonexistent or non-directory path is rejected with 400.
- All artifact writes are confined to the task's own workspace directory (`resolveWithinRoot`); a path that tries to escape via `..` is rejected.
- Repository *content* is treated as untrusted evidence (findings, not instructions) — this is a documented boundary, not a runtime sandbox, consistent with the MVP's non-production scope.
- No secrets are ever written to task artifacts or returned in API responses.
- Real execution requires explicit operator configuration (`CLAUDE_EXECUTION_MODE=real`), never triggered implicitly.
