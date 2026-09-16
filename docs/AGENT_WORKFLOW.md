# Agent Workflow

## Specialist contracts

The orchestrator never duplicates specialist instructions inline — it loads them at runtime from the repository-local contracts (`server/src/agents/specialistContracts.ts`):

- `claude-code-platform-architecture-v0.1/agents/python-backend/CLAUDE.md`
- `claude-code-platform-architecture-v0.1/agents/node-backend/CLAUDE.md`
- `claude-code-platform-architecture-v0.1/agents/database/CLAUDE.md`

This mirrors `orchestrator/ORCHESTRATOR.md`'s explicit rule: "Do not copy their full instructions into the orchestrator. Pass task-specific context and the relevant artifact."

## Routing

See [MVP_ARCHITECTURE.md](MVP_ARCHITECTURE.md#routing-engine) for the full matrix. In short: the repository is inspected first (language, framework, database, test commands actually detected from the filesystem — never assumed from the requirement text alone), then the routing engine picks the minimum specialist set for the requirement's *engineering responsibility*, not just its named technology.

## Memory retrieval → specialist analysis

Before specialists analyze, the orchestrator retrieves relevant **validated** engineering memory (`buildContextPack()` — see [MEMORY_LAYER.md](MEMORY_LAYER.md)) and filters it per specialist, so a Postgres-specific lesson reaches the Database agent, not a Node-only analysis call. Only human-approved memory is ever eligible — a candidate lesson can never reach this step. Current repository evidence always takes precedence over memory if the two conflict; the conflict is flagged, never silently resolved.

## Specialist analysis → reconciliation

Selected specialists analyze in parallel (`ClaudeCodeExecutor.analyze()`), each returning a `SpecialistReport` (recommendation, findings with evidence, risks, assumptions, confidence) informed by that filtered memory context. The orchestrator then reconciles them into one of:

- **AGREED** — proceed to planning.
- **CONFLICT** — a deterministic, keyword-based comparison (category → subject → polarity — no LLM call) found two specialists making genuinely incompatible recommendations about the same decision, or a recommendation that contradicts detected repository evidence. An unresolved *material* conflict blocks the task until a developer resolves it via `POST /tasks/:id/reconciliation/conflicts/:conflictId/resolve`; a non-material one is surfaced but doesn't block. See [RECONCILIATION_CONFLICTS.md](RECONCILIATION_CONFLICTS.md) for the full detection model.
- **UNKNOWN** — a specialist analysis failed or produced no usable output; task is `blocked` rather than proceeding on insufficient evidence.
- **NEEDS_USER_DECISION** — routing flagged a high-impact scenario (e.g. a cross-stack migration); task is `blocked` for a human decision rather than the orchestrator silently picking a side.

This follows `orchestrator/ORCHESTRATOR.md`'s "Do Not" list: the orchestrator does not silently resolve material conflicts — different wording alone is never treated as a conflict, but a genuine contradiction is never discarded either.

## Implementation plan → execution

The orchestrator (not Claude Code) builds the reconciled `implementation-plan.json` — a best-effort file list plus the repository's real validation commands (test/lint/typecheck, only the ones actually detected). Claude Code then executes that reconciled plan rather than independently inventing cross-specialist architecture (Project Memory AD-082).

In real mode, `execution-report.json`'s `changedFiles` and `diff` are computed from an actual `git diff` of the isolated worktree after Claude Code's changes are committed onto the task branch — not taken from Claude's own self-reported JSON. If the CLI's response claims a file changed that the diff doesn't show, the diff wins.

## Execution modes

| Mode | How it runs | Can modify your repo? | Default? |
|---|---|---|---|
| `mock` | Deterministic, repository-evidence-grounded synthetic output. | Never. | Yes |
| `real` | Shells out to the local `claude` CLI (`claude -p ... --permission-mode plan\|acceptEdits`), scoped to an isolated git worktree on a dedicated branch created from the task's repository — never the repository's own checked-out working tree. `runTests()` runs the repository's real test command directly, inside that same worktree. | Only the isolated worktree/branch — your checked-out working tree is never touched. | No — opt in via `CLAUDE_EXECUTION_MODE=real`. |

The UI always labels which mode produced a given task's artifacts (`REAL EXECUTION` vs `MOCK / SIMULATED EXECUTION`) — this is never hidden or ambiguous, per the platform's evidence-first principle ("never claim execution results unless they actually occurred"). See [REAL_EXECUTION.md](REAL_EXECUTION.md) for the full isolation, safety, timeout and cancellation model.

## Review loop

After implementation, each selected specialist reviews the result from its own domain (`skills/review-routing.md`): the backend specialist reviews application behavior, the database specialist reviews persistence when applicable. A `blocking` finding sends the task back to `implementing` for a corrective pass; `warning` findings are disclosed in the final handoff but don't block completion. Bounded by `MAX_REVIEW_RETRIES` (default 2) — after that, the task becomes `blocked` rather than looping indefinitely.

If two specialists' blocking findings are themselves in material conflict (the same category/subject/polarity check reconciliation uses), the orchestrator doesn't attempt a corrective pass that can't satisfy both — it appends the conflict to the task's reconciliation record and blocks immediately, resolved through the same conflict-resolution endpoint described above.

## Retry — restart from inspection

A task that reaches `failed`, `blocked` (for any reason, including a Phase 30 conflict), or
`cancelled` is never a dead end. `POST /tasks/:id/retry` restarts it from **repository
inspection** — not a resume of the failed stage. Routing, memory retrieval, specialist analysis,
reconciliation, planning, implementation and review all run again exactly as they would for a
brand-new task, so a fix the developer made to the repository between attempts is picked up
automatically. `Task.attempt` increments (starts at 1); the prior attempt's specialist reports,
reconciliation, plan, execution report and reviews are archived to
`tasks/<id>/attempts/<n>/` and stay readable, unmodified, via `GET
/tasks/:id/attempts/:attempt/...` — never deleted, never duplicated onto the live `Task` record.
`task.json` and `events.log.jsonl` are never archived: the event log is one continuous history
across every attempt, with a `TASK_RETRIED` event marking each boundary.

This is a deliberately different workflow from **conflict resolution**
(`POST /tasks/:id/reconciliation/conflicts/:conflictId/resolve`, see above): resolving a conflict
*preserves* the current reconciliation and continues from planning; retrying *discards* the
current attempt's progress and starts over. For a conflict-blocked task the UI offers both —
resolution stays the primary, narrower path for the case it was built for, but a developer may
legitimately prefer to just start over, so retry remains available as a fallback for every
`blocked` task, not only conflict ones.

Real-mode safety: retry re-runs `prepareRealExecutionWorkspace()` exactly like a fresh task does,
and `GitWorktreeManager.prepare()` already force-recreates the worktree/branch from the
repository's current `HEAD` before any implementation call — so a retried real-mode attempt is
never at risk of Claude Code running against a stale worktree carrying a prior attempt's
uncommitted or committed changes. See `docs/adr/0007-retry-restarts-from-inspection.md`.

## Workspace cleanup — an explicit, separate action from retry

A real-mode task's isolated git worktree is never automatically deleted, by retry or anything
else. `POST /tasks/:id/cleanup-workspace` (Phase 32) is a distinct, always-manual action a
developer can take once a task is terminal (`completed`/`failed`/`cancelled`) and they're done
with that workspace — it removes the worktree and its task branch via the same tested primitive
Phase 28 already introduced (`GitWorktreeManager.remove()`), while leaving every durable artifact
(specialist reports, reconciliation, plan, execution report, reviews, final handoff, archived
attempt history) untouched, since those live in `tasks/<id>/` alongside — not inside — the
worktree. It is never offered for a `blocked` task: Phase 30's conflict-resolution resume path
reuses the exact same workspace, so cleanup is refused server-side while a task is `blocked`, not
merely hidden in the UI. See `docs/REAL_EXECUTION.md#cleanup` and
`docs/adr/0008-manual-workspace-cleanup.md`.

**Startup crash recovery**: if the orchestrator process dies mid-pipeline, a task can be left
stuck in a non-terminal, non-`created` status forever with no process left to finish it. Before
the server starts accepting requests, a startup sweep (`recoverOrphanedTasks()`) finds any task in
such a state, transitions it to `failed` with an error naming the stage it was interrupted at, and
appends a `TASK_FAILED` event — making the failure visible and retryable rather than a silent
stall. A task resting in `created` (never started) or already in a terminal status is left
untouched.

## Final handoff

Every completed task writes `tasks/<task-id>/final-handoff.json` (structured) and `final-handoff.md` (human-readable), summarizing: agents used, files changed, test results, review results, architecture decision count, and warnings — all pulled from the same artifacts the UI reads, never re-derived or re-claimed separately.

Completion also generates candidate engineering lessons from the reconciliation decisions (never for `blocked`/`failed` tasks) — see [MEMORY_LAYER.md](MEMORY_LAYER.md) for the full lifecycle from candidate to human-approved validated memory.
