import path from "node:path";
import os from "node:os";
import { realpathSync } from "node:fs";
import { config } from "../config.js";
import { InvalidRepositoryPathError } from "./paths.js";

const sep = path.sep;

/**
 * Resolves a path to its canonical, symlink-free form. Used for every value
 * compared below so a symlink can never make a target look like it's outside
 * a denied root (or inside an allowed one) when it actually resolves inside
 * (or outside) it — e.g. on macOS `/etc` is itself a symlink to `/private/etc`,
 * so the deny-list must compare against the same canonical form a symlinked
 * target would resolve to, not the literal string `/etc`.
 *
 * `required` paths (the developer-supplied target) must resolve — a dangling
 * symlink or a path that no longer exists fails loudly with the same error
 * type this module already throws for other invalid inputs. `best-effort`
 * paths (the fixed comparison roots — home directory, platform source root,
 * well-known system directories) fall back to a lexical resolve if they
 * don't exist on this platform (e.g. `/System` on Linux): a root that can't
 * be canonicalized still can't be reached by a target that *can*, so the
 * comparison remains safe either way.
 */
function canonicalize(rawPath: string, mode: "required" | "best-effort"): string {
  const lexical = path.resolve(rawPath);
  try {
    return realpathSync(lexical);
  } catch (err) {
    if (mode === "required") {
      throw new InvalidRepositoryPathError(
        `Cannot resolve the real location of "${lexical}": ${(err as Error).message}`
      );
    }
    return lexical;
  }
}

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
 *
 * All comparisons use the canonical (symlink-resolved) form of every path
 * involved, not the lexical one a developer typed or a symlink presents —
 * otherwise a symlink inside an allowed-looking directory (or the target
 * itself being a symlink) could resolve to a denied location without ever
 * matching the deny-list's literal strings.
 */
export function assertSafeRepositoryPath(resolvedPath: string): void {
  const target = canonicalize(resolvedPath, "required");
  const home = canonicalize(os.homedir(), "best-effort");
  const platformRoot = canonicalize(config.repoRoot, "best-effort");

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
    // to try real execution safely. Canonicalizing the entries below (e.g.
    // `/etc` -> `/private/etc`) still blocks a symlink resolving into one of
    // *these specific* denied roots without blocking `/private` wholesale.
  ].map((p) => canonicalize(p, "best-effort"));

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
