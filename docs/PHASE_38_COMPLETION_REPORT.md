# Phase 38 Completion Report — Requirement Docs From The Repository

**Status**: Complete.

## Problem

The developer already documents requirements/task lists inside their own repos (e.g.
`docs/login-flow.md`) and didn't want to re-paste that content into the requirement field. Two
shapes were discussed: pointing the task at specific doc paths already in the repo, or a generic
file-upload mechanism. This phase implements the first (smaller, reuses existing repository access,
no new storage/parsing/security surface) and defers the second as explicitly out of scope.

A real gap existed even for real-mode tasks that already describe "read this file" in prose: Claude
Code can already open a named file live during `analyze()`/`implement()`, but **routing** — the
deterministic, pre-execution stage that decides which specialists even run — only ever saw
`task.requirement`'s raw text. A stack/database keyword sitting only inside a referenced doc was
invisible to routing, which could route incorrectly or escalate unnecessarily.

## Implementation

- `Task.requirementDocPaths?: string[]` (input, repo-relative) and `Task.requirementDocs?:
  RequirementDocExcerpt[]` (result, read once).
- New `server/src/orchestrator/requirementDocs.ts`: `readRequirementDocs()` resolves each path,
  refuses traversal (`resolveWithinRoot`-style containment) and symlink escapes (`fs.realpath`,
  Phase 35's convention — **both** the candidate and the repository root are realpath'd before
  comparing, since the root itself can sit under a symlink, e.g. macOS's `/tmp` → `/private/tmp`;
  an early version of this check compared a realpath'd candidate against a non-realpath'd root and
  false-positived on exactly that case, caught by writing a real-symlink test rather than a mocked
  one). Bounded to `config.maxRequirementDocChars` (default 20,000, `MAX_REQUIREMENT_DOC_CHARS`) per
  doc, truncated explicitly, never silently. A missing/unreadable doc becomes a `readError` string,
  never a thrown exception — one bad path never blocks the others.
- `combinedRequirementText()` — the requirement plus every successfully-read doc's content, used
  wherever a keyword-driven decision happens.
- Read once, at inspection time (`TaskOrchestrator.inspect()`), before routing runs — persisted on
  the task, published as a new `REQUIREMENT_DOCS_READ` event, and never re-fetched later, so
  routing/specialists/planning all reason over the exact same snapshot.
- `routeTask()` now reasons over `combinedRequirementText()` instead of the raw requirement string —
  closes the routing-blindness gap directly.
- `RealClaudeCodeExecutor`: a new `REQUIREMENT_DOCS_TRUST_FRAME` (repository-controlled content,
  same caution as `detectedStack`) spliced into `analyze()`, `implement()`, and `decideDirection()`'s
  prompts.
- `MockClaudeCodeExecutor`: `decideDirection()`'s keyword heuristic now scans doc content too;
  `analyze()` notes how many docs were incorporated (same pattern as its existing memory-context
  note).
- Frontend: a "Requirement docs already in the repository" textarea on Create Task (comma/newline
  separated, parsed client-side); a Task Detail card showing each doc's path, read status
  (read/truncated/not-read with the error), reusing existing badge styles.

## Testing

- `requirementDocs.test.ts` (8 tests): real-fs reads, truncation, missing file, path-traversal
  refusal, and — the one that caught a real bug — a genuine symlink pointing outside the repo,
  refused correctly only after fixing the root-realpath comparison above.
- `routingEngine.test.ts` (+2 tests): a doc-only stack signal resolves routing correctly with no
  signal in the requirement field at all; a failed doc read still escalates (contributes nothing).
- `requirementDocsPipeline.test.ts` (1 test): real HTTP → real orchestrator → real bare repo (no
  manifest) with a doc naming FastAPI/PostgreSQL — proves routing actually resolves from the doc in
  the real pipeline, not just the unit-level routing function, plus the `REQUIREMENT_DOCS_READ`
  event and per-doc read status on the persisted task.
- Backend `vitest`: **244 passed** (38 files), up from 233. Frontend `jest`: **66 passed**, up from
  64. `npm run build` and `npm run lint` both clean.

## Known Limitations

- No upload mechanism — only paths already inside the target repository. Explicitly deferred.
- Free-form "go through this folder and figure it out" (no named path at all) still relies on
  Claude's own live repository read during real-mode `analyze()`/`implement()`, same as before this
  phase — this phase only fixes the *routing-blindness* half of that gap, not a full folder-scan
  feature.
- `decideConflictResolution()` (Phase 37) and reconciliation itself don't separately re-embed
  requirement docs — they already operate on specialist reports, which reflect this context
  indirectly via `analyze()`.
