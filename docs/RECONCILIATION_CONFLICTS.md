# Reconciliation Conflicts

Phase 30 gives `Reconciliation.status: "CONFLICT"` a real code path. Before this, `CONFLICT` was
declared in the type but never assigned — reconciliation only ever compared routing/failure
signals, never specialists' actual recommendations against each other. This document describes
what a conflict is, what it is not, how it's detected, how repository evidence and memory factor
in, and how a developer resolves one. See `docs/PHASE_30_IMPLEMENTATION_PLAN.md` for the full
design rationale and `docs/adr/0006-material-conflicts-become-explicit.md` for the decision record.

## What is (and isn't) a conflict

Two specialists producing different text is not, by itself, a conflict — different wording,
different code examples, or an agent-specific concern in an unrelated area are all expected and
normal. A conflict exists only when two specialists' recommendations are about **the same
engineering decision** and **cannot both be adopted**:

```
Node Agent:      Use a PostgreSQL transaction for order creation.
Database Agent:  Do not use a transaction here; this must stay eventually consistent.
                                                                          → CONFLICT

Node Agent:      Wrap order creation in a transaction so partial writes never occur.
Database Agent:  Order creation should be transactional to guarantee atomicity.
                                                                          → AGREED (same subject, same stance, different wording)

Node Agent:      Use JWT authentication for this endpoint.
Database Agent:  Add a caching layer for the read-heavy query.
                                                                          → not compared (different decisions)
```

## Detection is deterministic, not an LLM call

`server/src/orchestrator/decisionExtraction.ts` implements a three-stage, keyword-based algorithm
— no model call anywhere in the reconciliation core, so the same reports/routing/evidence/memory
always produce the same result:

1. **Category.** An ordered keyword table classifies each completed specialist report's
   recommendation (+findings) into one of: `architecture`, `api`, `database`, `data-model`,
   `transaction`, `validation`, `authentication`, `authorization`, `error-handling`,
   `performance`, `testing`, `dependency`, `configuration`, `deployment`. A concurrency-signal
   check (`synchronous`/`asynchronous`/…) runs first so a phrase like "an asynchronous transaction
   boundary" is recognized as a concurrency-model statement, not miscategorized by the word
   "transaction" alone.
2. **Subject.** Same-category decisions are grouped as "the same decision" if the category is
   inherently narrow (`transaction`, `authentication`, `authorization`, `data-model` — a task
   realistically has at most one of each), or, for broader categories, if the two recommendations
   share at least one significant term beyond stopwords and the category's own keywords. This is
   what stops "Node Agent's error handling for webhook retries" and "Database Agent's error
   handling for connection-pool exhaustion" from being force-matched into one conflict.
3. **Polarity.** Within a same-subject group, each recommendation is scored `affirmative` or
   `negative` from (a) a small set of explicit antonym phrases for the two cases the platform
   cares about most (`eventually consistent`/`no transaction` vs. plain transaction language;
   `asynchronous processing` vs. `synchronous processing`), and (b) a generic negation scan
   (`do not`, `avoid`, `without`, …) that only counts if the negated word is followed within ~40
   characters by one of the category's own keywords — this is what keeps "so partial writes never
   occur" and "to avoid malformed rows" from being misread as negating the transaction/validation
   decision itself, rather than the unrelated outcome they're actually talking about.

Same category + same subject + differing polarity → `CONFLICT`. Same category + same subject +
matching polarity → recorded in `agreements`, regardless of wording differences.

**Known limitation.** This is a precision-favoring, not exhaustive, heuristic: a negation that
grammatically precedes its keyword ("a transaction should not be used") is missed. This is a
deliberate tradeoff — false conflicts are worse than a missed one, since a false conflict blocks
implementation on nothing.

## Repository evidence conflicts

Separately from specialist-vs-specialist disagreement, a recommendation that names a specific
database technology (Postgres, MySQL, MongoDB, Redis, SQLite) different from the repository's own
detected database is recorded as `kind: "evidence-contradiction"`. The recommendation itself is
never rewritten — the conflict is recorded alongside it, with `repositoryEvidence` stating what
the repository actually shows. This kind is always `materiality: "material"`.

## Memory interaction

Each conflict participant carries `memoryInfluenced`/`memoryIds`, derived from the same
per-agent-filtered validated memory (`memoryForAgent()`) that Phase 29 already feeds into
specialist analysis — not from string-sniffing the specialist's free-text output. This makes "a
prior validated lesson shaped this recommendation" visible without changing precedence: current
repository evidence still wins for the implementation gate exactly as before; Phase 30 only makes
the disagreement, when one exists, honest and inspectable rather than changing who wins.

## Materiality

```
MATERIAL   — architecture, api, database, data-model, transaction, authentication,
             authorization, deployment, and every evidence-contradiction regardless of category.
NON-MATERIAL — validation, error-handling, performance, testing, dependency, configuration.
```

Only an **unresolved material** conflict blocks implementation. `reconciliation.status` is
`CONFLICT` any time *any* conflict (material or not) is unresolved — the platform never hides a
disagreement just because it happens not to be blocking — but the pipeline only stops for a
material one.

## Resolution workflow

```
POST /tasks/:id/reconciliation/conflicts/:conflictId/resolve
{ "resolution": "...", "reason"?: "...", "resolvedBy"?: "..." }
```

Validates the task and conflict exist and the conflict isn't already resolved (`404`/`409`), and
that `resolution` is non-empty (`400`). The resolution is persisted with a server-set
`resolvedAt`; the client can never write to any other field of the conflict (category,
participants, reason, provenance) — a client cannot spoof agent identity or influence the
detection outcome through this endpoint. As with the existing `POST /memory/:id/approve` endpoint
(ADR 0005), `resolvedBy` is client-supplied free text — this MVP has no auth system — but the
resolution *state transition itself* is server-authoritative and, once set, immutable.

If resolving a conflict clears the last unresolved material conflict on a `blocked` task, the
orchestrator resumes automatically from the planning stage. This is a narrow continuation
mechanism scoped specifically to the conflict gate this milestone introduces — not a general
blocked/failed-task retry system (see the implementation plan's section 11 for the scope
reasoning; general task resume remains a documented, open gap for a future milestone).

## Implementation blocking

```
Reconciliation                       Implementation
─────────────                        ──────────────
AGREED / no material conflicts   →   proceeds normally
Unresolved material conflict     →   task blocked, developer resolution required
Resolved material conflict(s)    →   proceeds (resumes if the task was blocked)
```

## Review-stage conflicts

The same detection engine also runs across each review attempt's *blocking* findings. If two
specialists' blocking findings are in material conflict (one wants a fix the other's finding
directly contradicts), the orchestrator does not attempt an automatic corrective implementation
pass — a corrective pass cannot satisfy two contradictory blocking requests. Instead it appends
the conflict to the same `reconciliation.json` (`detectedAt: "review"`) and blocks the task,
using the same resolution/resume path described above. Ordinary, non-conflicting blocking
findings continue to trigger a corrective pass exactly as before Phase 30.

## Examples

See `server/tests/reconciliation.test.ts` and `server/tests/decisionExtraction.test.ts` for the
full worked examples this document summarizes, including the explicit false-positive matrix
(different wording, different code examples, compatible implementation detail, agent-specific
concerns, irrelevant output) that the detection engine is tested against.
