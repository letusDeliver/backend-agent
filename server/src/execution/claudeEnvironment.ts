import { config } from "../config.js";

/**
 * Builds the exact environment handed to the `claude` CLI subprocess
 * (`RealClaudeCodeExecutor.runClaudeCli`) and to `runTests()`'s test-command
 * subprocess — an explicit allow-list (`config.claudeSubprocessEnvAllowList`),
 * never the full parent process environment. This is the single construction
 * site both call sites share, so the policy can't drift between them.
 *
 * `sourceEnv` defaults to `process.env`; tests pass a synthetic object so
 * they never depend on (or mutate) the real process environment.
 */
export function buildClaudeEnvironment(sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of config.claudeSubprocessEnvAllowList) {
    const value = sourceEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
