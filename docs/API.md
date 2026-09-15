# Orchestrator API

Base URL: `http://localhost:4400/api` (default port; see `PORT` in [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md)).

All responses are JSON. Errors are `{ "error": { "message": string } }` with an appropriate HTTP status (400 validation, 404 not found, 409 invalid state transition, 500 unexpected).

## `GET /health`

```json
{ "status": "ok", "executionMode": "mock", "time": "2026-09-15T10:00:00.000Z" }
```

## `POST /tasks`

Create a task (does not start orchestration).

Request body:

```json
{
  "title": "Add order creation API",
  "requirement": "Add an order creation API with PostgreSQL persistence...",
  "repository": "/absolute/path/to/repo",
  "preferredTechnology": "FastAPI",
  "preferredDatabase": "PostgreSQL",
  "constraints": "Must preserve the existing public API."
}
```

Only `requirement` and `repository` are required; `title` defaults to a truncated requirement. `repository` must be an existing local directory readable by the server process — validated with a 400 error otherwise.

Response `201`: `{ "task": Task }` with `status: "created"`.

## `GET /tasks`

`{ "tasks": Task[] }`, newest first.

## `GET /tasks/:id`

`{ "task": Task }` or `404`.

## `POST /tasks/:id/start`

Begins asynchronous orchestration (inspect → route → [prepare isolated workspace, real mode only] → analyze → reconcile → plan → implement → review → handoff). Returns `202` immediately with the task transitioning to `inspecting`; poll `GET /tasks/:id` or subscribe to `GET /tasks/:id/events` for progress. `409` if the task is not in the `created` state.

## `POST /tasks/:id/cancel`

Cancels a task that is not yet in a terminal state (`completed`, `failed`, `blocked`, `cancelled`). Marks the task `cancelled` immediately and, for real-mode tasks, kills any in-flight `claude` CLI process. Returns `200` with the updated task, or `409` if it's already terminal, or `404` if unknown. See [REAL_EXECUTION.md](REAL_EXECUTION.md#cancellation).

## `GET /tasks/:id/events`

Server-Sent Events stream. Replays full history on connect, then streams live events. Event `data` is a JSON-encoded `TaskEvent`:

```json
{ "id": "...", "taskId": "...", "type": "REPOSITORY_INSPECTION_COMPLETED", "message": "...", "data": { }, "createdAt": "..." }
```

Event types: `TASK_CREATED`, `REPOSITORY_INSPECTION_STARTED`, `REPOSITORY_INSPECTION_COMPLETED`, `AGENT_SELECTED`, `WORKSPACE_PREPARED`, `WORKSPACE_PREPARATION_FAILED`, `MEMORY_RETRIEVED`, `AGENT_ANALYSIS_STARTED`, `AGENT_ANALYSIS_COMPLETED`, `RECONCILIATION_STARTED`, `RECONCILIATION_COMPLETED`, `IMPLEMENTATION_PLAN_CREATED`, `IMPLEMENTATION_STARTED`, `IMPLEMENTATION_COMPLETED`, `REVIEW_STARTED`, `REVIEW_COMPLETED`, `REVIEW_BLOCKING_ISSUE_FOUND`, `TASK_COMPLETED`, `CANDIDATE_LESSONS_GENERATED`, `TASK_FAILED`, `TASK_BLOCKED`, `TASK_CANCELLED`. `WORKSPACE_PREPARED`/`WORKSPACE_PREPARATION_FAILED` only ever fire for real-mode tasks. `CANDIDATE_LESSONS_GENERATED` only fires for tasks that reach `completed` — it fires with `count: 0` when no reconciliation decision met the confidence bar, which is an expected, not an error, outcome.

## `GET /tasks/:id/agents`

`{ "selectedAgents": AgentType[], "reports": SpecialistReport[] }`

## `GET /tasks/:id/reconciliation`

`{ "reconciliation": Reconciliation | null }`

## `GET /tasks/:id/implementation-plan`

`{ "plan": ImplementationPlan | null }`

## `GET /tasks/:id/execution-report`

`{ "report": ExecutionReport | null }`

## `GET /tasks/:id/reviews`

`{ "reviews": ReviewReport[] }` — latest attempt per agent.

## `GET /tasks/:id/handoff`

`{ "handoff": FinalHandoff | null, "markdown": string | null }`

## `GET /tasks/:id/memory`

`{ "contextPack": ContextPack | null }` — what was retrieved from engineering memory for this task, what was actually included in specialist context, and any conflicts against repository evidence. `null` until the task reaches (or passes) the `analyzing` stage. See [MEMORY_LAYER.md](MEMORY_LAYER.md).

## Memory API

See [MEMORY_LAYER.md](MEMORY_LAYER.md) for the full lifecycle. All routes are under `/api/memory`.

### `GET /memory`

`{ "items": MemoryItem[] }`. Optional query params: `type` (`task_history | project_memory | global_knowledge | candidate_lesson | validated_lesson`), `validationStatus` (`validated | candidate | rejected | historical`), `scope` (a repository path or `global`).

### `GET /memory/candidates`

`{ "items": MemoryItem[] }` — shorthand for `?validationStatus=candidate`.

### `GET /memory/:id`

`{ "item": MemoryItem }` or `404`.

### `POST /memory/:id/approve`

Body: `{ "approvedBy"?: string }` (defaults to `"developer"` — this MVP has no auth system). Turns a candidate into validated memory (`type` becomes `validated_lesson`, `validationStatus` becomes `validated`), stamping `provenance.approvedAt`/`approvedBy`. `409` if already validated.

### `POST /memory/:id/reject`

Marks `validationStatus: "rejected"` and stamps `provenance.rejectedAt`. The item is never deleted — it stays visible for audit but is permanently excluded from retrieval. `409` if already rejected.

### `PATCH /memory/:id`

Body: any of `{ "content"?: string, "technology"?: string[], "taskType"?: string }`. Edits the item and sets `provenance.humanEdited: true`. Works regardless of validation status.

## `GET /stats`

`{ "active": number, "completed": number, "failed": number, "blocked": number, "total": number }`

## `GET /specialists`

`{ "specialists": [{ "agent": "python-backend" | "node-backend" | "database", "label": string, "status": "available" }] }`

## Real-execution-only fields

For real-mode tasks, `Task.executionWorkspace` (`{ workspacePath, branch, baseRevision, status, createdAt, error? }`) and `ExecutionReport.diff` (`{ baseRevision, branch, files: [{ path, additions, deletions }], summary }`) / `ExecutionReport.durationMs` are populated once the corresponding pipeline stage runs. Both are `undefined` for mock-mode tasks. See [REAL_EXECUTION.md](REAL_EXECUTION.md).

---

Full type shapes are defined once in `server/src/types/index.ts` (mirrored by hand in `web/src/app/models/task.model.ts`).
