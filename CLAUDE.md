# Backend Engineering Agent Platform

Node/Express + Angular 22 orchestrator (`backend-engineering-agent-platform`). Routes a backend
engineering requirement to Python/Node/Database specialist contracts (defined in
`claude-code-platform-architecture-v0.1/`), reconciles their recommendations, drives Claude Code
(mock or real executor) to implement, review, and hand off — JSON-file task store, artifact-first
workspaces under `tasks/<id>/`.

Do not re-derive this project's history from scratch each session — it's tracked in auto-memory
(`project_status.md`, `feedback_phase_prompts.md`) and in `docs/PHASE_N_COMPLETION_REPORT.md`.
Read those before assuming something is missing or re-implementing something that already exists.

## How to run

- `npm install` at repo root (npm workspaces: `server`, `web`, `e2e`)
- `npm run dev` — mock mode (default, no real `claude` CLI calls). UI: http://localhost:4300, API: http://localhost:4400/api
- `CLAUDE_EXECUTION_MODE=real npm run dev` — real mode (opt-in, shells out to the `claude` CLI)
- `npm test` — backend (vitest, `server/`) + frontend (jest, `web/`)
- `npm run test:e2e` — Playwright, separate from `npm test`
- Test count as of 2026-09-17: **341 total** (266 backend + 75 frontend), confirmed by direct run, not carried forward from docs

## Status: Phases 1–41 complete

Shipped and tested: real execution in an isolated git worktree/branch with timeout/cancel and
ground-truth `git diff` capture; human-gated memory (`candidate_lesson` → human approval);
reconciliation `CONFLICT` detection + human/autonomous resolution; task retry + startup crash
recovery; manual workspace cleanup; ground-truth diff content in review; non-success task
visibility fixes; security hardening (symlink-safe repo paths, subprocess env allow-list,
untrusted-content trust-framing in prompts); autonomy opt-in (`Task.autonomyLevel:
"advisory"|"autonomous"` — routing direction + reconciliation-conflict arbitration, both
advisory-by-default); requirement docs read from the target repo; backlog decomposition for
big/greenfield requirements (stops implementing further steps once one fails review); live
stage/specialist timing on the dashboard; live streaming implementation progress via `claude
--output-format stream-json`; graceful shutdown (`cancelAllInFlight()`) kills orphaned `claude`
subprocesses on SIGTERM/SIGINT.

Full narrative and rationale for each phase: `docs/PHASE_N_PROPOSAL.md` /
`docs/PHASE_N_COMPLETION_REPORT.md` / `docs/adr/*` and auto-memory `project_status.md`.

## In progress — containerization (not yet a numbered phase)

Commit `6b96fe8` ("conatinerization in process") added `Dockerfile.npm`, `.dockerignore`, and
static-file serving in `server/src/app.ts`/`config.ts` (serves the built Angular app from the
same Node process in production/container use; a no-op locally). Runtime image defaults to
`CLAUDE_EXECUTION_MODE=mock` (the `claude` CLI isn't installed in it). This landed without the
usual plan-doc/completion-report ritual — no `docs/PHASE_42_*` exists yet. Treat it as
exploratory/unreviewed until the next phase prompt either formalizes or supersedes it.

## Remaining candidates (none committed to yet — ask before picking one)

- Real-CLI validation of `decideConflictResolution()` — still unproven live; two real attempts
  both converged with zero conflicts, so the arbitration path was never actually exercised
- Review-stage conflict arbitration (extending the Phase 37 pattern to `detectReviewConflicts()`)
- Formalizing containerization into a numbered phase with the usual docs, if wanted
- Repository inspector staying a shallow single-pass is a deliberate non-priority (Phase
  35/36 reviews found real-mode Claude's own live repo reads matter more than widening it)
- No auth/CORS restriction on the API — accepted for a single-developer localhost MVP

## Conventions

- Work happens in large, explicit, numbered "Phase" prompts (30-40 sections): objective → verify
  prior claims against actual code → plan doc → implement → tests → completion report → memory
  update → small logically-grouped conventional commits (`feat:`, `fix:`, `test:`, `docs:`) →
  push only once explicitly authorized. See auto-memory `feedback_phase_prompts.md` for the full
  pattern this developer expects.
- Never claim "tests pass" or "a feature works" without actually running it — real CLI runs, real
  HTTP calls, real browser checks for UI changes. Standing rule, not a one-off instruction.
- `server/src/config.ts` values are `get` accessors that re-read `process.env` on every access —
  deliberate (fixed a real test-isolation bug in Phase 39), don't "simplify" it back to
  once-computed constants.
- Sections a phase prompt marks "out of scope" are respected strictly, not scope-crept into.
