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
 * Same fake-CLI convention as realExecution.test.ts, extended (Phase 33) so
 * it (a) writes multi-line, distinctively-markered content during
 * implement() so there's genuine patch content to thread through review,
 * and (b) logs every prompt it receives (via FAKE_CLI_PROMPT_LOG) so this
 * suite can assert on the *actual* review prompt content, not just on the
 * pipeline's final status.
 */
const FAKE_CLI_SOURCE = `#!/usr/bin/env node
import { writeFileSync, appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const modeIndex = args.indexOf("--permission-mode");
const mode = modeIndex >= 0 ? args[modeIndex + 1] : "";
const promptIndex = args.indexOf("-p");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : "";

if (process.env.FAKE_CLI_PROMPT_LOG) {
  appendFileSync(process.env.FAKE_CLI_PROMPT_LOG, prompt + "\\n<<<PROMPT-BOUNDARY>>>\\n");
}

let payload;
if (mode === "acceptEdits") {
  writeFileSync("generated-by-agent.txt", "PHASE_33_DISTINCTIVE_PATCH_MARKER\\nsecond line of the change\\n");
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
let promptLogPath: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "diffreview-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "diffreview-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "diffreview-repo-"));

  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ scripts: {} }));
  await git(["init", "-b", "main"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "add", "-A"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"], repoDir);

  const fakeCliDir = await mkdtemp(path.join(tmpdir(), "diffreview-fake-cli-"));
  fakeCliPath = path.join(fakeCliDir, "fake-claude.mjs");
  await writeFile(fakeCliPath, FAKE_CLI_SOURCE, "utf-8");
  await chmod(fakeCliPath, 0o755);

  const logDir = await mkdtemp(path.join(tmpdir(), "diffreview-log-"));
  promptLogPath = path.join(logDir, "prompts.log");
  await writeFile(promptLogPath, "", "utf-8");

  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;
  process.env.CLAUDE_EXECUTION_MODE = "real";
  process.env.CLAUDE_CLI_PATH = fakeCliPath;
  process.env.CLAUDE_TIMEOUT_MS = "10000";
  process.env.FAKE_CLI_PROMPT_LOG = promptLogPath;

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
  delete process.env.FAKE_CLI_PROMPT_LOG;
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

describe("Review receives the ground-truth diff patch (Phase 33)", () => {
  it("threads the actual patch content into the review prompt, framed as untrusted content", async () => {
    const createRes = await request(app)
      .post("/api/tasks")
      .send({ title: "Add a health route", requirement: "Add a GET /health endpoint.", repository: repoDir });
    expect(createRes.status).toBe(201);
    const taskId = createRes.body.task.id;

    await request(app).post(`/api/tasks/${taskId}/start`);
    const task = await waitForTerminal(taskId);
    expect(task.status).toBe("completed");

    // Ground truth: the execution report's diff independently contains the
    // distinctive marker the fake CLI actually wrote to disk.
    const reportRes = await request(app).get(`/api/tasks/${taskId}/execution-report`);
    const diff = reportRes.body.report.diff;
    expect(diff.patch).toContain("+PHASE_33_DISTINCTIVE_PATCH_MARKER");
    expect(diff.truncated).toBe(false);

    // Not merely "the word diff appears" — the review prompt the fake CLI
    // actually received must contain that same distinctive patch content,
    // proving it was threaded through, not just computed and discarded.
    const promptLog = await readFile(promptLogPath, "utf-8");
    const prompts = promptLog
      .split("<<<PROMPT-BOUNDARY>>>")
      .map((p) => p.trim())
      .filter(Boolean);
    const reviewPrompts = prompts.filter((p) => p.includes("Test evidence:"));
    expect(reviewPrompts.length).toBeGreaterThan(0);

    for (const reviewPrompt of reviewPrompts) {
      expect(reviewPrompt).toContain("+PHASE_33_DISTINCTIVE_PATCH_MARKER");
      expect(reviewPrompt).toContain("UNTRUSTED REPOSITORY CONTENT");
      expect(reviewPrompt).not.toContain("WARNING: this diff was truncated");
    }
  });
});
