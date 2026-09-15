# Engineering Memory — First Real Loop (Phase 29)

This document explains how the platform's memory layer actually works, honestly: what it remembers, what it forgets on purpose, what a human has to do before it influences anything, and where its current edges are.

## The loop, in one picture

```
Task A completes
      |
      v
Candidate lesson generated (from a reconciliation decision)
      |
      v
Developer reviews it in the Memory UI  --[reject]--> stays out of retrieval forever, kept for audit
      |
   [approve]
      |
      v
Validated memory
      |
      v
Task B (same/similar repository & stack)
      |
      v
Memory retrieval -> Context Pack -> per-agent filtering -> Specialist analysis
```

Nothing a task produces influences a later task automatically. The only path from "the system noticed something" to "a specialist sees it" runs through a human clicking Approve.

## Memory types

| Type | Written by | Auto-retrieved? |
|---|---|---|
| `task_history` | — (not written into the memory store) | — |
| `project_memory` | — (not auto-written this phase) | if present |
| `global_knowledge` | — (not auto-written this phase) | if present |
| `candidate_lesson` | the orchestrator, after a task completes | never |
| `validated_lesson` | a human, by approving a candidate | yes |

**Task history is not duplicated into the memory store.** Every task's full artifact trail already lives at `tasks/<task-id>/` — that *is* task history. Writing a second copy into `MemoryStore` would violate the orchestrator's own contract ("do not duplicate repository source into memory unnecessarily," `ORCHESTRATOR.md`). `project_memory` and `global_knowledge` remain reserved taxonomy values for future manual curation; this phase does not write them automatically — see "Known limitations."

## Retrieval: the trust boundary lives in the store

```ts
retrieve(query): Promise<MemoryRetrievalMatch[]>
```

`JsonFileMemoryStore.retrieve()` hard-filters to `validationStatus === "validated"` **before** it scores anything. This isn't a convention callers have to remember — a candidate lesson cannot come back from `retrieve()` no matter how well it would score, because the filter runs first. That's the actual trust boundary, not a comment or a UI-level check.

Scoring (simple, explicitly replaceable — not a vector/RAG system):

```
score = (technologyOverlap * 3 + keywordOverlap) [only if > 0] + scopeBonus + taskTypeBonus, all × confidence
```

Scope/taskType bonuses are tie-breakers among already-relevant items, not qualifiers — an item with zero technology or keyword overlap with the current task never surfaces just because it happens to share a repository.

## Context Pack

`buildContextPack(task, detectedStack, memoryStore)` runs once per task, right after routing (task scope is known) and before specialist analysis:

1. Queries `retrieve()` with the task's requirement text, repository path (as scope), and detected stack technologies.
2. Keeps the top 3 matches as **included**; anything else retrieved (up to a fetch limit of 8) is recorded as **excluded**, purely for observability — you can see what almost made it in.
3. Flags a **conflict** when an included item names a different database than the repository's own detected evidence (e.g. a memory item about MongoDB, applied to a Postgres repository). The conflict is recorded, never silently resolved — **repository evidence always wins**. Nothing is filtered out or overridden on the basis of a conflict; it's surfaced for a human to see.
4. The whole pack is written verbatim to `tasks/<task-id>/context/memory-retrieval.json` and served via `GET /api/tasks/:id/memory`.

## Per-agent filtering

Not every specialist gets every included memory item. `memoryForAgent(agent, pack)` keeps an item only if its `technology` tags overlap that agent's family (Postgres/MongoDB/etc. tags → the Database agent; Node/Express/TypeScript tags → the Node agent; and so on), or if the item has no technology tag at all (treated as general guidance that reaches everyone). A Postgres-specific lesson does not reach a Node-only analysis call, and vice versa.

Both executors actually use this:

- **Mock executor** appends a visible, testable line to the specialist report's `assumptions`: `"Incorporated N relevant validated memory item(s): ..."` — this is what the end-to-end memory-loop test asserts against, proving the context isn't just computed and discarded.
- **Real executor** appends a "Relevant validated engineering memory" section to the actual prompt sent to the `claude` CLI, explicitly stating that current repository evidence takes precedence if it conflicts.

