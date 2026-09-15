# Real Execution

This document explains exactly how `CLAUDE_EXECUTION_MODE=real` works as of Phase 28 ("Trustworthy Real Execution"), what it protects you from, and what it doesn't. Be skeptical of anything here that isn't also true of the code — if in doubt, read `server/src/execution/RealClaudeCodeExecutor.ts` and `server/src/execution/gitWorktree.ts` directly.

## Mock vs. real, at a glance

| | Mock (default) | Real |
|---|---|---|
| Enabled by | nothing — this is the default | `CLAUDE_EXECUTION_MODE=real` |
| Touches your repository? | Never | Only an isolated git worktree — see below |
| Touches your working tree / current branch? | Never | **Never** — see "Isolation" |
| Test evidence | Simulated, clearly labeled | Real — runs your repo's actual test command |
| Cancellable mid-run? | N/A (every call is instant) | Yes — `POST /tasks/:id/cancel` |
| Timeout | N/A | `CLAUDE_TIMEOUT_MS` (default 120000ms) |

## Enabling real mode

```bash
CLAUDE_EXECUTION_MODE=real npm run dev:server
```

Real mode is never the default and is never triggered implicitly by anything in the UI — it's an explicit operator decision, made by setting an environment variable before the server starts. `GET /api/health` always reports the active mode, and every task, specialist report, execution report and review report carries `executionMode` so nothing produced by real execution can be mistaken for a mock result, or vice versa.

## Isolation

**Real execution never runs directly against the repository path you give it.** Before any specialist analysis, implementation, or review call happens, the orchestrator creates an isolated **git worktree**:

- Location: `tasks/<task-id>/workspace/`, alongside that task's other artifacts.
- Branch: `agent/task-<task-id>`, created from your repository's current `HEAD` at the moment the task starts.
- Mechanism: `git worktree add -B agent/task-<id> tasks/<id>/workspace <base-revision>`, run against your repository but writing only to the new worktree directory.

`git worktree add` operates on **committed history only**. It does not copy your working directory's state — so:

- **Uncommitted changes in your repository are never included in the task's scope**, and are never read, copied, staged, or touched in any way. If you want work-in-progress included, commit it (even to a WIP branch) before starting the task.
- **Your currently checked-out branch and working tree are never modified.** You can keep working in your editor, on the same repository, while a real task runs — nothing here will interact with your open files, your git index, or your current branch.
- Claude Code's file edits (`implement()`, run in `--permission-mode acceptEdits`) happen only inside `tasks/<task-id>/workspace/` — a separate directory entirely.

After `implement()` finishes, whatever it actually changed is committed onto the task branch (`git add -A && git commit`, using a dedicated `Backend Engineering Agent` git identity — your global git config is never read or modified) and diffed against the base revision. That diff — file list, additions/deletions, summary — is what the API and UI actually show you, computed from `git diff`, not taken from Claude's self-reported JSON. If Claude's implementation pass claims it changed files that don't actually appear in the diff, the diff wins.

**The task branch is never merged or applied automatically.** It sits in your repository's own ref namespace (worktrees share the same `.git`), inspectable and mergeable with ordinary git commands from your own checkout:

```bash
git log agent/task-<task-id>
git diff main agent/task-<task-id>
git merge agent/task-<task-id>   # only when you're ready
```

## Repository safety guard

Before a worktree is created, the target path must pass a safety check (`server/src/utils/repositorySafety.ts`):

- Must exist, be a directory, and be a git repository with at least one commit.
- Rejected: your home directory, the filesystem root, and well-known system directories (`/etc`, `/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/Applications`).
- Rejected: the platform's own source directory, or any directory that contains it or is contained by it — real execution can never be pointed at its own orchestrator code.

This check only runs for real-mode tasks, at the point real execution is about to begin — task creation and mock-mode tasks are unaffected (mock execution never touches disk at all).

If the check fails, the task is `blocked` with a clear reason in `task.error` — it is never silently downgraded to operating on an unsafe path.

## Timeout

