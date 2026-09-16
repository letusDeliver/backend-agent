import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorktreeError, GitWorktreeManager } from "../src/execution/gitWorktree.js";
import { InvalidRepositoryPathError } from "../src/utils/paths.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

let repoDir: string;
let tasksDir: string;
const manager = new GitWorktreeManager();

beforeEach(async () => {
  repoDir = await mkdtemp(path.join(tmpdir(), "worktree-repo-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "worktree-tasks-"));

  await git(["init", "-b", "main"], repoDir);
  await writeFile(path.join(repoDir, "README.md"), "hello\n");
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "add", "-A"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"], repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
});

describe("GitWorktreeManager.prepare", () => {
  it("creates an isolated worktree on a task-specific branch at the expected base revision", async () => {
    const head = (await git(["rev-parse", "HEAD"], repoDir)).trim();
    const info = await manager.prepare(repoDir, "task-1", tasksDir);

    expect(info.branch).toBe("agent/task-task-1");
    expect(info.baseRevision).toBe(head);
    expect(existsSync(info.workspacePath)).toBe(true);
    expect(existsSync(path.join(info.workspacePath, "README.md"))).toBe(true);
  });

  it("never modifies the developer's own working tree", async () => {
    await writeFile(path.join(repoDir, "untracked.txt"), "local work in progress\n");
    await manager.prepare(repoDir, "task-2", tasksDir);

    const status = await git(["status", "--porcelain"], repoDir);
    expect(status).toContain("untracked.txt"); // still there, untouched, never staged/committed
    expect(await readFile(path.join(repoDir, "untracked.txt"), "utf-8")).toBe("local work in progress\n");
  });

  it("does not copy uncommitted changes into the isolated workspace", async () => {
    await writeFile(path.join(repoDir, "wip.txt"), "not committed yet\n");
    const info = await manager.prepare(repoDir, "task-3", tasksDir);
    expect(existsSync(path.join(info.workspacePath, "wip.txt"))).toBe(false);
  });

  it("rejects a directory that is not a git repository", async () => {
    const plainDir = await mkdtemp(path.join(tmpdir(), "plain-"));
    await expect(manager.prepare(plainDir, "task-4", tasksDir)).rejects.toThrow(GitWorktreeError);
    await rm(plainDir, { recursive: true, force: true });
  });

  it("rejects a repository with no commits", async () => {
    const emptyRepo = await mkdtemp(path.join(tmpdir(), "empty-repo-"));
    await git(["init", "-b", "main"], emptyRepo);
    await expect(manager.prepare(emptyRepo, "task-5", tasksDir)).rejects.toThrow(GitWorktreeError);
    await rm(emptyRepo, { recursive: true, force: true });
  });

  it("propagates the repository-safety guard", async () => {
    await expect(manager.prepare(os.homedir(), "task-6", tasksDir)).rejects.toThrow(InvalidRepositoryPathError);
  });
});

describe("GitWorktreeManager.commitChanges + diff", () => {
  it("commits real file changes onto the task branch and reports a ground-truth diff", async () => {
    const info = await manager.prepare(repoDir, "task-7", tasksDir);
    await writeFile(path.join(info.workspacePath, "new-file.txt"), "line one\nline two\n");

    const { committed } = await manager.commitChanges(info.workspacePath, "Agent: add new file");
    expect(committed).toBe(true);

    const diff = await manager.diff(info.workspacePath, info.baseRevision);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0].path).toBe("new-file.txt");
    expect(diff.files[0].additions).toBe(2);
    expect(diff.summary).toMatch(/1 file changed/);

    // The commit landed on the isolated branch, not on the developer's main branch.
    const mainLog = await git(["log", "--oneline", "main"], repoDir);
    expect(mainLog).not.toMatch(/add new file/);
    const branchLog = await git(["log", "--oneline", info.branch], repoDir);
    expect(branchLog).toMatch(/add new file/);
  });

  it("reports nothing committed when there are no changes to commit", async () => {
    const info = await manager.prepare(repoDir, "task-8", tasksDir);
    const { committed } = await manager.commitChanges(info.workspacePath, "Agent: no-op");
    expect(committed).toBe(false);
  });
});

