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
- **UNKNOWN** — a specialist analysis failed or produced no usable output; task is `blocked` rather than proceeding on insufficient evidence.
- **NEEDS_USER_DECISION** — routing flagged a high-impact scenario (e.g. a cross-stack migration); task is `blocked` for a human decision rather than the orchestrator silently picking a side.

This follows `orchestrator/ORCHESTRATOR.md`'s "Do Not" list: the orchestrator does not silently resolve material conflicts.

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

## Final handoff

Every completed task writes `tasks/<task-id>/final-handoff.json` (structured) and `final-handoff.md` (human-readable), summarizing: agents used, files changed, test results, review results, architecture decision count, and warnings — all pulled from the same artifacts the UI reads, never re-derived or re-claimed separately.

Completion also generates candidate engineering lessons from the reconciliation decisions (never for `blocked`/`failed` tasks) — see [MEMORY_LAYER.md](MEMORY_LAYER.md) for the full lifecycle from candidate to human-approved validated memory.
