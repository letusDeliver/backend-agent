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

Begins asynchronous orchestration (inspect → route → analyze → reconcile → plan → implement → review → handoff). Returns `202` immediately with the task transitioning to `inspecting`; poll `GET /tasks/:id` or subscribe to `GET /tasks/:id/events` for progress. `409` if the task is not in the `created` state.

## `GET /tasks/:id/events`

Server-Sent Events stream. Replays full history on connect, then streams live events. Event `data` is a JSON-encoded `TaskEvent`:

```json
{ "id": "...", "taskId": "...", "type": "REPOSITORY_INSPECTION_COMPLETED", "message": "...", "data": { }, "createdAt": "..." }
```

Event types: `TASK_CREATED`, `REPOSITORY_INSPECTION_STARTED`, `REPOSITORY_INSPECTION_COMPLETED`, `AGENT_SELECTED`, `AGENT_ANALYSIS_STARTED`, `AGENT_ANALYSIS_COMPLETED`, `RECONCILIATION_STARTED`, `RECONCILIATION_COMPLETED`, `IMPLEMENTATION_PLAN_CREATED`, `IMPLEMENTATION_STARTED`, `IMPLEMENTATION_COMPLETED`, `REVIEW_STARTED`, `REVIEW_COMPLETED`, `REVIEW_BLOCKING_ISSUE_FOUND`, `TASK_COMPLETED`, `TASK_FAILED`, `TASK_BLOCKED`.

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

## `GET /stats`

`{ "active": number, "completed": number, "failed": number, "blocked": number, "total": number }`

## `GET /specialists`

`{ "specialists": [{ "agent": "python-backend" | "node-backend" | "database", "label": string, "status": "available" }] }`

---

Full type shapes are defined once in `server/src/types/index.ts` (mirrored by hand in `web/src/app/models/task.model.ts`).
