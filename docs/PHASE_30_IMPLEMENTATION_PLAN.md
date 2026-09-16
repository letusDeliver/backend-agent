# Phase 30 Implementation Plan — Reconciliation CONFLICT Detection

## 1. Current behavior (verified against code, not prior docs)

`reconcile()` (`server/src/orchestrator/reconciliation.ts`) never compares specialist
recommendations to each other. It only inspects three signals: `routing.needsEscalation`
(→ `NEEDS_USER_DECISION`), whether any report has `status: "failed"` or the report list is
empty (→ `UNKNOWN`), and otherwise unconditionally returns `AGREED`. `Reconciliation.conflicts`
is a `string[]` populated only with routing-escalation rationale text — it is never a record of
disagreement between agents. `CONFLICT` is declared in `ReconciliationStatus` but no branch of
the function can ever produce it. This is why the milestone exists: there is no code path, not
even a naive one, that compares two specialists' output.

Each `SpecialistReport` carries exactly one `recommendation: string`, three `findings`
(`summary`/`evidence`), `risks`, `assumptions: string[]`, and a `confidence`. There is no
existing structured decision shape anywhere in the codebase — mock and real executors both
produce this single free-text recommendation per agent per task. `buildImplementationPlan()` and
`generateCandidateLessons()` both iterate `reconciliation.decisions` (`ArchitectureDecision[]`,
one per completed report) — that shape and its consumers must not change.

`TaskOrchestrator.run()` calls `reconcile()` once, between `analyze()` and
`buildImplementationPlan()`, and blocks the task (`status: "blocked"`) only for
`NEEDS_USER_DECISION` / `UNKNOWN`. Nothing downstream (implementation, review) is aware of
reconciliation at all beyond reading `reconciliation.decisions.length` for the handoff summary.

Memory (Phase 29) already flows into `analyze()` per-agent via `memoryForAgent(agent, contextPack)`
and is recorded in `contextPack.entries`; `contextPack` is persisted
(`context/memory-retrieval.json`) and readable via `artifactStore.readMemoryRetrieval(taskId)`.
`reconcile()` currently does not receive the context pack at all, so it has no way to know
whether a recommendation was memory-influenced.

## 2. What constitutes a real disagreement

Per the brief: different wording is not a conflict. A conflict exists when two specialists make
recommendations about **the same engineering decision** that **cannot both be adopted**. This
plan treats "same decision" as a two-part deterministic test (category + subject overlap, §5)
and "cannot both be adopted" as a polarity test (negation/antonym detection, §5) — never a raw
string diff, never an LLM call inside the reconciliation core (§9, determinism).

## 3. Conflict model (extends, does not replace, the existing domain model)

`ReconciliationStatus` stays `"AGREED" | "CONFLICT" | "UNKNOWN" | "NEEDS_USER_DECISION"` — no new
status is added. `UNKNOWN` already covers "insufficient evidence" (empty/failed analysis), so a
separate `INSUFFICIENT_EVIDENCE` status is not needed (per the brief's own "if the current
architecture supports such a distinction" — it does, via `UNKNOWN`).

`Reconciliation` gains three fields and changes the type of one:

```ts
interface Reconciliation {
  taskId: string;
  status: ReconciliationStatus;
  decisions: ArchitectureDecision[];        // UNCHANGED shape/semantics — implementationPlan.ts
                                             // and candidateLessons.ts keep reading this as-is.
  agreements: string[];                     // NEW — one line per category where 2+ agents matched.
  conflicts: ReconciliationConflict[];      // CHANGED from string[] to structured (see below).
  unresolvedQuestions: string[];            // NEW — narrative text: routing-escalation / failed-
                                             // analysis reasons (moved out of the old `conflicts`
                                             // string[]), plus one line per open conflict.
  risks: SpecialistRisk[];
  confidencePercent: number;
  createdAt: string;
}

type DecisionCategory =
  | "architecture" | "api" | "database" | "data-model" | "transaction"
  | "validation" | "authentication" | "authorization" | "error-handling"
  | "performance" | "testing" | "dependency" | "configuration" | "deployment";

interface ConflictParticipant {
  agent: AgentType;
  decision: string;      // original recommendation text
  rationale: string;
  evidence: string;
  confidence: number;
  polarity: "affirmative" | "negative";
  memoryInfluenced: boolean;
  memoryIds: string[];
}

interface ConflictResolution {
  resolution: string;
  reason: string;
  resolvedBy: string;
  resolvedAt: string;
}

interface ReconciliationConflict {
  id: string;
  kind: "specialist-disagreement" | "evidence-contradiction";
  category: DecisionCategory;
  subject: string;                 // human-readable label, e.g. "transaction"
  detectedAt: "reconciliation" | "review";
  participants: ConflictParticipant[];   // 2+ for specialist-disagreement; 1 for evidence-contradiction
  repositoryEvidence?: string;           // set for evidence-contradiction
  materiality: "material" | "non-material";
  reason: string;                  // deterministic explanation of the classification
  resolution: ConflictResolution | null;
  createdAt: string;
}
```

This directly answers §4's checklist per conflict: who disagreed (`participants[].agent`), what
they recommended (`.decision`), what decision (`category`/`subject`), what evidence
(`.evidence`/`repositoryEvidence`), why both can't be accepted (`reason`, from the polarity
check), what must happen (`unresolvedQuestions` + `resolution: null`).

