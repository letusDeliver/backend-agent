# ADR 0002 — The developer's working tree is protected, never negotiated with

**Status**: Accepted (Phase 28)

## Context

Real execution needs *some* starting point for the isolated worktree it creates (ADR 0001). The developer's repository might have uncommitted changes at the moment a task starts. The platform needs a policy for what happens to them.

## Decision

The developer's working tree is **read from, never written to, and never blocked on**:

- Real execution starts from the repository's committed `HEAD`, full stop. Uncommitted changes are neither included in the task's scope nor touched in any way — they simply aren't visible to the isolated worktree, because `git worktree add` only operates on committed refs.
- The platform never stashes, commits, resets, or otherwise mutates the developer's working tree on their behalf, under any circumstance — not to "make room" for the task, not on cleanup, not on failure.
- If the target directory isn't a git repository, or has zero commits, real execution refuses with a clear, actionable error (task `blocked`, not a crash) rather than falling back to some other, less safe base state.

Alternatives considered and rejected:
- **Auto-stash uncommitted changes before starting**: rejected — silently manipulating the developer's git state (even reversibly) is exactly the kind of surprising, hard-to-reverse-feeling action this platform's own stated principles argue against elsewhere (mock vs. real execution transparency, no silent conflict resolution).
- **Require a clean working tree and refuse otherwise**: rejected as unnecessary — since worktrees don't see uncommitted state anyway, requiring cleanliness would add friction without adding safety.

## Consequences

- A developer can keep working in their editor on the same repository while a real task runs, with no coordination required.
- If a developer *wants* their uncommitted work-in-progress included in a task's scope, they must commit it (even to a scratch/WIP commit) first — this is a deliberate, documented tradeoff (see `docs/REAL_EXECUTION.md`), not an oversight.
- This decision is what makes ADR 0001 safe without any additional dirty-tree detection logic.
