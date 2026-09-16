# ADR 0009 — The reviewer and the developer see a bounded, ground-truth diff patch, not just file counts

**Status**: Accepted (Phase 33)

## Context

Since Phase 28, real-mode execution has computed `changedFiles`/`diff` from an actual `git diff`
of the isolated worktree — explicitly *not* from Claude's self-reported JSON — documented as the
platform's evidence-first principle ("ground truth over self-report"). Phase 33's platform review
(`docs/PHASE_33_PLATFORM_REVIEW.md`) found that this principle was honored for *which* files
changed but not for *what* changed inside them: `GitWorktreeManager.diff()` only ever ran
`git diff --numstat` (path, additions, deletions), and the specialist reviewer's prompt
(`RealClaudeCodeExecutor.review()`) only ever received a file list and test-result JSON — never the
patch itself. The reviewer *could* independently inspect the real diff (it runs with live repo
access, `--permission-mode plan`), but nothing in the platform required or verified that it did,
and the Task Detail UI showed only a single aggregate summary string even though the backend's
`ExecutionDiff.files` already modeled per-file counts nobody rendered.

This was identified as the sharpest concrete gap between what the platform's own architecture
implies about its review loop and what the code actually guarantees — and, being contained to one
capture method, one prompt, and one UI panel, the smallest of the candidates evaluated in
`docs/PHASE_33_PROPOSAL.md`.

## Decision

- **`GitWorktreeManager.diff()` additionally captures the actual unified-diff patch text**
  (`git diff <base> HEAD`, no `--numstat`), alongside the existing per-file counts and summary.
  Skipped when there is nothing to diff (`files.length === 0`), matching the existing "no changes"
  short-circuit.
- **The patch is bounded, not unlimited.** `config.maxDiffPatchChars` (`MAX_DIFF_PATCH_CHARS`,
  default 200,000 characters) caps what's captured/stored/prompted. A patch under the bound is
  stored in full. A patch over the bound is cut — preferring a whole `diff --git` file-section
  boundary within budget over a mid-hunk cut, falling back to a hard character cut only when even
  the first file's section alone exceeds the bound — and `truncated` is set `true`.
  `totalPatchChars` always records the full, untruncated length regardless of truncation, so a
  reader can show "showing X of Y" without ever inventing a total.
- **Truncation is never silent.** A truncated patch carries an explicit
  `--- diff truncated: exceeded the platform's maximum diff size ---` marker in the stored text
  itself; the review prompt gets an explicit `WARNING:` line telling the reviewer not to assume
  omitted sections are correct; the Task Detail UI shows a visible "Diff truncated — showing X of Y
  characters" notice and labels the collapsible patch view "(truncated)".
