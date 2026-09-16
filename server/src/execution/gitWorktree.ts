import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { assertSafeRepositoryPath } from "../utils/repositorySafety.js";

const execFileAsync = promisify(execFile);

export class GitWorktreeError extends Error {}

export interface WorktreeInfo {
  workspacePath: string;
  branch: string;
  baseRevision: string;
}

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface DiffResult {
  files: DiffFile[];
  summary: string;
  /** Bounded unified-diff patch text — see `bindPatch()`. */
  patch: string;
  truncated: boolean;
  /** Full, untruncated patch length, regardless of `truncated`. */
  totalPatchChars: number;
}

/**
 * Bounds `rawPatch` to at most `maxChars`, cutting at a `diff --git` file
 * boundary where one exists within budget rather than mid-hunk. If even the
 * first file's section alone exceeds the budget, falls back to a hard
 * character cut — still bounded, still explicitly marked, never silent.
 */
function boundPatch(rawPatch: string, maxChars: number): { patch: string; truncated: boolean } {
  if (rawPatch.length <= maxChars) return { patch: rawPatch, truncated: false };

  const marker = "\n\n--- diff truncated: exceeded the platform's maximum diff size ---\n";
  const budget = Math.max(maxChars - marker.length, 0);

  let lastSafeCut = 0;
  const fileBoundaryPattern = /\ndiff --git /g;
  let match: RegExpExecArray | null;
  while ((match = fileBoundaryPattern.exec(rawPatch)) !== null) {
    if (match.index > budget) break;
    lastSafeCut = match.index;
  }

  const cut = lastSafeCut > 0 ? lastSafeCut : budget;
  return { patch: rawPatch.slice(0, cut) + marker, truncated: true };
}

/**
 * The workspace path and branch name are a pure function of `taskId` —
 * computed once here so `prepare()` and Phase 32's workspace cleanup
 * (`TaskOrchestrator.cleanupWorkspace()`) can never derive it differently
 * from one another.
 */
export function deriveWorkspaceLocation(taskId: string, tasksDir: string): { workspacePath: string; branch: string } {
  return {
    workspacePath: path.join(tasksDir, taskId, "workspace"),
    branch: `agent/task-${taskId}`,
  };
}

/**
 * Every git invocation in this module uses `execFile` with an argument
 * array — never a shell string — so an unusual repository path or branch
 * name can never be interpreted as shell syntax (Phase 28 §12).
 */
async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitWorktreeError(`git ${args.join(" ")} failed: ${(e.stderr || e.message).trim()}`);
  }
}

/**
 * Creates and tears down the isolated git worktree real execution runs
 * against. The developer's own working tree (`repositoryPath`) is only ever
 * read from — `git worktree add` operates on committed history, so any
 * uncommitted local changes there are never copied into the task workspace
 * and the original directory is never written to by this class.
 */
export class GitWorktreeManager {
  async prepare(repositoryPath: string, taskId: string, tasksDir: string): Promise<WorktreeInfo> {
    assertSafeRepositoryPath(repositoryPath);

    let baseRevision: string;
    try {
      baseRevision = (await git(["rev-parse", "HEAD"], repositoryPath)).trim();
    } catch (err) {
      throw new GitWorktreeError(
        `"${repositoryPath}" does not look like a git repository with any commits (${(err as Error).message}). Real execution requires a git repository so changes can be isolated on a branch and reviewed.`
      );
    }

    const { workspacePath, branch } = deriveWorkspaceLocation(taskId, tasksDir);
    await mkdir(path.dirname(workspacePath), { recursive: true });

    // Best-effort self-healing for a retried task id: clear stale worktree
    // registrations and remove a leftover directory from a prior partial run
    // before attempting to create a fresh one.
    await git(["worktree", "prune"], repositoryPath).catch(() => undefined);
    if (existsSync(workspacePath)) {
      await git(["worktree", "remove", "--force", workspacePath], repositoryPath).catch(() => undefined);
    }

    try {
      await git(["worktree", "add", "-B", branch, workspacePath, baseRevision], repositoryPath);
    } catch (err) {
      throw new GitWorktreeError(`Failed to create an isolated worktree for this task: ${(err as Error).message}`);
    }

    return { workspacePath, branch, baseRevision };
  }

