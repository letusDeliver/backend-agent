# ADR 0004 — Mock executor remains the CI default; real integration tests are separated

**Status**: Accepted (Phase 28)

## Context

Phase 28 needed a regression safety net (CI, a committed browser E2E test) built *before* reworking the riskiest, least-tested code path in the system (`RealClaudeCodeExecutor`). That safety net needs to run on every push and pull request, reliably and without cost or flakiness.

## Decision

- CI (`.github/workflows/ci.yml`) and the committed Playwright E2E suite (`e2e/`) never set `CLAUDE_EXECUTION_MODE=real` and never invoke the actual `claude` CLI. They run exclusively against the default mock executor.
- Automated coverage of the *real* executor's behavior (`server/tests/real*.test.ts`) uses a small fixture script standing in for the `claude` CLI — real git plumbing (a genuine throwaway repository, real `git worktree`/`diff`/`commit` commands), fake LLM output. This is what runs in CI.
- Validating against the actual `claude` CLI is a deliberately separate, manual, documented step (`docs/REAL_EXECUTION.md`, `docs/PHASE_28_COMPLETION_REPORT.md`) — not part of the automated suite.

Alternatives considered:
- **Run real CLI calls in CI, gated behind a secret**: rejected — introduces a hard dependency on API credentials being available to CI, real cost on every run, and non-determinism (an LLM's output isn't a fixed fixture) into a suite whose job is fast, reliable regression detection.
- **Skip real-executor testing in the automated suite entirely, rely only on manual validation**: rejected — the fixture-CLI approach gets almost all the confidence of true integration testing (real git behavior, real process lifecycle, real timeout/cancellation) without the cost or flakiness, so there's no good reason to give that up.

## Consequences

- Every PR gets fast, deterministic, credential-free verification of both the orchestration logic (mock mode, unchanged) and the real-execution mechanics (fixture-CLI, git-real).
- A genuine regression in how the platform talks to the actual `claude` CLI (a flag rename, an output-format change) would not be caught by CI — only by the manual validation step. This is an accepted, documented limitation; revisit if `claude` CLI compatibility regressions become a recurring problem.
