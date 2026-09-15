import { config } from "../config.js";
import { MockClaudeCodeExecutor } from "./MockClaudeCodeExecutor.js";
import { RealClaudeCodeExecutor } from "./RealClaudeCodeExecutor.js";
import type { ClaudeCodeExecutor } from "./ClaudeCodeExecutor.js";

export function createExecutor(): ClaudeCodeExecutor {
  return config.executionMode === "real" ? new RealClaudeCodeExecutor() : new MockClaudeCodeExecutor();
}

export type { ClaudeCodeExecutor } from "./ClaudeCodeExecutor.js";
