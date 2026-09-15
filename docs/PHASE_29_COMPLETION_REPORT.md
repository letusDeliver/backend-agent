# Phase 29 Completion Report — Memory: First Real Loop

Status: **Complete**. All work described in `docs/PHASE_29_IMPLEMENTATION_PLAN.md` was implemented and tested. The full existing suite plus 29 new backend tests and 3 new frontend tests all pass; the E2E suite is unchanged and green.

## Summary

`MemoryStore` existed since the MVP but was referenced nowhere outside `container.ts` — a fully-typed, storage-complete subsystem sitting at zero product value. Phase 29 wires it into orchestration for the first time: every task now retrieves relevant validated memory before specialist analysis, a completed task can generate candidate lessons from its own reconciliation decisions, and — critically — **nothing a task produces influences a later task until a human approves it**. The end-to-end test proving this loop actually closes (candidate → approval → retrieval on a later task) is the centerpiece of this phase's testing.

## Architecture

```
Task Created -> Repository Inspection -> Routing (agents/scope known)
        |
        v
Memory Retrieval (MemoryStore.retrieve(), hard-filtered to validated items only)
        |
        v
Context Pack (top 3 included, rest recorded as excluded, conflicts flagged
              against repository evidence, written to
              tasks/<id>/context/memory-retrieval.json)
        |
        v
Per-agent filtering (memoryForAgent) -> Specialist Analysis (memory visibly
              incorporated into the report, not silently dropped)
        |
        v
   ... reconciliation / plan / implement / review / handoff (unchanged) ...
        |
        v
Task Completed -> Candidate Lesson Generation (from reconciliation decisions,
              confidence >= 0.6, sensitive-content filtered)
        |
        v
Developer reviews in /memory UI -> Approve / Edit / Reject
        |
        v
   [Approve] -> Validated Memory -> retrievable by a later task
   [Reject]  -> kept for audit, permanently excluded from retrieval
```

## Retrieval flow

`TaskOrchestrator.retrieveMemory()` runs once per task, immediately after routing and before `analyze()`. It calls `buildContextPack()`, which calls `MemoryStore.retrieve()` — the trust boundary is enforced **inside the store**, not by callers remembering to filter: `retrieve()` hard-filters to `validationStatus === "validated"` before it scores anything, so a candidate lesson cannot come back through this path no matter how well it would score.

Scoring is deliberately simple and explicitly replaceable (Phase 29 brief section 9): `(technology overlap × 3 + keyword overlap) × confidence`, with scope/taskType as tie-breakers applied only once there is already nonzero content relevance — a memory item sharing a repository but with zero technology/keyword overlap does not surface just for being in the same repo. This was caught by a test that initially failed against a looser first implementation (see Testing below).

## Context-pack behavior

- Top 3 matches (of up to 8 retrieved) are **included**; the rest are recorded as **excluded**, purely for observability.
- A memory item that names a different database than the current repository's own detected evidence is flagged as a **conflict**, never silently trusted or filtered — repository evidence always wins, and the conflict is visible in both the artifact and the Task Detail UI.
- Persisted verbatim to `tasks/<task-id>/context/memory-retrieval.json` and served via `GET /api/tasks/:id/memory`.
- `memoryForAgent(agent, pack)` filters further per specialist: a Postgres-tagged item reaches the Database agent, not a Node-only analysis call; a tag-less item (general guidance) reaches every agent.

Both executors visibly use the result, not just receive it as a dead parameter: `MockClaudeCodeExecutor.analyze()` appends `"Incorporated N relevant validated memory item(s): ..."` to the report's `assumptions` (this is what the end-to-end test asserts against), and `RealClaudeCodeExecutor.analyze()` appends a "Relevant validated engineering memory" section to the actual CLI prompt.

## Candidate lesson lifecycle

`generateCandidateLessons()` runs once, only when a task reaches `completed` (never `blocked`/`failed`). Each `ArchitectureDecision` in the task's reconciliation with `confidence >= 0.6` becomes one candidate, reusing data the system already produced — no new decision-capture mechanism was needed. Provenance is `{ taskId, agent: decision.owner, artifact: "reconciliation.json", decision: decision.decision }`.

Before persisting, content is checked by `containsSensitiveContent()` — private-key headers, AWS access key IDs, `password=`/`token=`/`secret=`-shaped assignments all cause the whole candidate to be skipped (never redacted). Zero lessons generated is a valid, expected outcome, published as `CANDIDATE_LESSONS_GENERATED` with `count: 0`.

## Approval workflow

- `POST /api/memory/:id/approve` — `type` becomes `validated_lesson`, `validationStatus` becomes `validated`, `provenance.approvedAt`/`approvedBy` stamped. `409` if already validated.
- `POST /api/memory/:id/reject` — `validationStatus` becomes `rejected`. **Never deleted** — stays visible for audit, permanently excluded from retrieval by the store's own hard filter.
- `PATCH /api/memory/:id` — edits `content`/`technology`/`taskType`, sets `provenance.humanEdited: true`.

## Provenance model

Every candidate/validated item's `provenance` answers: which task produced it (`taskId`), which specialist (`agent`), what artifact it was derived from (`artifact: "reconciliation.json"`), and the specific decision text (`decision`). Approval adds `approvedAt`/`approvedBy`; rejection adds `rejectedAt`; a human edit sets `humanEdited: true`. None of these fields are directly writable by a client — only reachable through the approve/reject/edit actions themselves.

