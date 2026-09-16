import path from "node:path";
import type { ExecutionMode } from "./types/index.js";

const repoRoot = path.resolve(process.cwd(), "..");

export const config = {
  port: Number(process.env.PORT ?? 4400),
  // The platform's own source root — used to refuse ever pointing real
  // execution at (or an ancestor of) its own repository.
  repoRoot,
  dataDir: process.env.DATA_DIR ?? path.join(repoRoot, "data"),
  tasksDir: process.env.TASKS_DIR ?? path.join(repoRoot, "tasks"),
  agentsDir: process.env.AGENTS_DIR ?? path.join(repoRoot, "claude-code-platform-architecture-v0.1", "agents"),
  // Defaults to mock: real execution shells out to the local `claude` CLI and
  // can mutate a real repository. It must be opted into explicitly rather
  // than triggered as a side effect of clicking a button in the UI.
  executionMode: (process.env.CLAUDE_EXECUTION_MODE === "real" ? "real" : "mock") as ExecutionMode,
  maxReviewRetries: Number(process.env.MAX_REVIEW_RETRIES ?? 2),
  claudeCliPath: process.env.CLAUDE_CLI_PATH ?? "claude",
  claudeTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS ?? 120_000),
  // Maximum characters of unified-diff patch text captured/stored per task
  // (Phase 33). Bounds prompt size, artifact size, and UI payload size — a
  // diff larger than this is truncated at a file boundary, never dropped
  // silently (see GitWorktreeManager.diff()).
  maxDiffPatchChars: Number(process.env.MAX_DIFF_PATCH_CHARS ?? 200_000),
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
  claudeSubprocessEnvAllowList: (
    process.env.CLAUDE_SUBPROCESS_ENV_ALLOWLIST ?? "PATH,HOME,USER,LOGNAME,SHELL,LANG,LC_ALL,TERM,TMPDIR"
  )
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
};
