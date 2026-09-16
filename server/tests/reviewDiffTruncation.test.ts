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
 * Writes a large, multi-line file — large enough to exceed the small
 * MAX_DIFF_PATCH_CHARS this suite configures below — and logs every prompt
 * it receives (Phase 33), same convention as reviewDiffContent.test.ts.
 *
 * The log path is baked directly into the generated script text (rather
 * than read from an environment variable at runtime) because Phase 35's
 * subprocess environment allow-list means the fake CLI process no longer
 * inherits arbitrary test-plumbing environment variables any more than a
 * real one would — see claudeEnvironment.ts.
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
  const lines = Array.from({ length: 200 }, (_, i) => \`generated filler content line \${i}\`).join("\\n");
  writeFileSync("generated-by-agent.txt", lines + "\\n");
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

process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "\`\`\`json\\n" + JSON.stringify(payload) + "\\n\`\`\`" }));
`;
}

let app: Express;
let dataDir: string;
let tasksDir: string;
let repoDir: string;
let fakeCliPath: string;
let promptLogPath: string;

const MAX_DIFF_PATCH_CHARS = "200";

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "diffreview-trunc-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "diffreview-trunc-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "diffreview-trunc-repo-"));

  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ scripts: {} }));
  await git(["init", "-b", "main"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "add", "-A"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"], repoDir);

  const logDir = await mkdtemp(path.join(tmpdir(), "diffreview-trunc-log-"));
  promptLogPath = path.join(logDir, "prompts.log");
  await writeFile(promptLogPath, "", "utf-8");

  const fakeCliDir = await mkdtemp(path.join(tmpdir(), "diffreview-trunc-fake-cli-"));
  fakeCliPath = path.join(fakeCliDir, "fake-claude.mjs");
  await writeFile(fakeCliPath, buildFakeCliSource(promptLogPath), "utf-8");
  await chmod(fakeCliPath, 0o755);

  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;
  process.env.CLAUDE_EXECUTION_MODE = "real";
  process.env.CLAUDE_CLI_PATH = fakeCliPath;
  process.env.CLAUDE_TIMEOUT_MS = "10000";
  process.env.MAX_DIFF_PATCH_CHARS = MAX_DIFF_PATCH_CHARS;

  const { createApp } = await import("../src/app.js");
  app = createApp();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
  delete process.env.MAX_DIFF_PATCH_CHARS;
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

describe("Truncated diffs are explicit end to end (Phase 33)", () => {
  it("bounds the stored patch and warns the reviewer it is incomplete, rather than silently truncating", async () => {
    const createRes = await request(app)
      .post("/api/tasks")
      .send({ title: "Add a health route", requirement: "Add a GET /health endpoint.", repository: repoDir });
    expect(createRes.status).toBe(201);
    const taskId = createRes.body.task.id;

    await request(app).post(`/api/tasks/${taskId}/start`);
    const task = await waitForTerminal(taskId);
    expect(task.status).toBe("completed");

    const reportRes = await request(app).get(`/api/tasks/${taskId}/execution-report`);
    const diff = reportRes.body.report.diff;
    expect(diff.truncated).toBe(true);
    expect(diff.patch.length).toBeLessThanOrEqual(Number(MAX_DIFF_PATCH_CHARS));
    expect(diff.totalPatchChars).toBeGreaterThan(diff.patch.length);
    expect(diff.patch).toContain("diff truncated");

    const promptLog = await readFile(promptLogPath, "utf-8");
    const prompts = promptLog
      .split("<<<PROMPT-BOUNDARY>>>")
      .map((p) => p.trim())
      .filter(Boolean);
    const reviewPrompts = prompts.filter((p) => p.includes("Test evidence:"));
    expect(reviewPrompts.length).toBeGreaterThan(0);

    for (const reviewPrompt of reviewPrompts) {
      expect(reviewPrompt).toContain("WARNING: this diff was truncated");
      expect(reviewPrompt).toContain("UNTRUSTED REPOSITORY CONTENT");
    }
  });
});
