# Phase 28 Implementation Plan — Trustworthy Real Execution

Status: implementation in progress. Written before coding, per Phase 28 instructions.

## 0. Verification of prior claims

Before planning, the key claims from `docs/NEXT_STEPS_ARCHITECTURE_REVIEW.md` were re-checked against the current code and environment:

| Claim | Verified |
|---|---|
| `RealClaudeCodeExecutor` has never been run end-to-end | Confirmed — no test invokes it, `MVP_COMPLETION_REPORT.md` states this explicitly, and no `tasks/` artifact in this repo was ever produced under `executionMode: "real"`. |
| `memoryStore` is instantiated and never called | Re-confirmed via `grep -rn "memoryStore" server/src` — only `container.ts` references it. Out of scope for this phase per instruction §30. |
| No CI exists | Confirmed — no `.github/` directory anywhere in the repo. |
| 56 tests currently pass | Re-run: 43 backend (vitest) + 13 frontend (jest) = 56, all green, immediately before this phase started. |
| `git` and `claude` CLI are available in this environment | Confirmed: git 2.55.0, Claude Code CLI 2.1.236, both on `PATH`. This means the real-mode validation required by §33/§34 is actually achievable in this session, not just a documented aspiration. |
| No Playwright dependency exists in this repo today | Confirmed — the only prior browser verification lived in a session scratchpad, never committed. |
| `Reconciliation.status` can never be `"CONFLICT"` in practice | Confirmed by reading `orchestrator/reconciliation.ts` — out of scope for this phase (P2 item), not touched. |

No correction to the prior review was needed — the implementation proceeds as scoped.

## 1. Non-negotiable design decision: how isolation works

**Git worktrees**, created under the platform's own task workspace (`tasks/<task-id>/workspace/`), never inside the developer's repository and never reusing the developer's own working directory.

- Base revision: the developer repository's current `HEAD` at the moment real execution begins for a task. `git worktree add` operates on committed history only — it does **not** copy the developer's uncommitted working-tree changes into the new worktree. This means uncommitted local changes are automatically excluded from the agent's task scope with zero additional logic, and the developer's actual working tree is never touched, read for mutation, or blocked on. This is the concrete answer to Open Question #1 from the architecture review, and it directly satisfies §7 ("protect existing local changes... do not silently discard, stash, overwrite or reset").
- Branch name: `agent/task-<task-id>` (task IDs are already UUIDs; collision is not a practical concern, and the full ID preserves traceability per §5).
- Workspace path: `<tasksDir>/<task-id>/workspace` — sits alongside the existing artifact directories (`specialist-reports/`, `reviews/`, etc.) for the same task, keeping the artifact-first layout intact.
- Both are created together by one utility, `server/src/execution/gitWorktree.ts`, via `git worktree add -B <branch> <workspacePath> <baseRevision>` run with `cwd` set to the developer's repository and all arguments passed as an array to `execFile` (never a shell string).

## 2. Where isolation plugs into the existing pipeline

`TaskOrchestrator.run()` gains one new step, executed only when `this.executor.mode === "real"`, immediately after specialists are selected (`routing.agents` assigned) and before `analyze()`:

```
inspect → route → [prepareRealExecutionWorkspace] → analyze → reconcile → plan → implement → review → handoff
```

This keeps `MockClaudeCodeExecutor` and every existing mock-mode test path **completely untouched** — the new step is a no-op branch that mock-mode tasks never enter. `analyze()`, `implement()`, `runTests()` and `review()` all then run against `task.executionWorkspace.workspacePath` instead of `task.repository` for real-mode tasks — not just `implement()`. This is a deliberate correction to the milestone brief's framing: `review()` must see the same files `implement()` actually changed, and those changes live only in the worktree, not the original repository. Running `review()` against `task.repository` would silently review unmodified code. `analyze()` also runs there for consistency (it's read-only, so this is not a safety requirement, only a correctness one — otherwise analysis reflects a directory the developer might keep editing mid-task).

If workspace preparation fails (path unsafe, not a git repo, no resolvable `HEAD`, worktree/branch creation error), the task is `block()`-ed with a clear reason — the same terminal-state pattern already used for ambiguous routing and `NEEDS_USER_DECISION` reconciliation. No new terminal status is introduced for this case.

