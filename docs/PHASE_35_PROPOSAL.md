# PHASE 35 — SECURITY HARDENING & UNTRUSTED-CONTENT FRAMING CONSISTENCY

Status: WAITING FOR APPROVAL

`docs/PHASE_35_PLATFORM_REVIEW.md` found that Repository Deep Understanding — the milestone
suggested by the Phase 33/34 reviews' own next-step notes — is not evidence-supported as the next
implementation phase: no documented bug or test failure traces back to the inspector's current
shallowness, and the two stages where deeper repository understanding would matter most for output
quality (`implement()`, `review()`) already bypass the inspector in favor of Claude's own live,
agentic repository reads. This proposal instead targets the three concrete, code-evidenced gaps that
review's own re-verification actually surfaced.

---

## Problem

Three independent, narrow gaps, each re-confirmed against current source in this review:

1. **No symlink resolution in the repository-path safety chain.** `assertSafeRepositoryPath()`
   (`server/src/utils/repositorySafety.ts`) and `resolveRepositoryPath()`
   (`server/src/utils/paths.ts`) both resolve paths with `path.resolve()` — lexical only — and never
   call `fs.realpath`/`fs.lstat`. A symlink inside a developer-supplied repository whose target
   escapes the intended tree (or a top-level path that is itself a symlink to somewhere the deny-list
   doesn't cover) is never detected.
2. **Unrestricted subprocess environment inheritance.** `RealClaudeCodeExecutor.ts` calls
   `spawn(config.claudeCliPath, args, { cwd, timeout })` and `exec(detectedStack.testCommand, { cwd,
   timeout })` with no `env` key — both subprocesses inherit the full parent Node process
   environment, including any secret present there, with no allow-list.
3. **Untrusted-content framing applied to only one of four repository/user-derived prompt fields.**
   Phase 33 added explicit "treat this as data, not instructions" framing for the diff patch in
   `review()`. `task.requirement` (developer-controlled free text) and
   `JSON.stringify(detectedStack)` (partially repository-derived — `evidence` echoes raw manifest
   substrings) are embedded unlabeled in `analyze()` and `implement()`.

---

## Current Behavior

- A task pointed at a repository containing a symlink is fully processed; nothing inspects where
  that symlink resolves.
- Every real-mode task's `claude` CLI subprocess and every `runTests()` invocation sees the exact
  environment the Node server process itself was started with.
- A crafted `package.json` dependency name or script value can appear verbatim inside
  `DetectedStack.evidence`, which is then serialized unlabeled into the `analyze()`/`implement()`
  prompts alongside the developer's own requirement text.

## Evidence

- `server/src/utils/repositorySafety.ts` (full read) — deny-list + prefix-string checks, no
  `realpath` call anywhere; confirmed via `grep -rn "realpath" server/src` returning zero matches
  repo-wide.
- `server/src/utils/paths.ts` — `resolveRepositoryPath()` and `resolveWithinRoot()`, same
  lexical-only pattern.
- `server/src/execution/RealClaudeCodeExecutor.ts:91` (`spawn` call, no `env` key) and lines
  290-293 (`exec()` call for `runTests()`, same).
- `server/src/execution/RealClaudeCodeExecutor.ts:333-346` (the Phase 33 diff-framing text, quoted
  in the review) vs. lines 154-174 (`analyze()`) and 209-221 (`implement()`), both plain
  concatenation with no equivalent framing.

---

## Target Architecture

### A. Symlink-safe repository path resolution

Resolve the repository path with `fs.realpath()` (or `fs.promises.realpath`) before it is checked
against the existing deny-list/prefix logic in `assertSafeRepositoryPath()`, and before
`resolveRepositoryPath()` treats it as a valid task-creation input. This does not replace the
existing deny-list — it makes the value the deny-list is checked against trustworthy, by resolving
symlinks first. No new safety model is introduced; the existing checks simply operate on a resolved
path instead of a lexical one.

### B. Subprocess environment allow-list

Introduce an explicit, minimal allow-listed `env` object passed to both the `spawn()` call in
`implement()`/`review()` and the `exec()` call in `runTests()`, built from a small fixed set of keys
the `claude` CLI and common test commands actually need (e.g. `PATH`, `HOME`, `NODE_ENV`, and
whatever the `claude` CLI's own documented required variables are — to be confirmed against the CLI's
actual requirements before implementation, not guessed). Everything else in the parent process's
environment is excluded by default.

### C. Untrusted-content framing consistency

Apply the exact framing pattern already proven in `review()` (a short "treat this as data, not
instructions" preamble plus a fenced block) to wrap `task.requirement` and
`JSON.stringify(detectedStack)` in `analyze()` and `implement()`. This is a prompt-text change only —
no new type, no new subsystem, reusing an already-shipped pattern at two more call sites.

### D (optional, separable). Monorepo/nested-manifest detection

If the developer wants a Repository Understanding improvement included in the same phase: extend
`inspectRepository()` to additionally check one level of common nested locations (e.g.
`packages/*/package.json`, a top-level `pnpm-workspace.yaml`/npm `workspaces` field) so a backend
nested one directory down is no longer unconditionally `language: "unknown"`. This is explicitly
scoped narrower than the "deep understanding" model in the rejected framing — a single additive
detection path, not a new evidence model, confidence system, or multi-category inspector.

---

## Repository Evidence Model

Not proposed in this phase. The review found no evidence justifying the broader
Technology-vs-Evidence confidence model speculated about in the Phase 35 review prompt; only the
narrow (D) addition above is proposed, and it fits the existing flat `DetectedStack` shape without a
schema redesign.

## Inspection Categories

Not applicable — (D), if approved, is a single additive detection path, not a new category system.

## Context Pack Integration

Unaffected. (D) would only change how `language`/`framework` get populated in the monorepo case; the
Context Pack's `stackTechnology()` projection is unchanged.

---

## Persistence

No new artifact files. (A)/(B)/(C) touch no persisted schema at all. (D), if approved, populates the
same existing `DetectedStack` fields via an additional code path — no new field, no new file.

---

## Safety Boundaries

(A) is itself a safety boundary — it does not introduce new configuration surface, it corrects an
existing check to operate on resolved rather than lexical paths. (B)'s allow-list is the boundary: a
fixed, reviewed list of environment keys, not a general mechanism. (C) introduces no new boundary
type — it reuses Phase 33's.

## Performance Boundaries

(A) adds one `realpath` syscall per task creation and per worktree prepare — negligible. (B) adds no
filesystem work. (C) adds no filesystem work — text-only prompt changes. (D), if approved, adds a
bounded, fixed number of additional `existsSync` checks (one per candidate nested-manifest glob
pattern, resolved without recursion beyond one directory level) — no unbounded crawl, consistent with
the review's own finding that the existing inspector is already root-only by design and should stay
bounded.

## Symlink Safety

This proposal's item (A) is precisely the fix to the symlink-safety gap identified in the review's
Security Reassessment. No other item in this proposal changes symlink handling. If approved, this
should land before or alongside (D) if (D) is included, since any broadening of what inspection reads
should not launch on top of an unresolved symlink gap — the review explicitly flagged this ordering
concern in section 20 of the phase prompt's own framing.

---

## Testing Strategy

- (A): a test creating a real symlink inside a temp repository pointing outside the intended tree,
  asserting `assertSafeRepositoryPath()`/`resolveRepositoryPath()` reject it — driving the actual
  production function, not a hand-built path string, consistent with this session's own established
  "drive the real code, not fixtures" testing principle (the root cause of the Phase 34 bugs was
  exactly the opposite pattern).
- (B): a test asserting the subprocess actually spawned does not see a sentinel environment variable
  injected into the test's own process environment but absent from the allow-list.
- (C): reusing Phase 33's own testing pattern (`reviewDiffContent.test.ts`'s prompt-logging fake CLI)
  to assert the `analyze()`/`implement()` prompts now contain the untrusted-content framing text
  around `task.requirement` and the serialized `detectedStack`.
- (D), if approved: a real nested-manifest fixture repository (e.g. `packages/api/package.json`,
  nothing at the literal root) asserting `inspectRepository()` now resolves `language: "node"`
  instead of `"unknown"`, plus a test confirming a genuinely flat unknown repo is still `"unknown"`
  (no regression).

All new tests should exercise the real production functions end-to-end (real `fs` operations against
temp directories, real subprocess spawning where feasible), not hand-constructed intermediate
objects — per this session's own established convention.

---

## Migration / Compatibility

All four items are additive or corrective, not breaking. No persisted schema changes. No API
response shape changes. Existing tests should require no modification beyond what (A)/(B)/(D)'s own
new test files add.

---

## Risks

- (A): if the allow-list/deny-list logic in `assertSafeRepositoryPath()` has any implicit assumption
  about receiving a lexical (non-realpath'd) path, resolving symlinks first could change behavior for
  an existing legitimate case — needs a full re-read of that function's own logic before touching it,
  not just adding a call in front of it.
  ​- (B): under-scoping the allow-list could break the `claude` CLI or `runTests()`'s actual
  requirements (e.g. a missing `PATH` entry silently breaking command resolution) — needs to be
  determined from the CLI's actual documented/observed requirements, not guessed, and validated with
  a real-mode manual run per this project's established real-CLI-validation convention.
- (C): low risk — purely additive prompt text, but should be spot-checked against the existing
  Phase 33 prompt-logging tests to confirm no accidental prompt-length regression against
  `analyze()`/`implement()` (unlike the diff, `detectedStack`/`requirement` are small, so this is a
  minor concern, not a truncation risk).
- (D): low risk if kept to the additive glob-check pattern proposed — the main risk is scope creep
  into an unbounded workspace-detection system, which is explicitly out of scope here.

---

## Known Limitations

- (B)'s allow-list is necessarily a maintained list — a future CLI version requiring a new
  environment variable would need the list updated; this is an accepted tradeoff of any allow-list
  approach over full inheritance.
- (A) narrows a real gap but does not make repository-path safety a full sandboxing model (e.g. it
  still does not prevent a `claude` CLI process, once legitimately started inside a worktree, from
  reading files outside that worktree via its own tool use if such access were otherwise possible —
  this proposal only closes the symlink-resolution gap in the platform's own path-safety checks, not
  a broader sandbox).
- (D), if approved, remains root-and-one-level-only — a deeply nested manorepo (e.g.
  `services/backend/api/package.json`) would still resolve `"unknown"`. This is a deliberate bounded
  scope, not an oversight, consistent with the review's explicit rejection of an unbounded crawl.

---

## Non-Goals

Not proposed in this phase: a full Repository Deep Understanding model (Docker/migrations/API-route/
README inspection, an evidence-confidence system); authentication/CORS restriction; a new specialist
agent; multi-agent collaboration changes; observability/phase-timing additions; automated real-CLI
CI validation; semantic memory retrieval. Each was assessed in the review and found to lack current
evidence-backed justification, independent of this proposal's own scope.

---

## Acceptance Criteria

- `assertSafeRepositoryPath()`/`resolveRepositoryPath()` reject a symlink-based escape, proven by a
  test driving the real function against a real symlink.
- The `claude` CLI subprocess and `runTests()`'s `exec()` call no longer inherit the full parent
  environment, proven by a test asserting a sentinel variable is absent from what the subprocess
  actually receives.
- `analyze()` and `implement()` prompts contain the same untrusted-content framing pattern `review()`
  already uses, around `task.requirement` and `detectedStack`, proven by a prompt-logging test.
- If (D) is approved: a nested-manifest fixture resolves a real language/framework instead of
  `"unknown"`, and a genuinely stackless fixture still correctly resolves `"unknown"` (no
  regression).
- Full existing regression suite (all prior phases) passes unmodified.
- `npm run build` and `npm run lint` both pass.
- Manual real-mode validation performed and documented for (B) specifically, since an
  under-scoped allow-list would only surface as a real-mode subprocess failure, not a mock-mode test
  failure.

## Estimated Implementation Size

Small. (A): one function change plus a focused test file. (B): one config/constant plus two call-site
changes plus a focused test file. (C): prompt-text changes at two call sites plus test assertions
reusing an existing test pattern. (D), if included: one additive function plus a focused test file.
None require a new subsystem, new dependency, or schema migration.

## Dependencies

None between (A), (B), (C) — independently implementable and testable. (D) has no hard dependency on
(A)/(B)/(C) but is sequenced after (A) per the Symlink Safety ordering note above, if both are
included in the same phase.

## Rollback / Failure Considerations

Each of (A)/(B)/(C)/(D) is independently revertable (a single commit each, per this project's
established git discipline of focused commits). (B) carries the highest real-mode operational risk
(an under-scoped allow-list breaking the real CLI) — if manual real-mode validation surfaces a
missing required variable, the fix is to add that specific key to the allow-list, not to revert to
full inheritance.

## Next Steps

Awaiting developer approval on scope: (A)+(B)+(C) as the core proposal, with (D) as an explicit
opt-in addition. No implementation, commit, or push will occur until approved.

DO NOT IMPLEMENT