describe("GitWorktreeManager.diff — patch content (Phase 33)", () => {
  it("captures the actual patch content, matching an independently-run git diff", async () => {
    const info = await manager.prepare(repoDir, "task-10", tasksDir);
    await writeFile(path.join(info.workspacePath, "new-file.txt"), "line one\nline two\n");
    await manager.commitChanges(info.workspacePath, "Agent: add new file");

    const diff = await manager.diff(info.workspacePath, info.baseRevision);
    const independentPatch = await git(["diff", info.baseRevision, "HEAD"], info.workspacePath);

    expect(diff.patch).toBe(independentPatch);
    expect(diff.truncated).toBe(false);
    expect(diff.totalPatchChars).toBe(independentPatch.length);
    expect(diff.patch).toContain("+line one");
    expect(diff.patch).toContain("+line two");
  });

  it("reports an empty, non-truncated patch when nothing was committed", async () => {
    const info = await manager.prepare(repoDir, "task-11", tasksDir);
    const diff = await manager.diff(info.workspacePath, info.baseRevision);
    expect(diff.files).toHaveLength(0);
    expect(diff.patch).toBe("");
    expect(diff.truncated).toBe(false);
    expect(diff.totalPatchChars).toBe(0);
  });

  it("does not truncate a patch that fits exactly within the limit", async () => {
    const info = await manager.prepare(repoDir, "task-12", tasksDir);
    await writeFile(path.join(info.workspacePath, "sized.txt"), "content\n");
    await manager.commitChanges(info.workspacePath, "Agent: add sized file");

    const full = await manager.diff(info.workspacePath, info.baseRevision, 10_000_000);
    const atLimit = await manager.diff(info.workspacePath, info.baseRevision, full.totalPatchChars);

    expect(atLimit.truncated).toBe(false);
    expect(atLimit.patch).toBe(full.patch);
  });

  it("truncates a patch that exceeds the limit, explicitly and deterministically", async () => {
    const info = await manager.prepare(repoDir, "task-13", tasksDir);
    await writeFile(path.join(info.workspacePath, "sized.txt"), "content\n");
    await manager.commitChanges(info.workspacePath, "Agent: add sized file");

    const full = await manager.diff(info.workspacePath, info.baseRevision, 10_000_000);
    const overLimit = await manager.diff(info.workspacePath, info.baseRevision, full.totalPatchChars - 1);

    expect(overLimit.truncated).toBe(true);
    expect(overLimit.patch.length).toBeLessThanOrEqual(full.totalPatchChars - 1);
    expect(overLimit.patch).toContain("diff truncated");
    expect(overLimit.totalPatchChars).toBe(full.totalPatchChars);
  });

  it("cuts at a file boundary rather than mid-hunk when the limit falls between two files' sections", async () => {
    const info = await manager.prepare(repoDir, "task-14", tasksDir);
    await writeFile(path.join(info.workspacePath, "first.txt"), "alpha\nbeta\n");
    await writeFile(
      path.join(info.workspacePath, "second.txt"),
      Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n") + "\n"
    );
    await manager.commitChanges(info.workspacePath, "Agent: add two files");

    const full = await manager.diff(info.workspacePath, info.baseRevision, 10_000_000);
    const secondFileBoundary = full.patch.indexOf("\ndiff --git", 1);
    expect(secondFileBoundary).toBeGreaterThan(0);

    // A limit generous enough to include the first file's complete section
    // plus the truncation marker, but well short of the second file's full
    // (deliberately large) section — the safe cut is the file boundary
    // itself, never a mid-hunk cut into the second file's content.
    const truncated = await manager.diff(info.workspacePath, info.baseRevision, secondFileBoundary + 200);

    expect(truncated.truncated).toBe(true);
    expect(truncated.patch.startsWith(full.patch.slice(0, secondFileBoundary))).toBe(true);
    expect(truncated.patch).not.toContain("+line-0");
  });
});

describe("GitWorktreeManager.remove", () => {
  it("removes the worktree and deletes the task branch", async () => {
    const info = await manager.prepare(repoDir, "task-9", tasksDir);
    expect(existsSync(info.workspacePath)).toBe(true);

    await manager.remove(repoDir, info.workspacePath, info.branch);

    expect(existsSync(info.workspacePath)).toBe(false);
    const branches = await git(["branch", "--list", info.branch], repoDir);
    expect(branches.trim()).toBe("");
  });

  it("is idempotent — calling it again once already removed does not throw", async () => {
    const info = await manager.prepare(repoDir, "task-9b", tasksDir);
    await manager.remove(repoDir, info.workspacePath, info.branch);

    await expect(manager.remove(repoDir, info.workspacePath, info.branch)).resolves.toBeUndefined();
  });

  it("surfaces a genuine removal failure instead of swallowing it (Phase 32)", async () => {
    // A directory that exists on disk but was never registered as a git
    // worktree (via `git worktree add`) — `git worktree remove --force`
    // fails against it ("is not a working tree"), which is exactly the
    // kind of real failure a developer-facing cleanup action must surface
    // rather than silently report as success.
    const fakeWorkspace = path.join(tasksDir, "not-a-real-worktree");
    await mkdir(fakeWorkspace, { recursive: true });

    await expect(manager.remove(repoDir, fakeWorkspace, "agent/task-nonexistent")).rejects.toThrow(GitWorktreeError);
  });
});
