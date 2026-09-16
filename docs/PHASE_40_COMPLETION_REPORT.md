# Phase 40 Completion Report — Live Status Dashboard Upgrade

**Status**: Complete.

## Problem

The developer asked for a "great looking" dashboard showing agent status and timing. Scoped
deliberately narrow, per the earlier phase-breakdown discussion: a visual upgrade built entirely
from data the platform already produces (SSE event timestamps, specialist report timestamps) — no
backend architecture change, no new event type, no new artifact field. "Agents connecting to each
other" was explicitly *not* built, since specialists run independently and never communicate — a
literal connection-graph visualization would have misrepresented the actual architecture.

## Implementation

All timing is computed client-side in `task-detail.component.ts` from `TaskEvent.createdAt`
timestamps already present in the event log, and from `SpecialistReport.createdAt`:

- `sumPairedDurationsMs(events, startType, completeType)` — walks the event list once, summing every
  start/complete pair. Handles recurring pairs correctly (corrective implementation passes, Phase
  39's per-subtask implement/review cycles) by tracking the most recent unmatched start.
- `stageDurationLabel(stageKey)` — maps each pipeline stage to its start/complete event pair (or, for
  `routing`/`planning`, which have no dedicated start event, the completion timestamp of the
  preceding stage) and formats the result.
- `specialistDurationLabel(agent)` — a specialist's own analysis duration, from the shared
  `AGENT_ANALYSIS_STARTED` event to that specific agent's `SpecialistReport.createdAt`.
- `totalElapsedLabel()` — wall-clock time from `Task.createdAt` to the latest known event, shown as a
  badge in the task header; naturally updates live as new SSE events arrive via the existing
  `onEvent()` → `loadTask()` refresh path — no new polling or timer was added.
- `formatDurationMs()` — `"340ms"` / `"2.5s"` / `"1m 05s"`, degrading in the same order.

Template changes: a `⏱ <elapsed>` badge next to the status badge; a duration badge on each timeline
row once that stage has a start/complete pair; a CSS pulse animation on the active stage's icon (Phase
34's existing `stageState()` already computes which row is `active` — this only adds an animation on
top, no new logic); an "Analysis took `<duration>`" line on each specialist card once its report
exists, and an animated ellipsis on "Analyzing…" for one still in flight. `prefers-reduced-motion:
reduce` disables both animations.

## Testing

- 6 new tests in `task-detail.component.spec.ts`: a single stage duration from a real timestamp
  pair; summing a recurring pair (implementing across two passes) correctly; `null` (not a
  misleading `0`) when a stage has no timing signal yet; a specialist's own duration from the shared
  start event to its own report timestamp, and `null` for an agent with no report; sub-second/
  multi-minute formatting; and the elapsed-time badge computed from the latest event.
- Frontend `jest`: **73 passed**, up from 67.
- `npm run build` (frontend): clean.

## Manual verification (real browser, not just the build)

Started the actual dev stack (`npm run dev`, mock mode), created and ran a real task via the live
API, then drove a headless Chromium against `http://localhost:4300/tasks/<id>` with Playwright
(`playwright-core`, already a project dependency via the `e2e/` workspace) and screenshotted the
result:

- Task header: `⏱ 66ms` badge rendered next to the `COMPLETED` status badge.
- Execution Timeline: every completed stage showed its real duration (`1ms`, `0ms`, etc. — correctly
  tiny, since mock execution is synchronous; the point verified is that real per-stage timestamps
  drive this, not that mock mode produces large numbers).
- Specialist card (Node.js Backend, the one selected agent): "Analysis took 1ms" rendered under its
  findings/risks metrics.
- Zero browser console errors during the whole flow.

The pulsing active-stage animation was not (and could not usefully be) captured in this screenshot:
mock-mode tasks complete near-instantly, and a static screenshot freezes one animation frame
regardless of mode — verified by code review instead (the existing, already-tested `stageState()`
logic gates it, so it is exactly as reliable as which row currently renders `active`).

## Known Limitations

- Stage timing for `routing` and `planning` is derived from the *gap* between two adjacent stages'
  events, not a dedicated start event for that stage — accurate for the deterministic parts of
  routing, but if Phase 36's autonomous direction-decision arbitration adds real latency inside
  routing, that latency is folded into the "routing" bucket by construction; not separately
  attributed to "the autonomous decision call" specifically.
- No live-ticking clock — `totalElapsedLabel()` only advances when a new SSE event actually arrives
  (which is frequent during an active task, but a task idling with no new events for a while would
  show a stale elapsed time until the next event). Deliberately not adding a `setInterval` for this,
  to avoid new cleanup/lifecycle surface for a cosmetic-only figure.
- Timing figures are wall-clock, not CPU/API time — for real-mode tasks this includes any queueing
  or network latency in the `claude` CLI call, not just its actual working time. This is the correct
  figure for "how long did I wait," which is what this phase targeted.

## Next Recommended Milestone (proposed, not implemented)

Phase 41, already scoped in the earlier discussion: watching code appear as it's written, which
requires switching real-mode `implement()` from one opaque batch `claude -p ... --output-format json`
call to a streaming invocation and piping incremental tool-use events to the UI — a structurally
different, larger change than this phase's client-side-only timing work.
