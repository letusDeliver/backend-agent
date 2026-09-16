import path from "node:path";
import type { ExecutionMode } from "./types/index.js";

const repoRoot = path.resolve(process.cwd(), "..");

/**
 * Every env-derived value here is a `get` accessor, not a plain property —
 * deliberately. A plain object literal computes each property once, at the
 * moment this module is first imported/evaluated; every later
 * `process.env.X = ...` (exactly what test setup does, e.g. `process.env.
 * TASKS_DIR = someTempDir`) would then be silently ignored by any code that
 * already holds a reference to `config`, because the value was already
 * baked in. This was a real, previously undetected bug: several tests set
 * `TASKS_DIR`/`DATA_DIR` in their own `beforeAll` expecting isolation, but
 * depending on which module happened to import `config.js` first within the
 * same process, `config.tasksDir`/`config.dataDir` could still resolve to
 * this project's own real `tasks/`/`data/` directories — confirmed by
 * finding leaked task directories there while adding Phase 39 tests. `get`
 * accessors re-read `process.env` on every access, so a test's env override
 * always takes effect regardless of import order.
 */
export const config = {
  get port(): number {
    return Number(process.env.PORT ?? 4400);
  },
  // The platform's own source root — used to refuse ever pointing real
  // execution at (or an ancestor of) its own repository. Derived from
  // process.cwd() at startup, not from an env var a test would override.
  repoRoot,
  get dataDir(): string {
    return process.env.DATA_DIR ?? path.join(repoRoot, "data");
  },
  get tasksDir(): string {
    return process.env.TASKS_DIR ?? path.join(repoRoot, "tasks");
  },
  get agentsDir(): string {
    return process.env.AGENTS_DIR ?? path.join(repoRoot, "claude-code-platform-architecture-v0.1", "agents");
  },
  // Defaults to mock: real execution shells out to the local `claude` CLI and
  // can mutate a real repository. It must be opted into explicitly rather
  // than triggered as a side effect of clicking a button in the UI.
  get executionMode(): ExecutionMode {
    return process.env.CLAUDE_EXECUTION_MODE === "real" ? "real" : "mock";
  },
  get maxReviewRetries(): number {
    return Number(process.env.MAX_REVIEW_RETRIES ?? 2);
  },
  get claudeCliPath(): string {
    return process.env.CLAUDE_CLI_PATH ?? "claude";
  },
  get claudeTimeoutMs(): number {
    return Number(process.env.CLAUDE_TIMEOUT_MS ?? 120_000);
  },
  // Maximum characters of unified-diff patch text captured/stored per task
  // (Phase 33). Bounds prompt size, artifact size, and UI payload size — a
  // diff larger than this is truncated at a file boundary, never dropped
  // silently (see GitWorktreeManager.diff()).
  get maxDiffPatchChars(): number {
    return Number(process.env.MAX_DIFF_PATCH_CHARS ?? 200_000);
  },
  // Explicit allow-list of environment variable names forwarded to the
  // `claude` CLI subprocess and to `runTests()`'s test-command subprocess
  // (Phase 35) — the full parent process environment (which may hold
  // secrets unrelated to either) is never inherited by default. Verified
  // empirically against the real `claude` CLI: PATH/HOME/USER/LOGNAME are
  // the minimum required for it to locate and authenticate with its stored
  // credentials on this platform; SHELL/LANG/LC_ALL/TERM/TMPDIR are
  // additional non-secret values commonly relied on for locale-correct
  // output and temp-file placement, included defensively for portability
  // across machines/OSes (see docs/PHASE_35_COMPLETION_REPORT.md).
  get claudeSubprocessEnvAllowList(): string[] {
    return (process.env.CLAUDE_SUBPROCESS_ENV_ALLOWLIST ?? "PATH,HOME,USER,LOGNAME,SHELL,LANG,LC_ALL,TERM,TMPDIR")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  },
  // Phase 38: maximum characters read from any single requirement doc a
  // task points at (task.requirementDocPaths). Bounds prompt size and
  // artifact size the same way maxDiffPatchChars bounds diff capture — an
  // oversized doc is truncated explicitly, never dropped silently.
  get maxRequirementDocChars(): number {
    return Number(process.env.MAX_REQUIREMENT_DOC_CHARS ?? 20_000);
  },
  // Containerized/production deployment only: the built Angular static
  // output, served by this same Express process alongside the API (see
  // app.ts). Local dev never has anything at this path (the web workspace
  // is served separately by `ng serve` instead), so app.ts checks
  // existence before mounting it — this getter never does I/O itself,
  // matching every other property here.
  get webDistPath(): string {
    return process.env.WEB_DIST_PATH ?? path.join(repoRoot, "web-dist");
  },
};
