import path from "node:path";
import os from "node:os";
import { config } from "../config.js";
import { InvalidRepositoryPathError } from "./paths.js";

const sep = path.sep;

/**
 * Filesystem-level boundary check, run before real Claude Code execution is
 * ever allowed to touch a repository (never for mock mode, which doesn't
 * write to disk). This is deliberately separate from `resolveRepositoryPath`
 * (which every task, mock or real, already passes through): that function
 * only asks "does this exist and is it a directory," while this asks "is it
 * *safe* to let an AI agent write to." A path can easily satisfy the first
 * and fail the second.
 *
 * Combines positive validation (must look like an isolated project
 * directory) with a deny-list of well-known dangerous roots — a deny-list
 * alone can never be exhaustive, but a purely positive check can't rule out
 * every unwise-but-technically-valid target either, so both run.
 */
export function assertSafeRepositoryPath(resolvedPath: string): void {
  const target = path.resolve(resolvedPath);
  const home = path.resolve(os.homedir());
  const platformRoot = path.resolve(config.repoRoot);

  const systemRoots = [
    path.parse(target).root, // filesystem root, e.g. "/" or "C:\"
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
    "/Applications",
    // Deliberately NOT /var or /private: on macOS those are the resolved
    // parents of both the OS temp directory and /tmp itself (symlinked),
    // which is exactly where disposable test/fixture repositories legitimately
    // live — blocking them would reject the platform's own recommended way
    // to try real execution safely.
  ].map((p) => path.resolve(p));

  if (target === home) {
    throw new InvalidRepositoryPathError(
      `Refusing real execution against your home directory (${target}). Point it at a specific project directory instead.`
    );
  }

  for (const systemRoot of systemRoots) {
    if (target === systemRoot || target.startsWith(systemRoot + sep)) {
      throw new InvalidRepositoryPathError(
        `Refusing real execution against a system directory (${target}). Point it at a specific project directory instead.`
      );
    }
  }

  // Reject the platform's own source tree in either direction: the target
  // is inside the platform's repo, the target *is* the platform's repo, or
  // the platform's repo is nested inside the target (which would give real
  // execution write access to its own source as a side effect).
  const targetContainsPlatform = platformRoot === target || platformRoot.startsWith(target + sep);
  const platformContainsTarget = target === platformRoot || target.startsWith(platformRoot + sep);
  if (targetContainsPlatform || platformContainsTarget) {
    throw new InvalidRepositoryPathError(
      `Refusing real execution against the platform's own source directory or an ancestor of it (${target}). This would give the agent write access to the orchestrator's own code.`
    );
  }
}
