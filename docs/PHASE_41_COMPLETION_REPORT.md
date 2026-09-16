# Phase 41 Completion Report — Live Implementation Progress Streaming

**Status**: Complete. **Real-CLI validated end to end** — the first phase in this whole autonomy/
decomposition/streaming sequence (36, 37, 39, 41) to be validated against the actual `claude` CLI,
not just mock fixtures.

## Problem

The developer's original ask was to watch agents' status and, specifically, code being written live.
Phase 40 covered status/timing from data the platform already had. This phase covers the harder
half: today, `implement()` is one opaque batch `claude -p ... --output-format json` call — nothing
streams back until it's fully done or times out. Scoped deliberately to `implement()` only, not
`analyze()`/`review()`/the autonomous decision methods — "watching code get written" is specifically
about implementation.

## Grounding the design in the real CLI, not assumptions

Before writing any code, `claude --help` was checked for actual streaming support, then two cheap,
real probe calls were run against the live `claude` CLI (v2.1.236) — one trivial prompt, one that
writes a file — to capture the *actual* `--output-format stream-json` NDJSON line shapes verbatim.
Key findings that shaped the design:

- The terminal `"result"` line is structurally identical to the single-object envelope
  `--output-format json` already produces (`{result, subtype, ...}`) — so it can be handed to the
  exact same `parseResultText()`/`extractJsonPayload()` this platform already uses, unchanged.
- Fully-formed `"assistant"` message lines (with complete `content` blocks, including `tool_use`
  with a resolved `input.file_path`) arrive without `--include-partial-messages` — that flag only
  adds the intermediate `content_block_delta` fragments. Since this platform only needs "which tool,
  touching what," not character-by-character text deltas, that flag was deliberately omitted,
  simplifying the parser and reducing event volume.

## Implementation

- New `server/src/execution/streamJsonParser.ts` — `parseStreamJsonLine()`, a standalone, pure
  function parsing one NDJSON line into either progress events (from an `"assistant"` line's
  `tool_use`/`text` content blocks) or the terminal result line. Never throws on malformed/
  unrecognized input.
- `ClaudeCodeExecutor.ImplementParams` gained an optional `onProgress?: (event) => void`, called
  synchronously as progress happens. `MockClaudeCodeExecutor` needed zero changes (optional field,
  never called — mock execution has nothing real to report).