  /**
   * Commits whatever real execution changed in the worktree onto the task
   * branch, so the branch is genuinely mergeable/cherry-pickable afterward —
   * an uncommitted diff cannot be merged with ordinary git commands. Uses a
   * per-invocation identity rather than touching the developer's global git
   * config.
   */
  async commitChanges(workspacePath: string, message: string): Promise<{ committed: boolean }> {
    await git(["add", "-A"], workspacePath);
    const status = await git(["status", "--porcelain"], workspacePath);
    if (!status.trim()) return { committed: false };

    await git(
      [
        "-c",
        "user.email=agent@backend-engineering-platform.local",
        "-c",
        "user.name=Backend Engineering Agent",
        "commit",
        "-m",
        message,
      ],
      workspacePath
    );
    return { committed: true };
  }

  /**
   * `maxPatchChars` bounds the captured patch text (Phase 33) — defaulted
   * so every pre-existing caller/test keeps working unchanged; real callers
   * pass `config.maxDiffPatchChars` explicitly.
   */
  async diff(workspacePath: string, baseRevision: string, maxPatchChars = 200_000): Promise<DiffResult> {
    const numstat = await git(["diff", "--numstat", baseRevision, "HEAD"], workspacePath);
    const files: DiffFile[] = numstat
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [add, del, filePath] = line.split("\t");
        return {
          path: filePath,
          additions: add === "-" ? 0 : Number(add),
          deletions: del === "-" ? 0 : Number(del),
        };
      });

    const totalAdd = files.reduce((sum, f) => sum + f.additions, 0);
    const totalDel = files.reduce((sum, f) => sum + f.deletions, 0);
    const summary =
      files.length === 0
        ? "No changes."
        : `${files.length} file${files.length === 1 ? "" : "s"} changed, ${totalAdd} insertion${totalAdd === 1 ? "" : "s"}(+), ${totalDel} deletion${totalDel === 1 ? "" : "s"}(-)`;

    // Ground-truth patch content, not just counts — the actual evidence a
    // reviewer or developer needs to judge the change (Phase 33). Skipped
    // when there's nothing to diff.
    const rawPatch = files.length === 0 ? "" : await git(["diff", baseRevision, "HEAD"], workspacePath);
    const { patch, truncated } = boundPatch(rawPatch, maxPatchChars);

    return { files, summary, patch, truncated, totalPatchChars: rawPatch.length };
  }

  /**
   * Explicit, safe cleanup. Not invoked automatically by any lifecycle
   * event — only ever called for a developer-initiated action (Phase 32
   * manual workspace cleanup; `GitWorktreeManager.prepare()`'s own
   * self-healing removal of a stale worktree uses its own inline,
   * still-best-effort call rather than this method, since a failure there
   * is expected to be immediately followed by re-creating the worktree
   * anyway).
   *
   * Unlike that self-healing path, this method surfaces genuine failures
   * (a locked worktree, a permissions error, ...) by throwing — a caller
   * that reports cleanup success to a developer must be able to trust it.
   * It is still safely re-callable: a workspace directory or branch that's
   * already gone is treated as already-clean, not as an error, so calling
   * this twice in a row (or once against a workspace a developer already
   * removed by hand) never fails.
   */
  async remove(repositoryPath: string, workspacePath: string, branch: string): Promise<void> {
    if (existsSync(workspacePath)) {
      await git(["worktree", "remove", "--force", workspacePath], repositoryPath);
    }
    await git(["worktree", "prune"], repositoryPath).catch(() => undefined);

    const existingBranch = await git(["branch", "--list", branch], repositoryPath).catch(() => "");
    if (existingBranch.trim()) {
      await git(["branch", "-D", branch], repositoryPath);
    }
  }
}
