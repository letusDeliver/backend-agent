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

    const branch = `agent/task-${taskId}`;
    const workspacePath = path.join(tasksDir, taskId, "workspace");
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

  async diff(workspacePath: string, baseRevision: string): Promise<DiffResult> {
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

    return { files, summary };
  }

  /**
   * Explicit, safe cleanup — not invoked automatically by any lifecycle
   * event in this phase (Phase 28 §16: no deletion merely because a task
   * failed or was cancelled). Exists as the seam a future maintenance
   * command or scheduled job can use.
   */
  async remove(repositoryPath: string, workspacePath: string, branch: string): Promise<void> {
    await git(["worktree", "remove", "--force", workspacePath], repositoryPath).catch(() => undefined);
    await git(["worktree", "prune"], repositoryPath).catch(() => undefined);
    await git(["branch", "-D", branch], repositoryPath).catch(() => undefined);
  }
}