- **The review prompt embeds the bounded patch directly, framed as untrusted data.** Repository
  content read by the `claude` CLI is not a trusted input channel anywhere in this platform (Phase
  33's review named this as an existing, unmitigated attack surface). Rather than pretend a diff is
  any different, the prompt explicitly labels it "UNTRUSTED REPOSITORY CONTENT / CODE DIFF" and
  instructs the reviewer to treat everything inside it — comments, strings, file content — as data
  to inspect, never as instructions to follow. This narrows exposure for this one channel; it is
  not offered as, and does not function as, a general prompt-injection solution for the rest of the
  pipeline.
- **The patch is not duplicated into SSE events or the on-disk event log.** `IMPLEMENTATION_COMPLETED`'s
  `data.diff` carries the same metadata it always did (`baseRevision`, `branch`, `files`, `summary`)
  plus the new `truncated` flag, but never `patch`/`totalPatchChars`. `execution-report.json` (served
  via `GET /tasks/:id/execution-report`) is the one canonical, already-existing location for the
  patch; the frontend already fetches it there independently of the event stream, and the event
  stream's own role (per `docs/PHASE_33_PLATFORM_REVIEW.md` §14) is "something changed, refetch," not
  "carries the payload to render." Repeating a potentially large, bounded-but-still-sizable patch into
  every event and every line of the event log would be pure storage/bandwidth bloat for a reader that
  doesn't exist.
- **No new endpoint.** The patch travels through the existing `ExecutionReport`/`GET
  /tasks/:id/execution-report` response, extending the existing `ExecutionDiff` type
  (`patch`, `truncated`, `totalPatchChars`) rather than introducing a parallel structure or a new
  route — consistent with the smallest-model principle already applied in ADR 0007/0008.
- **`FinalHandoff.diffTruncated` is optional, not migrated.** New handoffs always set it explicitly
  (`executionReport.diff?.truncated ?? false`); handoffs written before this phase simply lack the
  field, read correctly as "unknown," and need no backfill — the same no-migration reasoning ADR
  0008 applied to `cleanupStatus`.
- **`GitWorktreeManager.diff()`'s new third parameter (`maxPatchChars`) defaults to 200,000**, so
  every pre-existing caller and test keeps working unchanged; real callers pass
  `config.maxDiffPatchChars` explicitly.

## Alternatives considered

- **Unlimited patch capture**: rejected outright — an arbitrarily large implementation pass would
  produce an arbitrarily large prompt, artifact, and UI payload with no bound, the exact failure
  mode the phase brief called out as mandatory to avoid.
- **A separate `GET /tasks/:id/diff` endpoint / a sibling `diff.patch` artifact file**: considered,
  rejected for this milestone. `execution-report.json` was already the canonical, already-fetched
  location for diff metadata; extending its existing schema kept the change contained to one type
  and avoided a second artifact-consistency concern (two files that could theoretically disagree)
  for a bound (200,000 characters) comfortably within normal JSON-file artifact sizes elsewhere in
  this codebase.
- **Streaming the full patch through SSE events for "true live" diff rendering**: rejected. The
  platform's existing SSE contract is "event → frontend refetch," not "event carries the render
  payload" (confirmed by direct inspection — the frontend already discards most event `data` outside
  the raw log). Changing that contract for one feature, and paying a real per-event bandwidth/storage
  cost for a bounded-but-still-potentially-large blob, wasn't justified by anything this phase needed.
- **A complete secret-scanning/redaction pass over captured patches**: rejected as out of scope
  (explicitly listed as a non-goal in the approved phase prompt). Redacting patch content by default
  would undermine the ground-truth guarantee this phase exists to strengthen; the risk (a patch may
  contain a secret introduced by the underlying change) is the same category of risk already accepted
  for other stored artifacts (e.g. `TestRunResult.evidenceRef`, which already stores up to 4,000
  characters of raw test output verbatim), not a new one this phase introduces.
- **A full diff-parsing/AST-aware truncation strategy** (e.g. always keep complete hunks, never cut a
  file section partway): considered, rejected as disproportionate. A `diff --git` file-boundary
  preference, falling back to a deterministic character cut, satisfies "never silent, reasonably
  readable" without building a diff parser this platform doesn't otherwise need.

## Consequences

- A reviewer's PASS/FAIL verdict can now be checked against what it was actually shown — the exact
  bounded patch text is inspectable via `execution-report.json`, closing the gap where a reviewer's
  basis for a verdict was previously invisible.
- A genuinely huge implementation pass (rare, but possible — a large generated file, a broad
  refactor) produces a truncated patch rather than an unbounded one; the full change remains
  available by checking out the task branch, exactly as it always was for any other diff inspection.
- Prompt size for the real-mode review call grows by up to `MAX_DIFF_PATCH_CHARS` — bounded and
  configurable, but a real, non-zero increase in tokens sent per review call compared to before this
  phase.
- The "untrusted content" framing in the review prompt is a narrowing of one specific exposure, not
  a fix for the platform's broader, still-open prompt-injection surface (`docs/PHASE_33_PLATFORM_REVIEW.md`
  §12) — this ADR does not claim otherwise.
