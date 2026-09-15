# ADR 0001 — Real execution uses isolated git worktrees

**Status**: Accepted (Phase 28)

## Context

Before Phase 28, `RealClaudeCodeExecutor` ran every Claude Code CLI call (`analyze`, `implement`, `review`) and the repository's test command directly against `task.repository` — the developer's actual, currently-checked-out working directory. `implement()` runs in `--permission-mode acceptEdits`, meaning Claude Code could write files there directly, with no snapshot, no branch, and no way to distinguish the agent's changes from the developer's own uncommitted work. This had never been exercised end-to-end precisely because of that risk.

## Decision

Real execution now runs exclusively against an isolated **git worktree**, created via `git worktree add -B agent/task-<task-id> tasks/<task-id>/workspace <base-revision>`, where `<base-revision>` is the repository's `HEAD` at task start.

Alternatives considered:
- **Full clone**: always safe, but slower (copies the whole object database) and wasteful for large repositories. Worktrees share the same `.git`, so branch/commit creation on the task branch is instantly visible from the developer's own checkout.
- **Dedicated branch checked out in place**: rejected outright — it would require checking out a different branch in the developer's own working directory, which is exactly the kind of working-tree disruption this decision exists to avoid.
- **Container/VM sandbox**: rejected for this phase as disproportionate — see ADR 0003's scope note. Isolation here means "isolated from your repository's branch and working tree," not "sandboxed from the host machine."

## Consequences

- Worktree creation only requires committed history in the target repository — uncommitted changes in the developer's working tree are never copied into the task's scope, with no extra logic required (a `git worktree` mechanically cannot see uncommitted state in another checkout).
- The developer's checked-out branch and working tree are provably never touched — verified directly in this phase's manual real-execution validation (`git status --porcelain` on the source repository remained empty throughout).
- Real execution now requires the target to be a git repository with at least one commit. This is a new constraint (previously any existing directory sufficed) — see ADR 0002.
- Multiple concurrent tasks against the same repository get independent worktrees/branches automatically, since `git worktree` is designed for exactly this.
