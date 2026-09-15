# ADR 0003 — Real execution remains explicitly opt-in

**Status**: Accepted (originally implicit in the MVP; made explicit in Phase 28)

## Context

The MVP shipped with `CLAUDE_EXECUTION_MODE` defaulting to `mock`, requiring an operator to explicitly set it to `real`. Phase 28 revisited every execution-related decision from scratch (per its own instruction not to assume the prior architecture review was completely correct) — this ADR records that the opt-in default was re-examined and reaffirmed, not merely inherited.

## Decision

Real execution stays off by default and is enabled only via `CLAUDE_EXECUTION_MODE=real`, a server-startup environment variable — never a per-task UI toggle, never inferred from repository content, never enabled implicitly by any API call.

This holds even after Phase 28's isolation work substantially reduced the risk of real execution (ADR 0001, ADR 0002): isolation makes real execution *safer*, not *free of consequence*. It still costs real API usage, still takes real wall-clock time, and still produces a real git branch a human needs to review. None of that should ever be a side effect of a button click without the operator having made a deliberate, session-level decision first.

## Consequences

- A given server process is either "a mock-execution server" or "a real-execution server" for its whole lifetime — never a mix negotiated per task.
- Every task, specialist report, execution report and review report still carries `executionMode` explicitly, so even within a real-mode server, nothing is ambiguous about what produced a given artifact.
- Container/VM-level sandboxing (beyond the git-level isolation in ADR 0001) remains out of scope for this phase — see `docs/REAL_EXECUTION.md`'s "Known limitations." The opt-in default is the primary safety control; sandboxing is a reasonable future addition, not a substitute for it.
