import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { Task } from "../src/types/index.js";

const execFileAsync = promisify(execFile);
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

let app: Express;
let dataDir: string;
let tasksDir: string;
let repoDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "cleanupapi-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "cleanupapi-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "cleanupapi-repo-"));

  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ dependencies: { express: "^4.0.0" }, scripts: { test: "echo ok" } }));
  await git(["init", "-b", "main"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "add", "-A"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"], repoDir);

  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;

  const { createApp } = await import("../src/app.js");
  app = createApp();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

async function waitForStatus(taskId: string, statuses: string[], timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/api/tasks/${taskId}`);
    if (statuses.includes(res.body.task.status)) return res.body.task.status;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for status in [${statuses.join(", ")}]`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The app under test runs in the default mock execution mode (no real
 * `claude` CLI available in CI), so it never prepares a real workspace on
 * its own. To exercise a genuine 200/real-git-verified cleanup over HTTP,
 * this helper attaches a real, `GitWorktreeManager`-prepared workspace to
 * an already-created task directly through the shared `container.js`
 * wiring — the same synthetic-state technique `retryApi.test.ts` and
 * `reconciliationApi.test.ts` already use for deterministic API tests,
 * extended one step further to a genuinely real (not faked) worktree.
 */
async function attachRealWorkspace(taskId: string, status: Task["status"]): Promise<Task> {
  const { taskStore, gitWorktrees } = await import("../src/container.js");
  const task = await taskStore.get(taskId);
  if (!task) throw new Error("expected seed task to exist");
  const info = await gitWorktrees.prepare(repoDir, taskId, tasksDir);
  task.executionMode = "real";
  task.executionWorkspace = { workspacePath: info.workspacePath, branch: info.branch, baseRevision: info.baseRevision, status: "ready", createdAt: new Date().toISOString() };
  task.status = status;
  task.updatedAt = new Date().toISOString();
  await taskStore.update(task);
  return task;
}

describe("POST /tasks/:id/cleanup-workspace", () => {
  it("404s for an unknown task", async () => {
    const res = await request(app).post("/api/tasks/does-not-exist/cleanup-workspace");
    expect(res.status).toBe(404);
  });

  it("409s for a mock-mode task even once terminal", async () => {
    const createRes = await request(app).post("/api/tasks").send({
      title: "Add a GET /health endpoint",
      requirement: "Add a GET /health endpoint.",
      repository: repoDir,
    });
    const taskId = createRes.body.task.id;
    await request(app).post(`/api/tasks/${taskId}/start`);
    await waitForStatus(taskId, ["completed", "failed", "blocked"]);

    const res = await request(app).post(`/api/tasks/${taskId}/cleanup-workspace`);
    expect(res.status).toBe(409);
  });

  it("200s for a terminal real-mode task and genuinely removes the worktree and branch", async () => {
    const createRes = await request(app).post("/api/tasks").send({
      title: "Add a GET /health endpoint",
      requirement: "Add a GET /health endpoint.",
      repository: repoDir,
    });
    const taskId = createRes.body.task.id;
    const task = await attachRealWorkspace(taskId, "completed");
    const { workspacePath, branch } = task.executionWorkspace!;
    expect(existsSync(workspacePath)).toBe(true);

    const res = await request(app).post(`/api/tasks/${taskId}/cleanup-workspace`);
    expect(res.status).toBe(200);
    expect(res.body.task.executionWorkspace.cleanupStatus).toBe("cleaned");
    expect(res.body.task.status).toBe("completed");

    expect(existsSync(workspacePath)).toBe(false);
    const branches = await git(["branch", "--list", branch], repoDir);
    expect(branches.trim()).toBe("");
  });

  it("409s for a blocked real-mode task and leaves the worktree untouched", async () => {
    const createRes = await request(app).post("/api/tasks").send({
      title: "Add a GET /health endpoint",
      requirement: "Add a GET /health endpoint.",
      repository: repoDir,
    });
    const taskId = createRes.body.task.id;
    const task = await attachRealWorkspace(taskId, "blocked");
    const { workspacePath, branch } = task.executionWorkspace!;

    const res = await request(app).post(`/api/tasks/${taskId}/cleanup-workspace`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/blocked/i);

    expect(existsSync(workspacePath)).toBe(true);
    const branches = await git(["branch", "--list", branch], repoDir);
    expect(branches.trim()).not.toBe("");
  });

  it("409s a second cleanup request for an already-cleaned workspace", async () => {
    const createRes = await request(app).post("/api/tasks").send({
      title: "Add a GET /health endpoint",
      requirement: "Add a GET /health endpoint.",
      repository: repoDir,
    });
    const taskId = createRes.body.task.id;
    await attachRealWorkspace(taskId, "failed");

    const first = await request(app).post(`/api/tasks/${taskId}/cleanup-workspace`);
    expect(first.status).toBe(200);

    const second = await request(app).post(`/api/tasks/${taskId}/cleanup-workspace`);
    expect(second.status).toBe(409);
  });
});
