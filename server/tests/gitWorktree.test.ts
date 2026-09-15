import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
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

describe("GitWorktreeManager.remove", () => {
  it("removes the worktree and deletes the task branch", async () => {
    const info = await manager.prepare(repoDir, "task-9", tasksDir);
    expect(existsSync(info.workspacePath)).toBe(true);

    await manager.remove(repoDir, info.workspacePath, info.branch);

    expect(existsSync(info.workspacePath)).toBe(false);
    const branches = await git(["branch", "--list", info.branch], repoDir);
    expect(branches.trim()).toBe("");
  });
});