`conflicts` changes from `string[]` to a structured array. This is a breaking shape change for
already-completed tasks' persisted `reconciliation.json` (no schema versioning exists in this
JSON-file store) — old files simply have `conflicts: string[]`. The UI defensively treats a
non-array/old shape as empty rather than crashing (see §11). No migration script is written;
this matches how the project has handled every prior artifact-shape change (Phase 28/29 also
changed persisted shapes without migrating old task directories under `tasks/`).

## 4. Decision extraction — smallest structured extension that fits

No new field is requested from specialists (mock or real). `extractDecision()`
(`server/src/orchestrator/decisionExtraction.ts`, new, pure functions) derives one
`ExtractedDecision` per **completed** `SpecialistReport` from data that already exists:
`recommendation`, `findings[].summary/.evidence`, `rationale` (joined findings), `confidence`,
and — newly threaded in — whether `memoryForAgent(report.agent, contextPack)` was non-empty for
that agent. A report with `status !== "completed"` yields no decision (already excluded from
`decisions` today).

## 5. Deterministic conflict-detection algorithm

No LLM anywhere in this path (§17). Three ordered stages, each a pure function over already-
collected text:

**Stage 1 — category.** A fixed, ordered keyword table (most specific category first, falling
through to `"architecture"` as the default) scans `recommendation + findings text` lowercased.
First match wins. ~13 categories, matching §6's suggested list minus an "enormous taxonomy."