Every `claude` CLI invocation is bounded by `CLAUDE_TIMEOUT_MS` (default 120000ms / 2 minutes). If a call exceeds this, Node terminates the process (`SIGTERM`) and the resulting report is explicitly labeled as a timeout (`"claude CLI timed out after <n>ms and was terminated"`) — never reported as a successful result. This is distinct from an ordinary CLI failure (non-zero exit, malformed output), which is labeled separately.

## Cancellation

`POST /tasks/:id/cancel` marks a task `cancelled` (a terminal status) and kills any in-flight `claude` CLI process for that task (`SIGTERM`, escalating to `SIGKILL` after 5 seconds if it hasn't exited). The orchestrator also checks the task's persisted status between every pipeline phase, so a task cancelled while nothing was actively running still stops making progress at the next checkpoint instead of continuing silently.

**Known limitation**: cancellation is fully wired for the `claude` CLI calls (analyze/implement/review) — the primary "an AI agent is doing something" cost center. It does not currently interrupt an in-flight `runTests()` shell command (the repository's own test command); that call still runs to its own timeout. In practice this is rarely the long pole, since test suites are usually much faster than a Claude Code reasoning/implementation pass.

## Cleanup

Task workspaces (`tasks/<task-id>/workspace/`) are **never automatically deleted** — not on success, not on failure, not on cancellation. This is deliberate: a failed or cancelled task's workspace is exactly what you need to debug it. `GitWorktreeManager.remove()` exists as a safe, tested cleanup primitive (`git worktree remove --force` + branch deletion), but nothing in this phase wires it to an automatic trigger — that's left for a future maintenance command once there's real usage data on how much workspace accumulation actually matters in practice.

## Failure recovery

Every failure mode — CLI launch failure, non-zero exit, malformed JSON response, timeout — degrades to a normal `status: "failed"` report with a clear, specific message in `assumptions` (specialist reports), `notes` (execution reports), or `findings` (review reports). None of them crash the task run itself; the orchestrator's outer error handler additionally catches anything unexpected and marks the task `failed` with the error message, rather than leaving it stuck.

## The real integration test

The automated test suite (`npm test`, run in CI) never invokes the actual `claude` CLI — every real-mode test in `server/tests/real*.test.ts` uses a small fixture script standing in for it, so the suite needs no credentials, no network access to Anthropic's API, and runs deterministically. Those tests exercise 100% real git plumbing (a real throwaway repository, real `git worktree`/`diff`/`commit` commands) against the fixture CLI.

Validating against the **actual** `claude` CLI is a separate, manual step — documented with real output in `docs/PHASE_28_COMPLETION_REPORT.md` — because it costs real API usage and takes real wall-clock time (each specialist call is a genuine Claude Code reasoning pass). To run it yourself:

```bash
# 1. Create a disposable repository you're comfortable having modified.
mkdir /tmp/my-disposable-repo && cd /tmp/my-disposable-repo
git init -b main
# ... add a minimal package.json / requirements.txt and commit it

# 2. Start the platform in real mode.
CLAUDE_EXECUTION_MODE=real npm run dev

# 3. Create and start a task via the UI (http://localhost:4300) against
#    that disposable repository, or via the API:
curl -X POST http://localhost:4400/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"requirement": "...", "repository": "/tmp/my-disposable-repo"}'
curl -X POST http://localhost:4400/api/tasks/<id>/start

# 4. Watch it complete, then inspect the isolated branch yourself:
cd /tmp/my-disposable-repo
git log agent/task-<id>
git diff main agent/task-<id>
```

## Known limitations

- `runTests()` cannot currently be cancelled mid-run independently of the overall task timeout (see Cancellation above).
- Workspace cleanup is manual/future work, not automatic (see Cleanup above).
- The repository-safety guard is a deny-list plus a few positive checks, not an exhaustive sandbox — it stops the obvious dangerous targets (your home directory, system paths, the platform's own source), not every conceivable misuse of a local developer tool that already has file-write access to your machine.
- Real execution still runs directly on your machine, as your own OS user, with whatever filesystem/network access that implies — there is no container or VM boundary. Isolation here means "isolated from your repository's working tree and branch," not "sandboxed from your machine."
