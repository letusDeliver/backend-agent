import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

/**
 * Stands in for the real `claude` CLI so this suite runs in CI with no
 * credentials, no network, and deterministic timing — while every git
 * operation around it is real. It reads --permission-mode from argv and, for
 * "acceptEdits" (implement()), actually writes a file into its cwd, exactly
 * as a real implementation pass would — so the ground-truth git diff this
 * phase adds has something genuine to compute.
 */
const FAKE_CLI_SOURCE = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const modeIndex = args.indexOf("--permission-mode");
const mode = modeIndex >= 0 ? args[modeIndex + 1] : "";

let payload;
if (mode === "acceptEdits") {
  writeFileSync("generated-by-agent.txt", "hello from the fake claude CLI\\n");
  payload = { changedFiles: ["generated-by-agent.txt"], commandsExecuted: [], notes: ["fake implement"] };
} else {
  payload = {
    recommendation: "do the thing",
    findings: [{ summary: "looked fine", evidence: "fixture repo" }],
    risks: [],
    assumptions: [],
    confidence: 0.9,
    status: "PASS",
  };
}

process.stdout.write(JSON.stringify({ result: "\`\`\`json\\n" + JSON.stringify(payload) + "\\n\`\`\`" }));
`;

let app: Express;
let dataDir: string;
let tasksDir: string;
let repoDir: string;
let fakeCliPath: string;
let unsafeRepoDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "real-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "real-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "real-repo-"));

  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ scripts: {} }));
  await git(["init", "-b", "main"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "add", "-A"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"], repoDir);

  const fakeCliDir = await mkdtemp(path.join(tmpdir(), "fake-cli-"));
  fakeCliPath = path.join(fakeCliDir, "fake-claude.mjs");
  await writeFile(fakeCliPath, FAKE_CLI_SOURCE, "utf-8");
  await chmod(fakeCliPath, 0o755);

  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;
  process.env.CLAUDE_EXECUTION_MODE = "real";
  process.env.CLAUDE_CLI_PATH = fakeCliPath;
  process.env.CLAUDE_TIMEOUT_MS = "10000";

  // Dynamic imports, evaluated only now that the env vars above are set —
  // `config.ts` snapshots them at module-evaluation time, so a static
  // top-level import here would freeze `executionMode` as "mock" before
  // this function ever runs.
  const { config } = await import("../src/config.js");
  const { createApp } = await import("../src/app.js");
  app = createApp();

  // A directory that will pass repository inspection and routing cleanly
  // (it's a real Node/TS project) so the flow actually reaches real-mode
  // workspace preparation — where the safety guard must reject it, because
  // it's the platform's own source directory.
  unsafeRepoDir = path.join(config.repoRoot, "server");
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

async function createAndStart(repository: string) {
  const createRes = await request(app)
    .post("/api/tasks")
    .send({ title: "Add a health route", requirement: "Add a GET /health endpoint.", repository });
  expect(createRes.status).toBe(201);
  const taskId = createRes.body.task.id;

  const startRes = await request(app).post(`/api/tasks/${taskId}/start`);
  expect(startRes.status).toBe(202);
  return taskId;
}

async function waitForTerminal(taskId: string, timeoutMs = 15000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let task;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/tasks/${taskId}`);
    task = res.body.task;
    if (["completed", "blocked", "failed", "cancelled"].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 100));
  }
  return task;
}

describe("Real execution — isolated git worktree end to end", () => {
  it("runs the full pipeline against an isolated worktree/branch and produces a ground-truth diff", async () => {
    const taskId = await createAndStart(repoDir);
    const task = await waitForTerminal(taskId);

    expect(task.status).toBe("completed");
    expect(task.executionWorkspace?.status).toBe("ready");
    expect(task.executionWorkspace.branch).toBe(`agent/task-${taskId}`);

    const branchList = await git(["branch", "--list", task.executionWorkspace.branch], repoDir);
    expect(branchList).toContain(task.executionWorkspace.branch);

    // The developer's own checked-out working tree was never touched.
    const status = await git(["status", "--porcelain"], repoDir);
    expect(status.trim()).toBe("");
    const currentBranch = (await git(["branch", "--show-current"], repoDir)).trim();
    expect(currentBranch).toBe("main");

    const reportRes = await request(app).get(`/api/tasks/${taskId}/execution-report`);
    expect(reportRes.body.report.changedFiles).toContain("generated-by-agent.txt");
    expect(reportRes.body.report.diff.branch).toBe(task.executionWorkspace.branch);
    expect(reportRes.body.report.diff.baseRevision).toBe(task.executionWorkspace.baseRevision);
    expect(reportRes.body.report.diff.files.length).toBeGreaterThan(0);

    // Never auto-merged into the developer's branch.
    const mainLog = await git(["log", "--oneline", "main"], repoDir);
    expect(mainLog).not.toMatch(/Agent:/);
  });

  it("blocks the task with a clear reason when the repository path is unsafe", async () => {
    const createRes = await request(app)
      .post("/api/tasks")
      .send({ title: "Should be blocked", requirement: "Add a GET /health endpoint.", repository: unsafeRepoDir });
    // Task creation itself only validates existence/directory-ness (both
    // mock and real mode); the safety guard fires once real execution
    // actually begins.
    expect(createRes.status).toBe(201);
    const taskId = createRes.body.task.id;

    await request(app).post(`/api/tasks/${taskId}/start`);
    const task = await waitForTerminal(taskId);

    expect(task.status).toBe("blocked");
    expect(task.error).toMatch(/isolated workspace/i);
  });
});