**Stage 2 — subject grouping (same decision?).** Group same-category decisions across agents.
`transaction`, `authentication`, `authorization`, `data-model` are treated as inherently narrow —
a single task realistically has at most one instance of each, so category match alone groups
them. The remaining (broader, more likely to cover multiple unrelated concerns within one task)
categories additionally require non-zero token overlap between the two recommendation texts
(stopwords and the category's own keyword words excluded) before being treated as the same
subject — this is what prevents "Node Agent talks about JWT auth" and "Database Agent mentions
authenticating its connection string" from being force-matched into one conflict. Two decisions
in the same category that fail the subject-overlap check are recorded as independent decisions,
not compared at all — this is how §3/§19 "different subjects → no false conflict" is satisfied
without discarding real signal.

**Stage 3 — polarity (can both be adopted?).** Within a same-subject group, each decision's text
is scored `affirmative` or `negative` using (a) a small generic-negation regex set (`do not`,
`never`, `avoid`, `without`, `cannot`, …) and (b) a per-category table of explicit antonym
phrases for the two cases named directly in the brief (`transaction` ↔ `eventually consistent` /
`no transaction`; `synchronous` ↔ `asynchronous`, generalized under `architecture`). Same
category + same subject + differing polarity → `CONFLICT`. Same category + same subject + same
polarity → `AGREED` regardless of wording/rationale differences (§3/§19's core requirement).

This is fully deterministic: same reports + same routing + same memory pack always produce the
same conflict set, satisfying §17.

**Known limitation (documented, not silently ignored):** generic negation detection cannot
distinguish `"do not use a transaction"` (negates the category action) from `"do not skip
validation"` (negates a different verb, and is actually affirmative toward validation). This is
a real false-positive risk of any keyword-based negation approach without a dependency parser.
It is called out explicitly in `docs/RECONCILIATION_CONFLICTS.md` and the completion report
rather than hidden, and is not covered by a test asserting the wrong answer as correct.

## 6. Repository evidence conflicts (`kind: "evidence-contradiction"`)

Separate, simpler check: if a `database`-category decision names a specific database technology
(postgres/mysql/mongodb/redis/sqlite, matched from the existing `KNOWN_DATABASES` list already
used by `contextPack.ts`) that differs from `detectedStack.database` when the latter is known,
record a `materiality: "material"` conflict with `repositoryEvidence` set to the detected value
and a single participant (the disagreeing agent). This never rewrites the agent's recommendation
(§8) — it is recorded alongside it. Repository evidence remaining authoritative for the
*implementation gate* (§8/§12) means: this conflict kind is always `material` regardless of
category, so it always requires resolution before implementation proceeds.

## 7. Memory-induced conflicts (§9)

`reconcile()`'s signature grows one parameter: `contextPack: ContextPack | null`. For each
participant, `memoryInfluenced`/`memoryIds` are set from `memoryForAgent(agent, contextPack)`
rather than string-sniffing `assumptions` (which is LLM-authored free text in real mode and not
guaranteed to mention memory explicitly). This makes "memory said X, but agent Y's fresh
repository-grounded analysis says Y" mechanically visible in the conflict record without changing
the detection algorithm itself — it is metadata on top of the same specialist-disagreement or
evidence-contradiction conflict, not a third conflict kind. Current repository evidence still
wins for the implementation gate exactly as Phase 29 established; this phase makes the
*disagreement* visible rather than changing precedence.

## 8. Materiality (§12 — defined here, not invented ad hoc)

```
MATERIAL (blocks implementation until resolved):
  architecture, api, database, data-model, transaction, authentication,
  authorization, deployment
  — plus every evidence-contradiction conflict, regardless of category.

NON-MATERIAL (visible, does not block implementation):
  validation, error-handling, performance, testing, dependency, configuration
```

Rationale: the material set is exactly the categories where picking wrong is expensive to
reverse post-implementation (data integrity, external contract, security surface, ship
mechanics) or safety-critical by definition (evidence contradictions). The non-material set is
where a wrong pick is comparatively cheap to correct in a later review/iteration pass. This table
is the full definition — no other classifier is introduced.

## 9. Reconciliation status derivation

```
1. routing.needsEscalation            → NEEDS_USER_DECISION   (unchanged)
2. any report failed / zero reports   → UNKNOWN                (unchanged)
3. any conflict exists (material or not, unresolved) → CONFLICT (NEW)
4. otherwise                          → AGREED
```

`status === "CONFLICT"` is truthful/visible any time disagreement exists (Final Principle: never
hide disagreement) — including non-material-only conflicts. The **implementation gate** is a
separate, narrower check (§10): only an *unresolved material* conflict blocks. A task can be
`status: "CONFLICT"` with only non-material, unresolved items and still proceed — the UI shows
the open item, but the pipeline isn't stopped over it.

## 10. Implementation gate & review-loop interaction

In `TaskOrchestrator.run()`, immediately after computing `reconciliation`:

```
NEEDS_USER_DECISION / UNKNOWN  → block (unchanged)
CONFLICT with unresolved material conflict → block, message names the conflict(s)
CONFLICT with only non-material/resolved conflicts, or AGREED → proceed to planning (unchanged)
```

**Review-stage conflicts (§13).** The existing review loop (`reviewLoop()`) already collects all
agents' `ReviewReport[]` per attempt. A new, small, reused helper (`detectReviewConflict`, same
category/subject/polarity engine as decision extraction, applied to blocking findings'
`summary + recommendation` text) runs across that attempt's blocking findings. If two agents'
blocking findings are in material conflict, the orchestrator does **not** attempt a corrective
implementation pass (a corrective pass cannot satisfy two contradictory blocking requests) —
it appends the conflict to the task's `reconciliation.json` (`detectedAt: "review"`) and blocks
the task immediately, same `block()` path already used elsewhere. Ordinary (non-conflicting)
blocking findings continue to trigger a corrective pass exactly as today — this is purely
additive and does not change Phase 28/29 review-loop behavior when no such conflict is present.

## 11. Conflict resolution & continuation — scope note

§26 lists "task retry/resume" as out of scope, and project memory records general
blocked/failed-task resume as an open gap. §27's Definition of Done nonetheless requires
"resolved conflicts permit continuation." These are reconciled as follows: this phase adds a
**narrowly-scoped continuation mechanism specific to the conflict gate this milestone itself
introduces** — not a general resume-any-blocked-task feature. A task blocked only because of an
unresolved material conflict can continue, from the planning stage, once every material conflict
is resolved; a task blocked for any other reason (workspace prep failure, `NEEDS_USER_DECISION`,
`UNKNOWN`, review-loop exhaustion unrelated to a conflict) still has no resume path — that
remains the pre-existing, documented gap for a later milestone. This is judged not to be a
"fundamental architectural contradiction" requiring a pause for approval — it is a scope
clarification, applied and documented here per §1's instruction to proceed unless the
contradiction is fundamental.

Mechanics: `TaskOrchestrator` gets `resumeAfterConflictResolution(taskId)`, sharing a
`continueAfterReconciliation()` tail (planning → implementing → review → handoff) with `run()`.
It reloads the persisted task, specialist reports, and reconciliation; recomputes routing via
`routeTask()` (pure function of `task`/`detectedStack`, so recomputing is deterministic and
avoids persisting `RoutingResult` separately); verifies no unresolved material conflict remains;
and continues. This covers both reconciliation-stage and review-stage conflicts with one path.

`POST /tasks/:id/reconciliation/conflicts/:conflictId/resolve` — body
`{ resolution: string; reason?: string; resolvedBy?: string }`. Validates: task exists (404),
reconciliation exists (404), conflict exists (404), not already resolved (409), `resolution`
non-empty (400). Persists `ConflictResolution` with a server-set `resolvedAt`. If the task is
`status: "blocked"` and no material conflict remains unresolved afterward, it fires
`resumeAfterConflictResolution` (same fire-and-forget pattern as `POST /tasks/:id/start`) and the
response includes `resumed: boolean`. As with the existing `POST /memory/:id/approve` endpoint,
`resolvedBy` is client-supplied free text (this MVP has no auth system) — the *state transition*
(resolution exists, is immutable once set, `resolvedAt` is server-set) is what's authoritative,
not the attribution string; this mirrors an already-accepted, documented tradeoff (ADR 0005),
not a new gap.

## 12. Security (§23)

Specialist/memory text is untrusted content already flowing through existing sanitization-free
paths (it's rendered as plain text in Angular templates, which auto-escapes interpolation — no
`innerHTML` is used for any of this). The new endpoint only ever writes to
`conflict.resolution`, never to `participants`, `category`, `reason`, or any other
orchestrator-authored field — a client cannot spoof agent identity or provenance through it, and
attempting to resolve an already-resolved or nonexistent conflict fails closed (409/404).

## 13. UI (§14/§15)

Task Detail's Reconciliation card: conflicts render as their own block above `decisions` —
badge for `materiality`, each participant's agent + recommendation + evidence, resolved/
unresolved state, and (unresolved only) a minimal inline resolve form (textarea + submit) wired
to the new `TaskService.resolveConflict()`. `agreements` and `unresolvedQuestions` render as
simple lists, consistent with the existing risks/conflicts list styling already in the template.
No new page, no new route — this stays inside the existing Task Detail component.

## 14. Testing strategy

- `server/tests/decisionExtraction.test.ts` (new): category classification, subject grouping
  (narrow vs. broad categories), polarity/negation, and the full §19 false-positive matrix
  (different wording, different code example, compatible detail, agent-specific concern,
  irrelevant output) as direct unit tests of the pure functions — fastest, most precise signal.
- `server/tests/reconciliation.test.ts` (extend): agreement, explicit disagreement, different
  subjects, same subject/different rationale, evidence contradiction, memory-influence metadata,
  three-agent case (A=X, B=X, C=Y), multiple independent conflicts in one task, materiality.
- `server/tests/reconciliationApi.test.ts` (new): resolve unresolved → resolved; resolving an
  already-resolved or nonexistent conflict fails safely (409/404); resolving the last material
  conflict on a blocked task resumes it to completion (uses a deterministic stub executor
  constructed directly against `TaskOrchestrator`, not the shared mock, per §29's "deterministic
  fixture" guidance and to avoid changing `MockClaudeCodeExecutor`'s existing, test-covered
  output).
- Regression: `npm test` (full existing 101+16 suite) must stay green unmodified in assertions.

## 15. Edge cases

- Only one specialist ran (single-agent task): no possible disagreement — `agreements`/
  `conflicts` both empty, status unaffected by this feature.
- All specialists fail: unchanged, still `UNKNOWN` (checked before conflict detection runs).
- A conflict where one side is `not_required`/`pending` (shouldn't reach `reconcile()`, but
  `extractDecision` only ever looks at `status === "completed"` reports, matching existing
  `decisions` filtering).
- Resolving a conflict on a task that is not currently `blocked` (e.g., already `completed`
  another way, or `cancelled`): resolution is still recorded for audit, but no resume is
  attempted.
- Double-negative wording (§5's documented limitation).

## 16. Risks

- False positives from the keyword/negation approach are the main quality risk of this whole
  milestone (§19 is explicit about this) — mitigated by the two-stage category+subject gate
  before polarity is even checked, and by a deliberately small, explicit antonym table rather
  than broad sentiment analysis.
- Changing `conflicts` from `string[]` to a structured array is a breaking artifact-shape change
  for historical task directories; accepted per §3 (no migration tooling exists for any prior
  phase's artifact-shape change either), UI degrades safely on old shapes.

## 17. Out of scope (unchanged from §26)

New specialist agents, vector search/RAG, autonomous conflict resolution, automatic memory
promotion, general task retry/resume beyond §11's narrow conflict-continuation path, distributed
orchestration, database migration, multi-user auth.