## 3. Repository safety validation

New `server/src/utils/repositorySafety.ts`, invoked once, at the start of `prepareRealExecutionWorkspace`, before any git command runs:

- **Positive checks**: path resolves and exists (reuses `resolveRepositoryPath`), is a directory, contains a `.git` entry (directory or file, to allow worktrees-of-worktrees and submodule-style `.git` files), and `git rev-parse HEAD` succeeds (rejects a repository with zero commits, since there is no base revision to isolate from).
- **Negative checks**: reject the filesystem root (`/`), the resolved path equal to `os.homedir()` itself, common system directories (`/etc`, `/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/var`, `/private` on macOS/Linux), and — explicitly — the platform's own source root (`config` already knows its own repo root via `path.resolve(process.cwd(), "..")`; reject any target path that resolves to or contains that root). This directly prevents the platform from ever pointing real execution at itself.

This check runs **only** when real execution is about to happen (inside `prepareRealExecutionWorkspace`), not at task-creation time for every task — mock-mode tasks (including this repository's own dogfood testing) are unaffected, and a server misconfigured with `CLAUDE_EXECUTION_MODE=real` still lets a developer create/inspect a task before hitting this guard at the point real work would actually begin.

## 4. Process hardening (`RealClaudeCodeExecutor`)

- `runClaudeCli` gains a `taskId` parameter so spawned processes can be tracked and killed.
- Capture stdout, stderr, exit code, and `signal` (needed to distinguish an explicit timeout/kill from an ordinary non-zero exit).
- Track duration (`Date.now()` around the call) and surface it on `ExecutionReport.durationMs`.
- Distinguish a **timeout** (Node's `spawn(..., { timeout })` delivers `SIGTERM` and a null exit code) from an ordinary CLI failure, and say so explicitly in the resulting error message / report `notes`/`assumptions` — never silently reported as a generic failure, and never as success.
- `implement()`'s `changedFiles` is no longer taken from Claude's self-reported JSON — it is now computed from the actual git diff of the worktree after the call completes (`git diff --numstat <baseRevision>`), which is verifiable ground truth rather than a self-report. This is a direct application of the platform's own existing "never claim results that didn't happen" principle to a place it wasn't yet applied.
- After a successful `implement()` with real changes, the worktree's changes are committed on the task branch (`git add -A && git commit`) so the branch is genuinely mergeable/cherry-pickable by the developer afterward — an uncommitted diff cannot be merged.
- `runTests()` also executes inside the workspace path for real-mode tasks.
- `cancel(taskId)`: kills any tracked in-flight child process for that task (`SIGTERM`, escalating to `SIGKILL` after a short grace period if still alive). `MockClaudeCodeExecutor.cancel()` is a no-op (mock calls are synchronous).

## 5. Cancellation

- New terminal `Task.status` value: `"cancelled"`. This is the one addition to the existing state machine, justified because cancellation is a distinct developer-initiated action, not a failure — everything else (timeout, CLI errors) is represented as the existing `"failed"` status with a descriptive `task.error`, exactly as instructed in §9 ("integrate with [the existing model] rather than creating a second competing state machine").
- New route `POST /tasks/:id/cancel`: rejects if the task is already in a terminal state (409), otherwise marks it `cancelled`, persists immediately, calls `executor.cancel(taskId)`, and publishes a new `TASK_CANCELLED` event.
- `TaskOrchestrator.run()` checks the persisted task status at each phase boundary (before every `setStage` call) and stops immediately, without persisting further, if it finds `"cancelled"` — this prevents a concurrently-cancelled task from being silently overwritten back to a running status by orchestration code that started before the cancellation arrived.
- UI: a "Cancel Execution" button on Task Detail while the task is in a non-terminal state.

## 6. Timeout

- Reuses the existing `CLAUDE_TIMEOUT_MS` / `config.claudeTimeoutMs` configuration (already present, default 120s) rather than introducing a second, redundant env var — it already does exactly what §11 asks for (configurable, sensible dev default). What's new is that a timeout is now *detected and labeled* distinctly (§4 above) instead of only ever looking like an opaque non-zero exit.

## 7. Diff / result exposure

`ExecutionReport` gains an optional `diff` field (present only for real-mode tasks with actual changes): base revision, branch, per-file additions/deletions, and a short human-readable summary line (`"3 files changed, 42 insertions(+), 5 deletions(-)"`). The task branch is never merged or applied automatically — the developer inspects and merges it themselves with ordinary `git` commands, since the branch lives in the same repository's ref namespace as their own clone.

## 8. Cleanup policy

- No automatic deletion on success, failure, or cancellation — the workspace is left in place for inspection in all three cases, per §16.
- `GitWorktreeManager.removeWorktree()` is implemented and unit-tested as the explicit, safe cleanup mechanism (`git worktree remove --force` + `git worktree prune` + best-effort branch deletion), but is not wired to any automatic trigger in this phase — it exists so a future maintenance path (manual command or scheduled job) can use it safely. This keeps the phase's scope bounded to what the acceptance criteria actually require ("a safe cleanup mechanism" — not "automatic cleanup on any particular event").

## 9. CI

`.github/workflows/ci.yml`: on push and pull_request, install Node (matching the `engines` field), `npm install` at the root (installs all three workspaces once npm-workspaces are updated to include `e2e/`), `npm run build`, `npm test` (56+ tests across server/web), then a separate job installs Playwright's Chromium browser and runs the committed E2E suite against mock mode. No step requires `CLAUDE_EXECUTION_MODE=real` or any credential.

## 10. Automated browser E2E

New third npm workspace, `e2e/`, using `@playwright/test`. `playwright.config.ts` uses Playwright's `webServer` option to start `npm run dev` from the repo root and wait for `http://localhost:4300`, then tears it down after the run — no manual server orchestration needed in CI. The committed spec automates exactly the flow that has been run manually by hand repeatedly this session: open the dashboard, create a task, start it, wait for SSE-driven completion, assert the final state is visible, assert zero console errors. Runs against the default mock executor.

## 11. Type changes (backend, mirrored by hand in the frontend model per existing convention)

- `TaskStatus`: add `"cancelled"`.
- `EventType`: add `"WORKSPACE_PREPARED"`, `"WORKSPACE_PREPARATION_FAILED"`, `"TASK_CANCELLED"`.
- New `RealExecutionWorkspace` interface (`workspacePath`, `branch`, `baseRevision`, `status`, `createdAt`, optional `error`); `Task.executionWorkspace?: RealExecutionWorkspace`.
- `ExecutionReport`: optional `diff`, optional `durationMs`.

## 12. Testing plan

- Unit tests for `gitWorktree.ts` (branch/workspace creation, base-revision resolution, diff computation, removal) with `child_process` mocked — no real git invocation needed for the unit layer, though a small number of tests run against a real throwaway git repo created in a temp directory for higher confidence on the actual git plumbing (fast, no network, no CLI dependency).
- Unit tests for `repositorySafety.ts` covering every rejection case from §6/§13 of the brief.
- Unit tests for the hardened `RealClaudeCodeExecutor` with `child_process.spawn`/`exec` mocked: argument shape, cwd, timeout/signal detection, cancellation, non-zero exit, malformed JSON.
- Orchestrator tests for the new workspace-preparation step and for cancellation short-circuiting mid-pipeline.
- API tests for `POST /tasks/:id/cancel` (success, 404, 409-from-terminal-state).
- One committed Playwright E2E test (mock mode, CI-runnable).
- One **manual, documented** real-mode validation against a disposable fixture repository, run in this session, with the actual output captured for `docs/PHASE_28_COMPLETION_REPORT.md` — not simulated, not asserted without running it.

## 13. Explicitly out of scope (per instructions §30–31 and to keep this phase bounded)

- Memory-layer wiring.
- New specialist agents.
- Reconciliation `CONFLICT` detection.
- Automatic workspace cleanup triggers.
- Cancellation of an in-flight `runTests()` shell command specifically (timeout still applies to it; only the Claude Code CLI calls get first-class kill tracking in this phase — documented as a known limitation in the completion report).

## 14. Order of work

Following §35 of the brief exactly: CI + E2E scaffold first (safety net), then repository safety, then the worktree manager, then the hardened real executor, then process lifecycle/timeout/cancellation, then diff/result plumbing, then API/UI changes, then failure and concurrency tests, then the real disposable-repository validation, then documentation, then project memory, then the completion report.