## Storage

Unchanged storage choice (`data/memory.json` behind `MemoryStore`), per the same "don't introduce infrastructure the MVP doesn't need" reasoning as the task store. `MemoryItem` gained trust metadata (`validationStatus`, `technology`, `taskType`, structured `provenance`) — a clean extension, not a migration, since no memory data had ever been written before this phase. `approved_lesson` was renamed `validated_lesson` for the same reason.

## UI

`/memory` — overview counts (Validated / Candidate / Rejected), candidate cards with Approve/Edit/Reject and full provenance, a validated list, and a rejected list for transparency. Task Detail gained a Memory panel (retrieved/included/excluded counts, conflicts, why each item was included) visible from the `analyzing` stage onward.

## API

```
GET  /api/tasks/:id/memory        Context pack for a task
GET  /api/memory                  List (optional ?type=&validationStatus=&scope=)
GET  /api/memory/candidates       Shorthand for ?validationStatus=candidate
GET  /api/memory/:id              Single item
POST /api/memory/:id/approve      Candidate -> validated
POST /api/memory/:id/reject       Candidate -> rejected (kept, excluded from retrieval)
PATCH /api/memory/:id             Edit content/technology/taskType
```

## Testing

```
Backend (vitest):  101 passed (was 72)
  + memoryStore.test.ts        7  — technology-relevant retrieval, irrelevant-item exclusion,
                                     global-scope inclusion, hard validation-status filter
                                     (a candidate never returns even if it would score highest),
                                     project-over-global scope tie-breaking, CRUD
                                     (caught two real bugs before they shipped: an aliasing bug
                                     where update() mutated the same object a caller's earlier
                                     add() call was still holding a reference to, and a scoring
                                     bug where scope/taskType bonuses alone — with zero
                                     technology/keyword overlap — were enough to surface an
                                     unrelated item; both fixed before merging)
  + contextPack.test.ts         5  — included/excluded counts, conflict flagging against
                                     repository evidence, no-conflict-when-agreeing, per-agent
                                     technology filtering (including tag-less general lessons
                                     reaching every agent)
  + candidateLessons.test.ts    8  — provenance correctness, confidence threshold, no
                                     reconciliation -> no lessons, sensitive-content filtering
                                     (private key headers, AWS access key IDs, password/token/
                                     secret-shaped assignments all verified to actually block
                                     candidate generation, not just get flagged)
  + memoryApi.test.ts           7  — approve/reject/edit over real HTTP, already-validated/
                                     already-rejected 409s, a rejected item verified absent from
                                     retrieve() (not just absent from a list endpoint)
  + memoryLoop.e2e.test.ts      2  — the most important test in this phase: Task A completes ->
                                     candidate generated -> approved via the API -> Task B's
                                     specialist analysis provably receives it (asserted against
                                     the mock executor's own report content, not just "no error
                                     was thrown"); a second test proves a rejected candidate
                                     never reaches a later task's context pack
Frontend (jest):    16 passed (was 13)
  + memory.component.spec.ts    3  — overview counts render, approve()/reject() call through to
                                     the service and refresh the list
E2E (playwright):    1 passed (unchanged — mock-mode UI behavior, now including the Memory nav
                                     link and Task Detail memory panel, still zero console errors)
Full build:        clean (server tsc, ng build — 269.84 kB initial, effectively unchanged)
```

Two of the new tests caught real bugs before they shipped (noted above) — direct evidence the testing effort here wasn't pro forma, consistent with this project's standing practice.

## Limitations

- `task_history`/`project_memory`/`global_knowledge` are not auto-written into `MemoryStore` — task history is covered by the existing per-task artifact trail (writing a second copy would violate `ORCHESTRATOR.md`'s own "do not duplicate repository source into memory unnecessarily" rule); project/global knowledge remain reserved taxonomy values with no UI path to seed them yet.
- No automatic project→global scope promotion — a validated lesson stays scoped to the repository it came from.
- Candidate technology tags reflect the whole detected stack, not the owning specialist's slice, so a lesson from one agent's decision may end up judged relevant to a sibling agent on the same stack too (a reasonable default, documented as a simplification).
- No staleness/revalidation policy is enforced beyond the `createdAt`/`updatedAt` metadata that would support one later.
- Retrieval is technology-tag + keyword overlap, not semantic/vector search — explicitly this phase's scope; the seam (`MemoryStore.retrieve()`) is ready for a future embeddings-backed implementation.
- No auth system, so `approvedBy` is free text, not a verified identity — consistent with the rest of this MVP.

## Next recommended milestone

**Reconciliation `CONFLICT` detection** (tracked since the MVP as a P2 item, still unaddressed): the type system already defines `ReconciliationStatus.CONFLICT`, but no code path assigns it — two specialists materially disagreeing is currently indistinguishable from one of them simply failing. With memory now feeding into specialist context, this becomes more load-bearing: a validated lesson that nudges one specialist toward a recommendation the other specialist's fresh repository evidence contradicts is exactly the kind of disagreement `CONFLICT` was designed to surface, and today it wouldn't be. Not implemented here — this is a recommendation for the next phase, not a start on it.
