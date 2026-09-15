# Phase 29 Implementation Plan — Memory: First Real Loop

## 1. What already exists (verified against code, not assumed)

- `server/src/memory/types.ts` — `MemoryType` (`global_knowledge | project_memory | task_history | candidate_lesson | approved_lesson`), a flat `MemoryItem` (id/type/scope/content/provenance-as-string/confidence/supersedes/createdAt), and a `MemoryStore` interface with `add`/`list`/`retrieve` (keyword-overlap).
- `server/src/memory/jsonFileMemoryStore.ts` — the only implementation, JSON-file backed, functionally complete for what the interface currently asks.
- `server/src/container.ts` — instantiates `memoryStore` but **nothing else in the codebase references it**. `grep -rn "memoryStore" server/src` outside `container.ts` returns nothing. This confirms the architecture review's finding: the memory layer is fully typed and has working storage, but is not part of orchestration at all.
- `ORCHESTRATOR.md` (the platform's own contract) lists as responsibility #3: "Retrieve relevant memory/context" — unimplemented until now.
- `data/memory.json` does not exist yet (nothing has ever been written) — there is no legacy data to migrate, so the storage shape can be extended freely this phase.
- The orchestrator (`taskOrchestrator.ts`) has a clean phase-by-phase structure (`inspect → route → [prepare workspace] → analyze → reconcile → plan → implement → review → handoff`) with an existing `ArtifactStore.writeContextSnapshot()` primitive already able to write arbitrary content under `tasks/<id>/context/` — the exact seam `tasks/<id>/context/memory-retrieval.json` (section 12 of the brief) needs.
- `ClaudeCodeExecutor.analyze()` takes a narrow `AnalyzeParams`; both `MockClaudeCodeExecutor` and `RealClaudeCodeExecutor` are small, readable, and easy to extend without restructuring.
- `ArchitectureDecision` (on `Reconciliation.decisions`) already carries `decision / alternatives / evidence / rationale / confidence / owner` — this is precisely the shape a "candidate lesson" needs for provenance, so no new decision-capture mechanism is needed; lessons are derived from data the system already produces.

## 2. Storage model (extended, not replaced)

`MemoryItem` gains explicit trust metadata instead of a single opaque `provenance: string`:

```ts
type MemoryType = "task_history" | "project_memory" | "global_knowledge" | "candidate_lesson" | "validated_lesson";
type MemoryValidationStatus = "validated" | "candidate" | "rejected" | "historical";

interface MemoryProvenance {
  taskId?: string; agent?: string; artifact?: string; decision?: string;
  humanEdited?: boolean; approvedAt?: string; approvedBy?: string; rejectedAt?: string;
}

interface MemoryItem {
  id: string; type: MemoryType; scope: string; content: string;
  technology: string[]; taskType?: string;
  validationStatus: MemoryValidationStatus;
  provenance: MemoryProvenance;
  confidence: number; supersedes?: string;
  createdAt: string; updatedAt: string;
}
```

`approved_lesson` is renamed `validated_lesson` (no stored data exists yet, so this is a clean rename, not a migration). `task_history`/`project_memory`/`global_knowledge` remain reserved taxonomy values for future manual curation; **this phase does not auto-write them** — see §10 (out of scope) for why duplicating the existing on-disk artifact trail into `MemoryStore` would violate `ORCHESTRATOR.md`'s own "do not duplicate repository source into memory unnecessarily" rule. Task history stays exactly what it already is: the artifact trail under `tasks/<id>/`.

`MemoryStore` gains `get`, `update`, and a richer `retrieve(query)`:

```ts
interface MemoryRetrievalQuery { text: string; scope: string; technology: string[]; taskType?: string; limit?: number; }
interface MemoryRetrievalMatch { item: MemoryItem; score: number; matchedOn: string[]; }
retrieve(query): Promise<MemoryRetrievalMatch[]>
```

**Trust is enforced inside the store, not left to callers**: `retrieve()` hard-filters to `validationStatus === "validated"` before scoring — a caller cannot accidentally pull in unapproved candidates through the retrieval path used for specialist context. Candidates are only ever reachable through `list({ validationStatus: "candidate" })`, used solely by the approval API/UI.

## 3. Retrieval scoring (deliberately simple, replaceable)

Per §9 of the brief, no vector/RAG system. Score = `(technology overlap × 3 + keyword overlap × 1 + scope bonus + taskType bonus) × confidence`, computed entirely inside `JsonFileMemoryStore.retrieve()`. This is the seam a future embeddings-backed store would replace — the `MemoryStore` interface itself does not change.

## 4. Orchestration integration point

Inserted into `TaskOrchestrator.run()` right after `routing.agents` is known (task scope is determined) and before `analyze()` — matching the brief's flow (`Detect Stack → Determine Task Scope → Retrieve Relevant Memory → Build Context Pack → Specialist Analysis`):

1. `buildContextPack(task, detectedStack, memoryStore)` — queries `retrieve()`, keeps the top 3 by score as "included", records the rest (up to a fetch limit of 8) as "excluded" for observability, and runs a lightweight conflict check (a memory item naming a database that disagrees with `detectedStack.database` is flagged, never silently trusted — repository evidence always wins per §11).
2. The pack is persisted verbatim to `tasks/<id>/context/memory-retrieval.json` (§12) via a new `ArtifactStore.writeMemoryRetrieval`/`readMemoryRetrieval` pair, and a `MEMORY_RETRIEVED` SSE event is published.
3. `AnalyzeParams` gains `memoryContext: ContextPackEntry[]`, computed **per agent** via `memoryForAgent(agent, pack)` — a Postgres-tagged item is not handed to a Node-only analysis call, and vice versa (§13); entries with no technology tag (general/global lessons) pass through to every agent.
4. Both executors are extended: `MockClaudeCodeExecutor.analyze()` appends a visible, testable line to `assumptions` when memory context is non-empty ("Incorporated N relevant validated memory item(s): ..."), and `RealClaudeCodeExecutor.analyze()` appends a "Relevant validated engineering memory" section to the actual CLI prompt. This is what makes retrieval observably real rather than a pass-through nobody reads.

## 5. Candidate lesson lifecycle

After a task reaches `completed` (handoff), `generateCandidateLessons(task, reconciliation, detectedStack)` turns each `ArchitectureDecision` with `confidence >= 0.6` into a `candidate_lesson` `MemoryItem` (`validationStatus: "candidate"`), with provenance pointing at `{ taskId, agent: decision.owner, artifact: "reconciliation.json", decision: decision.decision }`. Content is filtered through `containsSensitiveContent()` (regex heuristics for private keys, AWS access key IDs, `password=`/`token=`/`secret=`-shaped assignments) — a match silently skips that candidate rather than storing it. This only runs on `completed` tasks, never `blocked`/`failed`, per §14. A `CANDIDATE_LESSONS_GENERATED` event is published (0 lessons is a valid, expected outcome, not an error).

## 6. Human approval

`POST /api/memory/:id/approve` flips `type → "validated_lesson"`, `validationStatus → "validated"`, stamps `provenance.approvedAt`; `POST /api/memory/:id/reject` sets `validationStatus → "rejected"` (never deleted — §21) and stamps `provenance.rejectedAt`; `PATCH /api/memory/:id` edits `content`/`technology`/`taskType` and sets `provenance.humanEdited = true`, independent of approve/reject so a lesson can be edited before or after a decision. No auth system exists in this MVP (documented existing limitation), so `approvedBy` is free text, defaulted to `"developer"`.

## 7. Security / privacy

- The sensitive-content filter runs before a candidate is ever persisted (§20), not just before display.
- `scope` stays a repository path or `"global"` — never expanded automatically; nothing promotes project-scoped memory to global scope in this phase (no code path does it, by design).
- Memory API responses never include repository file contents, only the lesson text a human already approved or is being asked to approve.
- `MemoryProvenance` is additive-only from the API's perspective — there is no endpoint that lets a client rewrite `taskId`/`artifact`/`approvedAt` directly.

## 8. Testing strategy

- `memoryStore.test.ts` — retrieval relevance/exclusion, scope filtering (project vs. global), validation-status hard-filter (a candidate is never returned by `retrieve()` even if it would score highest), repository-evidence-precedence is exercised at the `contextPack` layer, not the store.
- `contextPack.test.ts` — included vs. excluded counts, per-agent filtering (a Postgres lesson reaches the database agent but not a Node-only analysis), conflict flagging when a memory item disagrees with `detectedStack`.
- `candidateLessons.test.ts` — a decision generates a candidate with correct provenance; a low-confidence decision does not; a decision whose text contains a fake secret is filtered out entirely.
- `memoryApi.test.ts` — approve/reject/edit over HTTP, an approved item becomes retrievable, a rejected item never is.
- `memoryLoop.e2e.test.ts` — **the most important test**: Task A completes (mock executor) → candidate generated → approved via the API → Task B (same repository/stack) → its `analyze()` call actually receives the approved lesson in `memoryContext`, provably (asserted against the mock executor's own report content, not just "no error was thrown"). Proves the loop closes end to end.
- Full existing suite (85 tests as of Phase 28) must stay green.

## 9. Migration considerations

None required — no memory data has ever been written (`data/memory.json` does not exist). The `approved_lesson → validated_lesson` rename and the `provenance: string → MemoryProvenance` shape change are safe with zero stored rows.

## 10. Explicitly out of scope this phase (per the brief's §25 and to keep blast radius proportionate)

- Vector/embedding-backed retrieval, semantic search, knowledge graphs.
- Automatic candidate → validated promotion (approval is always a human action).
- Writing `task_history` rows into `MemoryStore` (the existing artifact trail already *is* task history; duplicating it would violate `ORCHESTRATOR.md`'s own "do not duplicate repository source into memory unnecessarily" rule).
- Automatic project → global scope promotion.
- New specialist agents, reconciliation `CONFLICT` detection, task retry/resume — unrelated to this milestone.

Proceeding with implementation now; no fundamental architectural conflict was found with the existing codebase.
