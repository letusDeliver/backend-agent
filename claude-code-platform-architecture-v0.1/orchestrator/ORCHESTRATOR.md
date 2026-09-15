# Master Orchestrator Contract

## Responsibilities
1. Parse the developer request.
2. Inspect the repository.
3. Retrieve relevant memory/context.
4. Select specialists.
5. Dispatch independent analysis where possible.
6. Reconcile specialist outputs.
7. Gate implementation.
8. Hand off a unified plan to Claude Code.
9. Route post-implementation reviews.
10. Reconcile findings and report.

## Do Not
- implement a specialist's domain logic during planning merely to avoid consultation,
- silently resolve material conflicts,
- flood agents with all available memory,
- duplicate repository source into memory unnecessarily.

## Decision Record
Every material architectural decision must have:
- decision
- alternatives
- evidence
- rationale
- confidence
- owner/specialist
