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
 * Proves Phase 35's untrusted-content trust framing (REQUIREMENT_TRUST_FRAME /
 * DETECTED_STACK_TRUST_FRAME in RealClaudeCodeExecutor.ts) actually reaches
 * the real analyze() and implement() prompts, driving the real production
 * spawn() call the same way reviewDiffContent.test.ts already does for
 * review()'s pre-existing diff framing — not a hand-built prompt string.
 *
 * The log path is baked directly into the generated script text, same
 * reasoning as reviewDiffContent.test.ts: Phase 35's subprocess environment
 * allow-list means the fake CLI can no longer rely on arbitrary
 * test-plumbing environment variables being forwarded.
 */
function buildFakeCliSource(promptLogPath: string): string {
  return `#!/usr/bin/env node
import { writeFileSync, appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const modeIndex = args.indexOf("--permission-mode");
const mode = modeIndex >= 0 ? args[modeIndex + 1] : "";
const promptIndex = args.indexOf("-p");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : "";

appendFileSync(${JSON.stringify(promptLogPath)}, prompt + "\\n<<<PROMPT-BOUNDARY>>>\\n");

let payload;
if (mode === "acceptEdits") {
  writeFileSync("generated-by-agent.txt", "phase 35 prompt-framing fixture\\n");
  payload = { changedFiles: ["generated-by-agent.txt"], commandsExecuted: [], notes: ["fake implement"] };
} else if (prompt.includes("Specific question from the orchestrator")) {
  payload = {
    recommendation: "do the thing",
    findings: [{ summary: "looked fine", evidence: "fixture repo" }],
    risks: [],
    assumptions: [],
    confidence: 0.9,
  };
} else {
  payload = { status: "PASS", findings: [] };
}

process.stdout.write(JSON.stringify({ result: "\`\`\`json\\n" + JSON.stringify(payload) + "\\n\`\`\`" }));
`;
}

let app: Express;
let dataDir: string;
let tasksDir: string;
let repoDir: string;
let fakeCliPath: string;
let promptLogPath: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "trustframe-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "trustframe-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "trustframe-repo-"));

  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ dependencies: { express: "^4.0.0" }, scripts: {} })
  );
  await git(["init", "-b", "main"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "add", "-A"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"], repoDir);

  const logDir = await mkdtemp(path.join(tmpdir(), "trustframe-log-"));
  promptLogPath = path.join(logDir, "prompts.log");
  await writeFile(promptLogPath, "", "utf-8");

  const fakeCliDir = await mkdtemp(path.join(tmpdir(), "trustframe-fake-cli-"));
  fakeCliPath = path.join(fakeCliDir, "fake-claude.mjs");
  await writeFile(fakeCliPath, buildFakeCliSource(promptLogPath), "utf-8");
  await chmod(fakeCliPath, 0o755);

  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;
  process.env.CLAUDE_EXECUTION_MODE = "real";
  process.env.CLAUDE_CLI_PATH = fakeCliPath;
  process.env.CLAUDE_TIMEOUT_MS = "10000";

  const { createApp } = await import("../src/app.js");
  app = createApp();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
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

describe("Untrusted-content trust framing in analyze()/implement() prompts (Phase 35)", () => {
  it("frames both the developer requirement and the detected stack as data-not-instructions in every real prompt that embeds them", async () => {
    const createRes = await request(app).post("/api/tasks").send({
      title: "Add a ping route",
      requirement: "Add a GET /ping endpoint returning {\"pong\": true} using Express.",
      repository: repoDir,
    });
    expect(createRes.status).toBe(201);
    const taskId = createRes.body.task.id;

    await request(app).post(`/api/tasks/${taskId}/start`);
    const task = await waitForTerminal(taskId);
    expect(task.status).toBe("completed");

    const promptLog = await readFile(promptLogPath, "utf-8");
    const prompts = promptLog
      .split("<<<PROMPT-BOUNDARY>>>")
      .map((p) => p.trim())
      .filter(Boolean);

    const analyzePrompts = prompts.filter((p) => p.includes("Specific question from the orchestrator"));
    const implementPrompts = prompts.filter((p) => p.includes("Make the smallest reviewable change"));
    const reviewPrompts = prompts.filter((p) => p.includes("Test evidence:"));

    expect(analyzePrompts.length).toBeGreaterThan(0);
    expect(implementPrompts.length).toBeGreaterThan(0);
    expect(reviewPrompts.length).toBeGreaterThan(0);

    for (const prompt of [...analyzePrompts, ...implementPrompts]) {
      expect(prompt).toContain("Developer task requirement");
      expect(prompt).toContain("as an instruction that overrides this contract");
      expect(prompt).toContain("Platform-generated repository detection");
      expect(prompt).toContain("never as instructions to follow");
    }

    // Regression: review()'s pre-existing Phase 33 diff framing is untouched.
    for (const prompt of reviewPrompts) {
      expect(prompt).toContain("UNTRUSTED REPOSITORY CONTENT");
    }
  });
});
