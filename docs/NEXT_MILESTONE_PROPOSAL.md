# Next Milestone Proposal: Trustworthy Real Execution

Status: proposal only — not implemented. Full context in `docs/NEXT_STEPS_ARCHITECTURE_REVIEW.md`.

## Why this milestone

The platform's entire value proposition is that Claude Code actually implements backend changes. Right now that path (`RealClaudeCodeExecutor`) is fully coded but has **never been run end-to-end** in this project's history (the project's own `MVP_COMPLETION_REPORT.md` says so), has **zero dedicated tests**, and — as currently wired — mutates whatever repository path the developer types, directly, in `acceptEdits` mode, with no git isolation, no diff review, and no cancellation. This is simultaneously the biggest unproven capability and the biggest risk in the system. Every other roadmap item (live streaming, memory wiring, conflict detection, additional specialists) is either downstream of this working safely, or only worth prioritizing once real (not mock) task runs start happening repeatedly.

Paired with it: there is currently **no CI at all**. Reworking the riskiest, least-tested part of the codebase without a regression safety net first would be the wrong order of operations — so this milestone builds that net first, then uses it.

## What it unlocks

- The first-ever real, verified execution of `CLAUDE_EXECUTION_MODE=real` against a disposable repository.
- A safe default for anyone who turns real mode on afterward: changes land on an isolated branch/worktree, never directly on the developer's live checkout.
- A committed, automated regression test (the browser/SSE flow that's currently only been run manually, repeatedly, by hand) and a CI pipeline running the full 56-test suite on every change.
- The foundation every later milestone needs: streaming, memory wiring, and real conflict detection are all far more valuable once real task execution is something the team actually trusts and uses.

## What it intentionally does NOT include

- Cancel / retry / resume for tasks (separate milestone — P1-1 in the roadmap).
- Full token-level streaming of Claude's reasoning (this milestone only needs "isolated and observable," not a live transcript — that's P1-2).
- Wiring the memory layer (P1-3).
- Reconciliation's `CONFLICT` status detection (P2-1).
- PostgreSQL, additional specialists, or any knowledge-ingestion pipeline — no trigger for any of these exists yet.

## Acceptance criteria

1. `.github/workflows/ci.yml` runs `npm test` (both workspaces) and `npm run build` on every push/PR; a red test fails the build.
2. The existing manual Playwright verification flow is committed as an automated, headless-runnable test in the repository.
3. `RealClaudeCodeExecutor.implement()` (and `analyze()`/`review()` where applicable) runs against an isolated git worktree or dedicated branch — never the caller's live working tree directly.
4. A pre-flight guard rejects or clearly warns on suspicious repository paths (home directory root, filesystem root, a directory with no `.git`) before real-mode execution proceeds.
5. Task Detail shows, for real-mode tasks, where the changes actually live (branch/worktree identifier) — never implying the developer's current checkout was touched when it wasn't, or the reverse.
6. At least one full real task is run end-to-end against a disposable test repository as part of validating this milestone, and the result is documented.
7. All 56 pre-existing tests stay green; new tests cover the worktree lifecycle and `RealClaudeCodeExecutor`'s prompt construction / JSON parsing / failure handling (currently zero coverage).

## Expected files/modules affected

- New: `.github/workflows/ci.yml`
- New: committed Playwright E2E test + config (e.g. `web/e2e/`, `playwright.config.ts`)
- New: a git-worktree/branch lifecycle utility (e.g. `server/src/execution/gitWorktree.ts`)
- New: a repository-path sensibility guard (extends `server/src/utils/paths.ts` or a new module)
- Modify: `server/src/execution/RealClaudeCodeExecutor.ts` (isolation-aware `cwd`)
- Modify: `server/src/types/index.ts` (`Task` carries worktree/branch metadata for real-mode runs)
- Modify: `web/src/app/pages/task-detail/*` (surface branch/worktree info for real-mode tasks)
- Modify: `docs/MVP_ARCHITECTURE.md`, `docs/API.md`, `docs/LOCAL_DEVELOPMENT.md` (document the isolation model and CI)

## Tests required

- New unit tests for the worktree/branch lifecycle utility (create, cleanup, failure-to-create paths).
- New unit tests for `RealClaudeCodeExecutor` with `child_process` mocked (prompt assembly, JSON-envelope extraction, non-zero-exit handling) — currently zero coverage on the highest-risk file in the codebase.
- One committed, CI-runnable Playwright test covering: create task → start → live SSE-driven completion → zero console errors.
- One manually-run (not CI-gated) real-mode end-to-end validation against a disposable repository, documented as part of closing this milestone.

## UI changes required

- Task Detail: a real-mode-only panel showing the isolation branch/worktree the changes landed on.
- No new pages; no changes to Dashboard or Create Task beyond what's needed to reflect the above on the detail view.

## Backend changes required

- `RealClaudeCodeExecutor` reworked to create/use an isolated worktree or branch instead of `task.repository`'s live working tree.
- A repository-path guard rail invoked before real-mode execution is allowed to start.
- `Task` type and persistence extended with isolation metadata (branch/worktree path) for real-mode tasks.

## Documentation changes required

- `MVP_ARCHITECTURE.md`: replace the current "Security" section's isolation caveat with the actual isolation model once built.
- `API.md`: document any new task fields exposed for real-mode isolation metadata.
- `LOCAL_DEVELOPMENT.md`: document how to validate real execution locally against a disposable repository, and how CI is run.

---

**Do not implement until explicitly approved.**
