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

## `POST /tasks/:id/retry`

Restarts a `failed`, `blocked` or `cancelled` task from repository inspection — not a resume of
the failed stage; see [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md#retry--restart-from-inspection).
Archives the current attempt's artifacts (everything under `GET /tasks/:id/attempts/:attempt/...`
below) before resetting the task, increments `Task.attempt`, and returns the task with
`status: "created"`. Fires the pipeline asynchronously, the same way `POST /tasks/:id/start` does
— poll `GET /tasks/:id` or subscribe to `GET /tasks/:id/events` for progress. `404` if the task
doesn't exist, `409` if it is not currently `failed`, `blocked` or `cancelled` (this also covers a
retry racing a still-in-flight task), `202` otherwise.

## `POST /tasks/:id/cleanup-workspace`

Removes a terminal, non-blocked real-mode task's isolated git worktree and task branch (Phase 32
— see [REAL_EXECUTION.md](REAL_EXECUTION.md#cleanup) and
[adr/0008-manual-workspace-cleanup.md](adr/0008-manual-workspace-cleanup.md)). No request body;
every path/branch value is derived server-side from `Task.executionWorkspace` — the client can
never supply a filesystem path. `200` with the updated task on success
(`executionWorkspace.cleanupStatus: "cleaned"`, `cleanedAt` set). `404` if the task doesn't exist.
`409` if there's nothing eligible to clean up: a mock-mode task, a task whose workspace was never
prepared or whose preparation itself failed, a task that's still in-flight, a task that's
`blocked` (conflict resolution needs this exact workspace to still exist), or a workspace that's
already `cleaned`. `500` if the underlying git removal genuinely fails — in that case
`executionWorkspace.cleanupStatus` becomes `"cleanup_failed"` with `cleanupError` set, but
`Task.status`/`Task.error` are never touched; the cleanup can simply be retried. Never automatic —
this is only ever called explicitly by a developer.

## `GET /tasks/:id/attempts`

`{ "attempts": number[] }` — archived attempt numbers, ascending. Empty until the task has been
retried at least once.

## `GET /tasks/:id/attempts/:attempt/agents`

`{ "reports": SpecialistReport[] }` — that attempt's archived specialist reports.

## `GET /tasks/:id/attempts/:attempt/reconciliation`

`{ "reconciliation": Reconciliation | null }` — that attempt's archived reconciliation, unmodified
since it was archived (including any conflicts and their resolutions as they stood at the time).

## `GET /tasks/:id/attempts/:attempt/implementation-plan`

`{ "plan": ImplementationPlan | null }`

## `GET /tasks/:id/attempts/:attempt/execution-report`

`{ "report": ExecutionReport | null }`

## `GET /tasks/:id/attempts/:attempt/reviews`

`{ "reviews": ReviewReport[] }` — latest attempt-loop review per agent, from that archived attempt.

## `GET /tasks/:id/attempts/:attempt/handoff`

`{ "handoff": FinalHandoff | null, "markdown": string | null }` — only populated if that attempt
actually reached `completed` before being retried (uncommon, but possible if a developer retries a
task that already succeeded).

All `attempts/:attempt/...` routes are read-only, `404` for an unknown task, `400` for a
non-integer/non-positive `:attempt`, and return `null`/an empty array (not `404`) for an attempt
number that produced no artifact of that kind — the same "missing artifact is `null`, not an
error" convention the live per-artifact GETs above already use.

## `GET /tasks/:id/events`

Server-Sent Events stream. Replays full history on connect, then streams live events. Event `data` is a JSON-encoded `TaskEvent`:

```json
{ "id": "...", "taskId": "...", "type": "REPOSITORY_INSPECTION_COMPLETED", "message": "...", "data": { }, "createdAt": "..." }
```

