# Phase 33 Completion Report — Review Intelligence: Ground-Truth Diff Content

**Status**: Complete.

## Summary

Phase 32's completed platform computed `changedFiles`/`diff` from a real `git diff`, but only as
`--numstat` counts — the specialist reviewer and the Task Detail UI both only ever saw a file list
and aggregate line counts, never the actual patch. Phase 33 closes that gap: `GitWorktreeManager.diff()`
now also captures the real unified-diff patch text, bounded to a configurable maximum
(`MAX_DIFF_PATCH_CHARS`, default 200,000 characters), truncating explicitly — never silently — when
a diff exceeds it. The real-mode reviewer's prompt now embeds this bounded patch directly, framed as
untrusted repository content to inspect rather than instructions to follow, with an explicit warning
when it's been truncated. Task Detail gained a new "Implementation Diff" panel showing per-file
stats and the collapsible patch itself.

## Invariants checked

| Invariant | Status |
|---|---|
| Ground-Truth Diff Capture | ✓ — `git diff <base> HEAD`, not Claude's self-report |
| Bounded Patch | ✓ — `MAX_DIFF_PATCH_CHARS`, default 200,000 chars |
| Explicit Truncation | ✓ — marker in the stored patch, `truncated` flag, `totalPatchChars` never a guess |
| Review Prompt Integration | ✓ — bounded patch embedded, framed as untrusted content |
| Task Detail Diff Panel | ✓ — per-file stats, truncation notice, collapsible patch |
| Empty Diff Handling | ✓ — three distinct states: no changes / mock mode / unavailable |
| Git Validation | ✓ — automated (gitWorktree.test.ts) and manual (below), both independently verified against real `git diff` |
| Real Claude Validation | ✓ — run (see below), not skipped |
| Backend Tests | ✓ — 205 passing (198 + 7 new) |
| Frontend Tests | ✓ — 49 passing (44 + 5 new) |
| Playwright | ✓ — 1 passing, extended (mock-mode scope; see Known limitations) |
| Build | ✓ — server (`tsc`) and web (`ng build`) both clean |
| Lint | ✓ — `tsc --noEmit` clean |
| Documentation | ✓ — README, REAL_EXECUTION.md, API.md, AGENT_WORKFLOW.md, ADR 0009, this report |

