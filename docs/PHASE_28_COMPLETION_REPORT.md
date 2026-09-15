# Phase 28 Completion Report — Trustworthy Real Execution

Status: **Complete**. All work described in `docs/PHASE_28_IMPLEMENTATION_PLAN.md` was implemented, tested, and — for the one part that can't be proven by unit tests alone — actually run against the real `claude` CLI.

## Summary

Real Claude Code execution no longer runs directly against a developer's live repository. It now runs against an isolated git worktree on a dedicated branch, with a repository-safety guard, distinguishable timeouts, mid-run cancellation, and a ground-truth (`git diff`-derived, not self-reported) record of what actually changed. A CI pipeline and a committed browser E2E test now protect the whole system on every push. 29 new backend tests were added (43 → 72), and — for the first time in this project's history — real execution was actually run end-to-end against a disposable repository, not just implemented and left unproven.

## Architecture

```
Developer Repository (untouched)
        │  read HEAD only
        ▼
Repository safety guard  →  reject: home dir, system dirs, platform's own source
        │
        ▼
git worktree add -B agent/task-<id>  tasks/<id>/workspace  <base-revision>
        │
        ▼
Claude Code (analyze → implement → review), all scoped to the worktree
        │
        ▼
implement()'s changes committed onto the task branch
        │
        ▼
git diff <base>..<branch>  →  ground-truth changedFiles/diff on ExecutionReport
        │
        ▼
Task Detail UI shows: isolation status, base revision, branch, diff summary, duration
        │
        ▼
Developer reviews/merges the branch with their own git tooling — never automatic
```

Mock execution is untouched — the isolation step only runs when `executor.mode === "real"`.

## Safety

- **Working tree protection**: `git worktree add` operates on committed history only, so uncommitted changes in the developer's repository are never read, copied, or touched, and the developer's checked-out branch is never switched or modified. Verified directly in the real validation below (`git status --porcelain` on the source repository stayed empty throughout, and its current branch stayed `main`).
- **Repository-safety guard** (`server/src/utils/repositorySafety.ts`): before a worktree is created, the target is checked against the developer's home directory, filesystem root, well-known system directories, and — specifically — the platform's own source tree (in either direction: target inside platform, or platform inside target). A real integration test proves this by pointing real execution at the platform's own `server/` directory and confirming it's rejected with a clear `blocked` reason.
- **Never silently degraded**: if no isolated workspace is ready, `RealClaudeCodeExecutor` refuses to run (returns a clearly-labeled failed report) rather than ever falling back to the original repository path.
- **Timeouts labeled, never hidden**: a hung `claude` CLI call is terminated after `CLAUDE_TIMEOUT_MS` (default 120s) and the resulting report says so explicitly — never presented as a successful result.
- **Cancellation**: `POST /tasks/:id/cancel` kills the in-flight CLI process and the orchestrator stops making further progress at the next phase checkpoint.

## Git isolation

- Workspace: `tasks/<task-id>/workspace/`, a real linked git worktree.
- Branch: `agent/task-<task-id>`, created from the repository's `HEAD` at task start.
- `implement()`'s changes are committed onto that branch with a dedicated `Backend Engineering Agent` git identity (the developer's own global git config is never read or touched).
- `changedFiles` and the new `diff` field on `ExecutionReport` are computed from `git diff --numstat <base> HEAD` — proven, in the real validation below, to override Claude's own self-reported (and in that run, incorrect) file list.
- Nothing is ever merged automatically. The branch is a normal branch in the developer's own repository, inspectable with ordinary git commands.
- Workspaces are never auto-deleted (success, failure, or cancellation) — `GitWorktreeManager.remove()` exists as a tested, explicit cleanup primitive for future use.

## CI

`.github/workflows/ci.yml`, added this phase: on every push and pull request, one job installs dependencies, typechecks/builds both workspaces, and runs the full unit/integration suite (72 backend + 13 frontend); a second job installs Playwright's Chromium browser and runs the committed E2E suite. Neither job requires credentials or touches real Claude Code execution.

## E2E

`e2e/tests/happy-path.spec.ts` (Playwright, new `e2e/` npm workspace): opens the dashboard, creates a task, submits it, waits for the real SSE-driven pipeline to reach `completed`, asserts the final-handoff panel and mock-execution banner render, and asserts zero browser console errors. Runs headless in CI against the default mock executor via Playwright's `webServer` auto-start (`npm run dev`).

## Real executor

`RealClaudeCodeExecutor` (`server/src/execution/RealClaudeCodeExecutor.ts`) now:
- resolves its working directory from `task.executionWorkspace`, never `task.repository`, for every call (`analyze`, `implement`, `runTests`, `review`);
- tracks every spawned `claude` process per task so `cancel(taskId)` can kill it (`SIGTERM`, escalating to `SIGKILL` after 5s);
- distinguishes an explicit cancellation from an automatic timeout (both arrive as `SIGTERM`, disambiguated by whether `cancel()` was actually called for that task);
- derives `implement()`'s `changedFiles`/`diff` from `GitWorktreeManager.commitChanges()` + `.diff()` — real git evidence, not the CLI's self-report;
- degrades every failure mode (launch failure, non-zero exit, malformed JSON, timeout, missing workspace) to a normal `status: "failed"` report with a specific message, never a crash.

## Testing