Event types: `TASK_CREATED`, `REPOSITORY_INSPECTION_STARTED`, `REPOSITORY_INSPECTION_COMPLETED`, `AGENT_SELECTED`, `WORKSPACE_PREPARED`, `WORKSPACE_PREPARATION_FAILED`, `MEMORY_RETRIEVED`, `AGENT_ANALYSIS_STARTED`, `AGENT_ANALYSIS_COMPLETED`, `RECONCILIATION_STARTED`, `RECONCILIATION_COMPLETED`, `IMPLEMENTATION_PLAN_CREATED`, `IMPLEMENTATION_STARTED`, `IMPLEMENTATION_COMPLETED`, `REVIEW_STARTED`, `REVIEW_COMPLETED`, `REVIEW_BLOCKING_ISSUE_FOUND`, `TASK_COMPLETED`, `CANDIDATE_LESSONS_GENERATED`, `TASK_FAILED`, `TASK_BLOCKED`, `TASK_CANCELLED`, `TASK_RETRIED`, `WORKSPACE_CLEANED`, `WORKSPACE_CLEANUP_FAILED`. `WORKSPACE_PREPARED`/`WORKSPACE_PREPARATION_FAILED` only ever fire for real-mode tasks. `CANDIDATE_LESSONS_GENERATED` only fires for tasks that reach `completed` — it fires with `count: 0` when no reconciliation decision met the confidence bar, which is an expected, not an error, outcome. `TASK_RETRIED` fires once per `POST /tasks/:id/retry` call, immediately followed by the same sequence a fresh task produces (`REPOSITORY_INSPECTION_STARTED`, ...) — the event log is one continuous history across every attempt, never truncated or replaced. A `TASK_FAILED` event from the startup crash-recovery sweep (see [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md#retry--restart-from-inspection)) looks identical to any other `TASK_FAILED` event except its message names the stage the task was interrupted at. `WORKSPACE_CLEANED`/`WORKSPACE_CLEANUP_FAILED` fire once per `POST /tasks/:id/cleanup-workspace` call (Phase 32) and never fire automatically. `IMPLEMENTATION_COMPLETED`'s `data.diff` (when present) is metadata only — `baseRevision`, `branch`, `files`, `summary`, `truncated` — and deliberately never includes the patch text itself (Phase 33): the event log is not the patch's storage location, `GET /tasks/:id/execution-report` is, and repeating a potentially large patch into every event/every reader of the event log would be pure bloat with no current consumer.

## `GET /tasks/:id/agents`

`{ "selectedAgents": AgentType[], "reports": SpecialistReport[] }`

## `GET /tasks/:id/reconciliation`

`{ "reconciliation": Reconciliation | null }`. `Reconciliation.conflicts` is a structured `ReconciliationConflict[]` (category, subject, participants with their recommendation/evidence/polarity, materiality, resolution) — not free text. See [RECONCILIATION_CONFLICTS.md](RECONCILIATION_CONFLICTS.md) for the full shape and detection model.

### `POST /tasks/:id/reconciliation/conflicts/:conflictId/resolve`

Body: `{ "resolution": string, "reason"?: string, "resolvedBy"?: string }`. `resolution` is required and non-empty. Persists the resolution with a server-set `resolvedAt`; the client can never write any other field of the conflict. `404` if the task or conflict doesn't exist, `409` if the conflict is already resolved, `400` if `resolution` is missing/empty. Response: `{ "reconciliation": Reconciliation, "resumed": boolean }` — `resumed` is `true` when this resolution cleared the last unresolved material conflict on a `blocked` task, in which case the orchestrator resumes asynchronously from the planning stage (poll `GET /tasks/:id` or the event stream as with `POST /tasks/:id/start`). As with `POST /memory/:id/approve`, `resolvedBy` is free text — this MVP has no auth system.

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

For real-mode tasks, `Task.executionWorkspace` (`{ workspacePath, branch, baseRevision, status, createdAt, error?, cleanupStatus?, cleanedAt?, cleanupError? }`) and `ExecutionReport.diff` / `ExecutionReport.durationMs` are populated once the corresponding pipeline stage runs. Both are `undefined` for mock-mode tasks. `cleanupStatus` is absent/`"ready"` until a developer calls `POST /tasks/:id/cleanup-workspace` (Phase 32) — absence is equivalent to `"ready"`, not a migration gap.

`ExecutionReport.diff` (Phase 33): `{ baseRevision, branch, files: [{ path, additions, deletions }], summary, patch, truncated, totalPatchChars }`. `patch` is the actual ground-truth unified-diff text (`git diff`), bounded to `MAX_DIFF_PATCH_CHARS` (default 200,000 characters). `truncated` is `true` when the real patch exceeded that bound — `patch` is then cut (preferring a whole-file boundary) with an explicit truncation marker appended, never silently. `totalPatchChars` always reflects the full, untruncated patch length regardless of `truncated`, so a caller can show "showing X of Y". This same bounded patch is what the specialist reviewer's prompt actually receives. `FinalHandoff.diffTruncated` (optional; absent for handoffs written before this phase) mirrors `ExecutionReport.diff.truncated` at completion time. See [REAL_EXECUTION.md](REAL_EXECUTION.md).

---

Full type shapes are defined once in `server/src/types/index.ts` (mirrored by hand in `web/src/app/models/task.model.ts`).
