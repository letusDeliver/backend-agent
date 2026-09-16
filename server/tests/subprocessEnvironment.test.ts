import { mkdtemp, rm, writeFile, chmod, readFile } from "node:fs/promises";
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
 * Drives the real `spawn()` call inside `RealClaudeCodeExecutor.runClaudeCli`
 * (Phase 35's actual production code path, not a mocked/reimplemented
 * version of it) by pointing CLAUDE_CLI_PATH at a fake CLI that reports back
 * exactly what environment it was actually started with — proving the
 * allow-list is applied where it matters, not merely that the helper
 * function returns the right object in isolation (see claudeEnvironment.test.ts
 * for that unit-level coverage).
 *
 * The log path is baked directly into the generated script text — reading it
 * from an environment variable at runtime would only prove the allow-list
 * lets that specific variable through, which defeats the point of the test.
 */
function buildFakeCliSource(envLogPath: string): string {
  return `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const modeIndex = args.indexOf("--permission-mode");
const mode = modeIndex >= 0 ? args[modeIndex + 1] : "";

writeFileSync(${JSON.stringify(envLogPath)}, JSON.stringify(process.env), "utf-8");

let payload;
if (mode === "acceptEdits") {
  writeFileSync("generated-by-agent.txt", "phase 35 subprocess-env fixture\\n");
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
}

let app: Express;
let dataDir: string;
let tasksDir: string;
let repoDir: string;
let fakeCliPath: string;
let envLogPath: string;

const SENTINEL_KEY = "PHASE35_UNRELATED_SECRET";
const SENTINEL_VALUE = "should-never-reach-the-claude-subprocess";

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "subenv-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "subenv-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "subenv-repo-"));

  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ scripts: {} }));
  await git(["init", "-b", "main"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "add", "-A"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"], repoDir);

  const logDir = await mkdtemp(path.join(tmpdir(), "subenv-log-"));
  envLogPath = path.join(logDir, "env.json");

  const fakeCliDir = await mkdtemp(path.join(tmpdir(), "subenv-fake-cli-"));
  fakeCliPath = path.join(fakeCliDir, "fake-claude.mjs");
  await writeFile(fakeCliPath, buildFakeCliSource(envLogPath), "utf-8");
  await chmod(fakeCliPath, 0o755);

  // A stand-in for a real secret that happens to be present in the server's
  // own process environment (e.g. an unrelated API key) but has no business
  // reaching a subprocess that operates inside a developer's repository.
  process.env[SENTINEL_KEY] = SENTINEL_VALUE;

  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;
  process.env.CLAUDE_EXECUTION_MODE = "real";
  process.env.CLAUDE_CLI_PATH = fakeCliPath;
  process.env.CLAUDE_TIMEOUT_MS = "10000";

  // Dynamic import evaluated only now that env vars above are set — see
  // realExecution.test.ts for why a static top-level import would freeze
  // config prematurely.
  const { createApp } = await import("../src/app.js");
  app = createApp();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
  delete process.env[SENTINEL_KEY];
});

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

describe("claude subprocess environment allow-list (Phase 35)", () => {
  it("never forwards an unrelated variable present in the server's own environment, while still forwarding PATH", async () => {
    const createRes = await request(app)
      .post("/api/tasks")
      .send({ title: "Add a health route", requirement: "Add a GET /health endpoint.", repository: repoDir });
    expect(createRes.status).toBe(201);
    const taskId = createRes.body.task.id;

    await request(app).post(`/api/tasks/${taskId}/start`);
    const task = await waitForTerminal(taskId);
    expect(task.status).toBe("completed");

    const observedEnv = JSON.parse(await readFile(envLogPath, "utf-8"));

    expect(observedEnv).not.toHaveProperty(SENTINEL_KEY);
    expect(observedEnv.PATH).toBeTruthy();
  });
});