## Candidate lesson generation

Runs once, only for tasks that reach `completed` (never `blocked`/`failed`). Each `ArchitectureDecision` in the task's reconciliation with `confidence >= 0.6` becomes one `candidate_lesson`, using data the system already produced — no new decision-capture mechanism was needed:

```
content    = "<decision> — <rationale>"
provenance = { taskId, agent: decision.owner, artifact: "reconciliation.json", decision: decision.decision }
```

Before a candidate is persisted, its content is checked against a sensitive-content filter (`containsSensitiveContent`): private-key headers, AWS access key IDs, and `password=`/`token=`/`secret=`-shaped assignments all cause the candidate to be **skipped entirely**, not redacted. Zero candidates generated for a task is an expected, valid outcome — not an error — and is published as `CANDIDATE_LESSONS_GENERATED` with `count: 0`.

## Human approval

`POST /api/memory/:id/approve` — becomes `validated_lesson` / `validationStatus: "validated"`, stamped with `provenance.approvedAt`/`approvedBy` (free text; this MVP has no auth system, so it defaults to `"developer"`).

`POST /api/memory/:id/reject` — `validationStatus: "rejected"`. **Never deleted** — it stays visible in the Memory UI's Rejected section for audit, permanently excluded from retrieval by the store's own hard filter.

`PATCH /api/memory/:id` — edits `content`/`technology`/`taskType`, sets `provenance.humanEdited: true`. Independent of approve/reject — a lesson can be edited before or after a decision.

## UI

`/memory` — overview counts (Validated / Candidate / Rejected), candidate cards with Approve/Edit/Reject, a validated list with provenance (source task link, approver, whether a human edited it), and a rejected list for transparency. Deliberately not a knowledge-management application: no search, no tagging UI, no bulk actions — just enough to review and decide.

Task Detail's **Memory** panel (visible from the `analyzing` stage onward) shows retrieved/included/excluded counts, any conflicts, and exactly which memory entries were handed to specialists and why (`reason` = the scoring signals that matched, e.g. `technology:postgresql, keyword:pagination`).

## Security / privacy

- The sensitive-content filter runs before a candidate is ever written to disk, not just before display.
- `scope` is always a repository path or `"global"` — nothing in this phase ever promotes project-scoped memory to global scope automatically.
- Memory API responses contain only lesson text a human already approved or is being asked to approve — never raw repository file contents.
- `MemoryProvenance` is additive-only from the API's perspective: no endpoint lets a client rewrite `taskId`/`artifact`/`approvedAt` directly.

## Storage

Still the JSON-file store (`data/memory.json`) behind the `MemoryStore` interface, per the same "don't introduce infrastructure the MVP doesn't need" reasoning as the task store. The interface itself (`get`/`list`/`update`/`retrieve`) is the swap point for a future database-backed or embeddings-backed implementation — nothing above it needs to change.

## Known limitations

- **`task_history`/`project_memory`/`global_knowledge` are not auto-written.** Task history is covered by the existing artifact trail; project/global knowledge remain reserved for future manual curation. There is currently no UI path to seed them.
- **No automatic project → global promotion.** A lesson approved for one repository stays scoped to that repository; nothing currently proposes "this looks broadly applicable."
- **Candidate technology tags reflect the whole detected stack, not the owning specialist's slice.** A lesson generated from the Node agent's decision and one from the Database agent's decision, on the same task, get identical technology tags (the full stack) — so both may end up relevant to more than one agent on a later task. This is a reasonable default (a pagination lesson plausibly matters to both layers) but is a simplification worth knowing about.
- **No staleness/revalidation policy is enforced**, only the metadata (`createdAt`/`updatedAt`) to support one later. A validated lesson stays authoritative indefinitely unless a human rejects it.
- **No semantic/vector retrieval.** Scoring is technology-tag + keyword overlap, exactly per this phase's scope — explicitly the seam a future embeddings-backed store would replace.
- **No auth system**, so `approvedBy` is free text, not a verified identity — consistent with the rest of this MVP's single-developer, no-auth scope.
