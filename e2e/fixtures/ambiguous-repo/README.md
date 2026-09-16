# Ambiguous fixture repository

Deliberately has no `package.json`/`requirements.txt`/`pyproject.toml` — repository inspection
resolves language `"unknown"`, so a requirement that names no backend technology causes routing to
select zero specialists. Used by `e2e/tests/nonSuccessVisibility.spec.ts` (Phase 34) to reach a
genuinely `blocked` task in the browser through a real, supported application boundary (task
creation + start), not a fixture swap.
