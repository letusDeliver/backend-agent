import { config } from "../config.js";
import { MockClaudeCodeExecutor } from "./MockClaudeCodeExecutor.js";
import { RealClaudeCodeExecutor } from "./RealClaudeCodeExecutor.js";
import type { GitWorktreeManager } from "./gitWorktree.js";
import type { ClaudeCodeExecutor } from "./ClaudeCodeExecutor.js";

export function createExecutor(worktrees: GitWorktreeManager): ClaudeCodeExecutor {
  return config.executionMode === "real" ? new RealClaudeCodeExecutor(worktrees) : new MockClaudeCodeExecutor();
}

export type { ClaudeCodeExecutor } from "./ClaudeCodeExecutor.js";
export { GitWorktreeManager, GitWorktreeError } from "./gitWorktree.js";
