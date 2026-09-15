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
};