```
Backend (vitest):  72 passed (was 43)
  + repositorySafety.test.ts           7  — every rejection case, plus the "allows an ordinary
                                             directory" positive case (caught a real bug: an
                                             overly broad /var,/private block that would have
                                             rejected macOS's own temp directory — fixed before
                                             it shipped)
  + gitWorktree.test.ts                9  — real throwaway git repos: worktree creation, base
                                             revision, never copying uncommitted changes, commit,
                                             diff, removal
  + realClaudeCodeExecutorUnit.test.ts 4  — mocked child_process: permission-mode per call,
                                             cwd is always the workspace, ground-truth diff
                                             overriding a deliberately-wrong CLI self-report,
                                             cancel() targeting only the right task's process
                                             (caught a real bug: workspaceOf() was called
                                             outside the try/catch in three methods, so a
                                             missing workspace crashed the promise instead of
                                             degrading to a clean failed report — fixed)
  + realExecution.test.ts              2  — full HTTP+orchestrator+real-git integration via a
                                             fixture CLI: happy path (branch created, working
                                             tree untouched, ground-truth diff) and the platform
                                             refusing to run against its own source directory
  + realExecutionTimeout.test.ts       1  — a hung fixture CLI is actually killed (elapsed time
                                             assertion, not just a status check) and labeled
                                             as a timeout
  + realExecutionCancel.test.ts        3  — cancel() actually kills the process (elapsed time
                                             assertion), stays cancelled, and the 404/409 cases
  + api.test.ts                        +3 — cancel endpoint in mock mode
Frontend (jest):   13 passed (unchanged — mock-mode UI behavior untouched)
E2E (playwright):   1 passed
Full build:        clean (server tsc, ng build — 269 kB initial, unchanged)
```

Two of the new tests caught real bugs before they shipped (noted above) — direct evidence the testing effort here wasn't pro forma.

## Real validation

A disposable Express/Node.js repository was created specifically for this validation (never an existing project) at a scratch location, with one commit. The server was started with `CLAUDE_EXECUTION_MODE=real`, pointed at the actual `claude` CLI (version 2.1.236, confirmed installed in this environment).

**Task**: "Add a GET /version endpoint that returns a JSON object with a version field set to 1.0.0."

**What happened**, in order, all through the real API/UI (not simulated):

1. Repository inspected: detected Node + Express, no test command.
2. Routed to the Node.js Backend specialist alone (no database concern in the requirement).
3. Isolated workspace prepared: `agent/task-96f7747d-0f3d-4f0b-b107-8ee204b3a253`, base revision `2e5859e18cc6`.
4. Real Claude Code analysis (genuine reasoning, not scripted): correctly identified the repo as a single-file Express app with no router/service layering, and recommended adding the route inline rather than over-engineering separate route/service/test files — with real evidence cited from the actual file contents.
5. Reconciliation: `AGREED`, 90% confidence.
6. Real implementation pass (14.7 seconds): added the route to `src/index.js`.
7. Ground-truth diff (from `git diff`, not Claude's self-report): **1 file changed, 4 insertions(+), 0 deletions(-)** — `src/index.js`.
8. Real review pass: `PASS`, with one genuine (non-fabricated) warning — the hardcoded version string could drift from `package.json`'s own version field.
9. Final handoff generated, task `completed`.

**Independently verified against the disposable repository's actual git state** (not just the API's report of it):

```
$ git branch --show-current
main                                    # unchanged — the agent never touched it

$ git status --porcelain
                                         # empty — working tree completely untouched

$ git log --oneline main
2e5859e initial: minimal express service   # the agent's commit is NOT here

$ git log --oneline agent/task-96f7747d-0f3d-4f0b-b107-8ee204b3a253
0dff2ef Agent: Add version endpoint
2e5859e initial: minimal express service

$ git diff main agent/task-96f7747d-0f3d-4f0b-b107-8ee204b3a253
+app.get("/version", (req, res) => {
+  res.json({ version: "1.0.0" });
+});
```

The Task Detail UI was also loaded against this completed real-mode task and screenshotted: the isolation panel correctly showed "Isolated git worktree — your working tree is protected," the real base revision and branch, a 14.7s duration, and the diff summary — with **zero browser console errors**.

**Outcome**: real execution works correctly, safely, and exactly as designed — the developer's repository was genuinely never touched outside the isolated branch, and every claim the UI/API made about what happened was independently verified against the actual git state, not just trusted.

## Known limitations

- `runTests()` cannot be cancelled independently of the overall CLI-call cancellation (documented in `docs/REAL_EXECUTION.md`).
- Task workspace cleanup is a tested primitive (`GitWorktreeManager.remove()`), not an automatic process — disk usage from accumulated task workspaces is unbounded until a future maintenance path uses it.
- The repository-safety guard is a deny-list plus a few positive checks, not a sandbox — see `docs/REAL_EXECUTION.md`'s own "Known limitations" for the precise boundary.
- Automated CI coverage of the real executor uses a fixture CLI, not the actual `claude` binary (ADR 0004) — a real `claude` CLI compatibility regression (flag rename, output format change) would only be caught by the manual validation step documented above, not by CI.
- Memory-layer wiring, reconciliation's `CONFLICT` detection, and task retry/resume were explicitly out of scope for this phase, per the approved milestone.

## Next recommended milestone

**Wire the memory layer's first real loop** (P1-3 from `docs/NEXT_STEPS_ARCHITECTURE_REVIEW.md`): now that real execution can be trusted and repeated safely, the highest-leverage next step is closing the loop between a completed real task and the platform's own memory types — retrieval-in during `analyze()` (literally `ORCHESTRATOR.md`'s own Responsibility #3, still unimplemented) and an explicit human-approved promotion of a reconciliation decision into a stored lesson. It's a fully-typed, storage-complete subsystem sitting at zero product value today, and it's the last unbuilt box in the platform's own stated pipeline diagram ("Validated Engineering Memory"). Not implemented here — this is a recommendation for the next phase, not a start on it.
