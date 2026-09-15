# ADR 0005 — Only human-approved memory ever influences specialist analysis

**Status**: Accepted (Phase 29)

## Context

Phase 29 wired `MemoryStore` into orchestration for the first time. A completed task's reconciliation decisions are genuine engineering signal — but they're also unverified: a specialist's recommendation could be wrong, incomplete, or specific to a situation that doesn't generalize. Feeding that straight back into a later task's analysis would let the system's own past mistakes compound silently.

## Decision

- A completed task can generate `candidate_lesson` items automatically. A candidate is never retrievable for specialist context — `MemoryStore.retrieve()` hard-filters to `validationStatus === "validated"` before it scores anything, so this holds even if a caller forgets to filter.
- The only way a candidate becomes `validated_lesson` is a human calling `POST /api/memory/:id/approve`. There is no automatic promotion path, no confidence threshold high enough to skip the human, and no background job that approves on a developer's behalf.
- A rejected candidate is kept, not deleted (`validationStatus: "rejected"`, `provenance.rejectedAt` stamped) — permanently excluded from retrieval, but visible for audit.
- Even a validated item never silently overrides current repository evidence: `buildContextPack()` flags a conflict (e.g. a memory item naming a different database than the repository's own detected stack) rather than resolving it, and the conflict is surfaced in both the artifact and the UI.

## Alternatives considered

- **Auto-promote high-confidence decisions**: rejected — "high confidence" from a single specialist analysis is not the same as "correct," and auto-promotion removes the one checkpoint that catches a plausible-sounding but wrong recommendation before it compounds across future tasks.
- **Let candidates influence retrieval with a lower weight, without requiring approval**: rejected — this project's own principle throughout (mock vs. real execution, ground-truth diffs over self-reports) has been to never let unverified output pose as verified fact, even partially. A "slightly trusted" candidate is a silent version of the same problem.

## Consequences

- The memory layer has real friction by design: a developer must actively review and approve before memory becomes useful, which is the point — see `docs/MEMORY_LAYER.md`'s "The loop, in one picture."
- The end-to-end test for this phase (`memoryLoop.e2e.test.ts`) exists specifically to prove the gate holds in both directions: an approved candidate reaches a later task's specialist, and a rejected one never does.
- This means the memory layer contributes zero value until a developer starts approving lessons — an intentional tradeoff of usefulness for trustworthiness at this stage, consistent with the phase's own stated principle: "Memory must become useful without becoming trusted automatically."
