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

// Sleeps far longer than the configured CLAUDE_TIMEOUT_MS below, so the
// executor's own timeout must fire — the script never gets to respond on
// its own.
const SLOW_FAKE_CLI_SOURCE = `#!/usr/bin/env node
await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CLI_SLEEP_MS ?? "5000")));
process.stdout.write(JSON.stringify({ result: "\`\`\`json\\n{}\\n\`\`\`" }));
`;

let app: Express;
let repoDir: string;

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "timeout-data-"));
  const tasksDir = await mkdtemp(path.join(tmpdir(), "timeout-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "timeout-repo-"));

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
  process.env.CLAUDE_TIMEOUT_MS = "800"; // much shorter than the CLI's sleep
  process.env.FAKE_CLI_SLEEP_MS = "5000";

  const { createApp } = await import("../src/app.js");
  app = createApp();
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("Real execution — timeout handling", () => {
  it("terminates a hung claude CLI call after the configured timeout and reports it clearly, never as success", async () => {
    const startedAt = Date.now();

    const createRes = await request(app)
      .post("/api/tasks")
      .send({ title: "Add a health route", requirement: "Add a GET /health endpoint.", repository: repoDir });
    const taskId = createRes.body.task.id;
    await request(app).post(`/api/tasks/${taskId}/start`);

    let task;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const res = await request(app).get(`/api/tasks/${taskId}`);
      task = res.body.task;
      if (["completed", "blocked", "failed"].includes(task.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const elapsedMs = Date.now() - startedAt;

    // Proves the timeout actually killed the process rather than us simply
    // waiting out the full 5s sleep — if the kill hadn't worked, this would
    // take ~5000ms instead.
    expect(elapsedMs).toBeLessThan(3000);

    expect(task.status).not.toBe("completed");

    const agentsRes = await request(app).get(`/api/tasks/${taskId}/agents`);
    const report = agentsRes.body.reports[0];
    expect(report.status).toBe("failed");
    expect(report.assumptions.join(" ")).toMatch(/timed out after 800ms/);
  });
});