`changedFiles = Git-derived` (Phase 28's original invariant) and the new `diff.patch = Git-derived
patch` both hold — verified independently below, not just asserted.

## Tests

- **Backend (vitest)**: 205 passing (was 198; +7 — 5 new in `gitWorktree.test.ts` covering patch
  capture matching an independently-run `git diff`, empty-diff, exactly-at-limit, over-limit, and
  file-boundary-preferring truncation; 2 new integration tests — `reviewDiffContent.test.ts` and
  `reviewDiffTruncation.test.ts` — using the same real-git/fake-CLI convention established in Phase
  28, extended to log every prompt the fake CLI receives so the suite can assert the *actual* review
  prompt contains real patch content and the truncation warning, not merely that the pipeline reaches
  `completed`).
- **Frontend (jest)**: 49 passing (was 44; +5 — the new "Implementation Diff" panel's five states:
  files+patch rendered collapsed by default, explicit truncation notice, no-changes state, mock-mode
  explanation, and diff-unavailable state for a real-mode report with no diff).
- **Playwright**: 1 passing (unchanged test count, extended) — the existing happy-path test now also
  asserts the new "Implementation Diff" heading and the mock-mode explanation render correctly in a
  real Chromium browser.
- **Total**: 255 (up from 243). `npm test` runs 254 (205 backend + 49 frontend); `npm run test:e2e`
  runs the Playwright test separately.

## Real Git validation

Every new backend test independently re-derives expected patch content via its own `git diff` call
(or, for the fake-CLI integration tests, a distinctive marker string written to disk by the fake CLI
and verified present in the platform's captured patch) — never asserting against the platform's own
output alone. The file-boundary truncation test computes the real boundary position in an actual
two-file `git diff` output and verifies the platform's truncated patch is a strict prefix of the
real one, cut exactly there.

## Real Claude validation

Run, not skipped. The actual `claude` CLI (v2.1.236 — same version validated in Phase 28) was
invoked end-to-end against a disposable throwaway repository:

1. Started the server in real mode (`CLAUDE_EXECUTION_MODE=real`) against a fresh scratch
   `DATA_DIR`/`TASKS_DIR`, pointed at a disposable git repo (`express`-style `src/app.js` with one
   existing route).
2. Created and started a task: "Add a GET /ping endpoint to src/app.js that returns JSON
   `{"pong": true}`."
3. The pipeline ran inspecting → routing → analyzing → implementing → reviewing → **completed**,
   driven by the real CLI throughout (no fixture).
4. Fetched `GET /tasks/:id/execution-report` and independently ran `git diff <base> <task-branch>`
   directly against the disposable repository (outside the platform, via a raw `git` command).

**Result — the platform's captured `diff.patch` and the independently-run `git diff` output were
byte-for-byte identical**:

```diff
diff --git a/src/app.js b/src/app.js
index 0fd9134..94df3f7 100644
--- a/src/app.js
+++ b/src/app.js
@@ -5,4 +5,8 @@ app.get("/health", (req, res) => {
   res.json({ status: "ok" });
 });
 
+app.get("/ping", (req, res) => {
+  res.json({ pong: true });
+});
+
 module.exports = app;
```

Also independently verified: `truncated: false`, `totalPatchChars: 283` matched `patch.length`
exactly (well under the 200,000-character bound); the developer's own checked-out working tree was
untouched (`git status --porcelain` empty, `main` branch unchanged, no agent commit on `main`); the
isolated worktree/branch (`agent/task-<id>`) held the real commit; the final handoff's new
`diffTruncated` field was present and correctly `false`. The review report (`node-backend`) returned
`PASS` with no findings, and the handoff's own summary text demonstrated the specialist had reasoned
about the actual change ("mirroring its exact pattern... requires no new dependencies"), consistent
with — though not, on its own, conclusive proof of — the reviewer having genuinely used the diff
content now included in its prompt (the deterministic proof of prompt inclusion is the automated
`reviewDiffContent.test.ts`, which inspects the literal prompt text; this manual run's purpose was to
confirm the whole real pipeline, including the actual CLI, still produces a correct end-to-end
result). The validation server and scratch repository were stopped and deleted afterward; no state
from this run was retained.

## Build / Lint / Validation commands run

```
npm test              → 205 backend + 49 frontend = 254 passing
npm run test:e2e       → 1 passing
npm run build           → server (tsc) PASS, web (ng build) PASS
npm run lint             → PASS (tsc --noEmit)
```

All commands were run from a clean working tree after each commit; the backend suite was re-run
twice to rule out the pre-existing, memory-documented, machine-specific flake (a background VS Code
Jest-extension watch process competing for CPU) — no such flake occurred during this phase's runs.

## Regression verification

All Phase 28–32 behavior re-verified passing, unmodified, in the same full-suite runs above:
real-mode isolation (`realExecution.test.ts`), cancellation (`realExecutionCancel.test.ts`), timeout
(`realExecutionTimeout.test.ts`), retry and real-mode retry isolation (`retryApi.test.ts`,
`taskRetryRealMode.test.ts`), startup crash recovery (`startupRecovery.test.ts`), conflict
detection/resolution (`reconciliationApi.test.ts`), memory retrieval/approval
(`memoryApi.test.ts`, `memoryLoop.e2e.test.ts`), and workspace cleanup including the blocked-task
regression test (`workspaceCleanup.test.ts`). Nothing in this phase touched routing, reconciliation,
memory, retry, crash recovery, or cleanup logic — only diff capture, the review prompt, and their
display — and the test results confirm that isolation held.

## Main architectural change

`GitWorktreeManager.diff()` now captures bounded, ground-truth unified-diff patch text alongside its
existing `--numstat` counts, threaded through `ExecutionReport.diff.patch` into both the real-mode
review prompt (framed as untrusted content) and a new Task Detail UI panel. No new endpoint, no new
`TaskStatus`, no new store, no new concurrency concern — the change extends the existing
`ExecutionDiff` type and the existing `GET /tasks/:id/execution-report` response, reusing the
diff-computation call site `implement()` already had. See `docs/adr/0009-ground-truth-diff-content.md`.

## Known limitations

- **No automated browser test exercises real patch content.** The committed Playwright suite is
  mock-executor-only (unchanged from Phase 32) — mock mode never produces a diff at all, so the
  extended happy-path test can only verify the new panel renders and shows the correct mock-mode
  message in a real browser, not that real patch text renders correctly there. That specific gap —
  real patch content reaching a real browser — is covered by the backend real-git integration tests
  plus the manual real-CLI validation above (which used the API directly, not a browser), not by an
  automated browser test. This mirrors Phase 32's own documented limitation for the same reason.
- **The "untrusted content" framing narrows, but does not eliminate, prompt-injection exposure.** It
  only covers the diff-content channel added by this phase. Other repository content the `claude` CLI
  reads agentically (source files, READMEs, comments) during analysis/implementation/review is still
  unfiltered by this platform, exactly as documented in `docs/PHASE_33_PLATFORM_REVIEW.md` §12 — this
  phase did not attempt, and does not claim, to solve that broader problem.
- **`git diff --numstat` plus a separate full `git diff` is two git invocations per implementation
  pass**, not one — a deliberate simplicity-over-cleverness choice (reusing the existing numstat
  parsing untouched) rather than a performance concern; both calls are already well within the
  existing 10 MB `execFile` buffer and typical task timeouts.
- **Diff truncation uses a `diff --git` text-boundary heuristic**, not real diff/AST parsing — for a
  patch with an unusual or adversarially-crafted internal structure, the boundary-detection regex
  could in principle miss a cleaner cut point and fall back to a hard character cut. This is bounded
  and always explicit (never silent) even in that fallback case, so it degrades gracefully rather
  than incorrectly.

## Next recommended milestone

Unchanged from the Phase 33 proposal's own secondary candidates, re-affirmed now that Review
Intelligence is complete: **Failure-Path Handoff Completeness** (a `failed`/`blocked`/`cancelled`
task currently gets only a single error string, no structured summary of what was attempted or
concluded) is the smallest, most directly evidence-backed next step. **Repository Deep
Understanding** remains the larger, higher-leverage follow-up once a smaller win is banked. Neither
is authorized by this report — this is a factual status report, not a new proposal.