- `RealClaudeCodeExecutor` gained `runClaudeCliStreaming()`, used only by `implement()`: spawns
  `claude` with `--output-format stream-json --verbose` instead of `--output-format json`, buffers
  stdout by line, calls `onProgress` per parsed progress event, and resolves with the terminal
  result line once found — same return contract (`{stdout, durationMs}`) as the existing batch
  method, so nothing downstream of `parseResultText()` needed to change. Flushes any unterminated
  final line on process close (a real line-buffering bug caught by this phase's own fixture tests —
  NDJSON's last line is not guaranteed to end with `\n` before the process exits).
- `TaskOrchestrator` gained `makeProgressCallback()`, wiring the executor's progress callback to a
  new `IMPLEMENTATION_PROGRESS` event published through the existing `TaskEventBus` — reusing the
  platform's own SSE transport unchanged; the frontend didn't need a new streaming mechanism, only a
  new event type to filter and render. Threaded through both the initial `implement()` call and the
  corrective-pass call inside `reviewLoop()`.
- **A second real bug, caught by a genuinely flaky test, not assumed away**: `onProgress` fires
  synchronously, potentially many times in a burst, and `publish()` itself is async
  (`appendFile`-based). Multiple unawaited `publish()` calls have no ordering guarantee relative to
  each other — Node's libuv thread pool doesn't promise FIFO completion for concurrent filesystem
  calls. `makeProgressCallback()` now returns `{ onProgress, drain }`: `onProgress` chains each
  publish onto one queue promise (serializing the actual writes into call order without ever
  blocking the synchronous caller), and the orchestrator `await`s `drain()` before publishing
  `IMPLEMENTATION_COMPLETED` — closing a second race where the very last progress event could
  otherwise land *after* the completion event. Caught by running the new test ten times, not once.
- Frontend: a "Live Implementation Progress" card on Task Detail, filtering the same generic
  `events` signal every other panel already reads (no new subscription), with a per-tool icon and a
  pulsing "● live" indicator while `currentStage === 'implementing'`.

## Testing

- `streamJsonParser.test.ts` (8 tests) — every fixture line is copied verbatim from the two real CLI
  probe captures, not hand-written guesses: a real `Write` tool_use, a real text block, a real
  `thinking` block (ignored), the real terminal result line, real `system`/`rate_limit_event`/`user`
  lines (ignored), a `Bash` command fallback, malformed/empty input, and multiple content blocks in
  one line.
- `implementationProgress.test.ts` (1 test) — drives the real orchestrator with a scripted executor
  that calls `onProgress` three times synchronously, asserting the events land in order and strictly
  between `IMPLEMENTATION_STARTED`/`IMPLEMENTATION_COMPLETED`. This test caught both real bugs above
  during development (first the ordering race, then — after the naive fix — the completion race) via
  genuine intermittent failures, not by inspection; fixed and then run 10 consecutive times clean
  before trusting it.
- 2 new frontend tests: filtering progress events out of the generic stream, and per-tool icon
  selection.
- Backend `vitest`: **259 passed** (41 files), run 3 consecutive times for stability given the
  concurrency fix. Frontend `jest`: **75 passed**.
- `npm run build` and `npm run lint`: both clean.

## Real-CLI end-to-end validation (not mock, not simulated)

Launched an isolated real-mode server instance against a genuine small git repo (`express` +
`src/index.js`) and ran a real task ("add a GET /health route") through the actual pipeline:

- Polled the live event log during execution: `progress_events` went `0 → 0 → 2 → 3` while
  `status: "implementing"`, then held steady at `3` through `reviewing` and `completed` — proving
  the drain-before-completion fix holds under real, not simulated, timing.
- The three captured events were genuine: `Read: .../workspace/src/index.js`,
  `Edit: .../workspace/src/index.js`, and the model's own closing text.
- Verified the actual filesystem effect: the isolated worktree's `src/index.js` had the real
  `/health` route added; the *original* repository at `/tmp/phase41-repo` was untouched, confirming
  Phase 28's isolation guarantee held through this change; `git log` on the isolated branch showed
  the real commit.

## Known Limitations

- **The final progress event is often the model's raw JSON answer, not a human summary.** Because
  `implement()`'s prompt asks Claude to respond with *only* a JSON object, its last `"text"` content
  block — surfaced as a progress event like any other text block — is frequently that same JSON
  dump, which reads as noisy technical output rather than a useful "here's what I did" line. Not
  filtered out: a heuristic guess at "this text block looks like the final structured answer, skip
  it" risks silently dropping genuinely useful commentary in other cases. Left as an honest,
  observed cosmetic imperfection rather than a guessed fix.
- **No auto-scroll.** The progress log panel is a fixed-height, manually-scrollable list, matching
  the existing activity-log panel's convention — during a long implementation pass, the developer
  must scroll down to see the latest entries rather than having the view follow automatically.
- **`analyze()`/`review()`/the autonomous decision and decomposition methods remain batch, non-
  streaming**, unchanged — explicitly out of scope. A developer watching a task in `analyzing` or
  `reviewing` stage still sees nothing live for that stage.
- Streaming mode does not itself change what gets committed or how `runTests()` works — only how
  the developer *observes* the implementation pass while it happens.

## Next Recommended Milestone (proposed, not implemented)

With this phase's real-CLI validation succeeding, the original developer-asked sequence (requirement
docs → backlog decomposition → live dashboard → live streaming) is now complete end to end and each
piece has at least one real-CLI-validated data point. Remaining named candidates from earlier phases,
unchanged: review-stage conflict arbitration (Phase 37's extension), and re-running the
School-Management-Backend real-mode test now that both decomposition (Phase 39) and live streaming
(this phase) exist, to see how much closer a genuine greenfield build gets to completing in one
session.
