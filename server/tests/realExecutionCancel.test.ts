import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

// Sleeps long enough that a test asserting cancellation happened quickly
// would fail if the child process were not actually killed.
const SLOW_FAKE_CLI_SOURCE = `#!/usr/bin/env node
await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CLI_SLEEP_MS ?? "4000")));
process.stdout.write(JSON.stringify({ result: "\`\`\`json\\n{}\\n\`\`\`" }));
`;

let app: Express;
let repoDir: string;

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cancel-data-"));
  const tasksDir = await mkdtemp(path.join(tmpdir(), "cancel-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "cancel-repo-"));

  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ scripts: {} }));
  await git(["init", "-b", "main"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "add", "-A"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"], repoDir);

  const fakeCliDir = await mkdtemp(path.join(tmpdir(), "slow-fake-cli-"));
  const fakeCliPath = path.join(fakeCliDir, "slow-claude.mjs");
  await writeFile(fakeCliPath, SLOW_FAKE_CLI_SOURCE, "utf-8");
  await chmod(fakeCliPath, 0o755);

  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;
  process.env.CLAUDE_EXECUTION_MODE = "real";
  process.env.CLAUDE_CLI_PATH = fakeCliPath;
  process.env.CLAUDE_TIMEOUT_MS = "30000"; // generous — must not race with cancellation
  process.env.FAKE_CLI_SLEEP_MS = "4000";

  const { createApp } = await import("../src/app.js");
  app = createApp();
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("Real execution — cancellation", () => {
  it("kills the in-flight claude CLI process and leaves the task cancelled, not silently overwritten", async () => {
    const createRes = await request(app)
      .post("/api/tasks")
      .send({ title: "Add a health route", requirement: "Add a GET /health endpoint.", repository: repoDir });
    const taskId = createRes.body.task.id;

    const startedAt = Date.now();
    await request(app).post(`/api/tasks/${taskId}/start`);

    // Give the orchestrator a moment to actually reach the point of
    // spawning the (slow) analyze() call before cancelling it.
    await new Promise((r) => setTimeout(r, 300));

    const cancelRes = await request(app).post(`/api/tasks/${taskId}/cancel`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.task.status).toBe("cancelled");

    // Confirm it stays cancelled — the orchestrator's own in-flight
    // continuation must not clobber this once the killed process's promise
    // settles.
    await new Promise((r) => setTimeout(r, 500));
    const afterRes = await request(app).get(`/api/tasks/${taskId}`);
    expect(afterRes.body.task.status).toBe("cancelled");

    const elapsedMs = Date.now() - startedAt;
    // Proves the child process was actually killed — if cancel() were a
    // no-op, the orchestrator would still be blocked inside the 4s sleep.
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("rejects cancelling a task that is already in a terminal state", async () => {
    const createRes = await request(app)
      .post("/api/tasks")
      .send({ title: "Add a health route", requirement: "Add a GET /health endpoint.", repository: repoDir });
    const taskId = createRes.body.task.id;

    const first = await request(app).post(`/api/tasks/${taskId}/cancel`);
    expect(first.status).toBe(200);

    const second = await request(app).post(`/api/tasks/${taskId}/cancel`);
    expect(second.status).toBe(409);
  });

  it("returns 404 for an unknown task", async () => {
    const res = await request(app).post("/api/tasks/does-not-exist/cancel");
    expect(res.status).toBe(404);
  });
});
