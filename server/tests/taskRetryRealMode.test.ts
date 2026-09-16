import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskStore } from "../src/store/taskStore.js";
import type { ArtifactStore as ArtifactStoreType } from "../src/artifacts/artifactStore.js";
import type { TaskOrchestrator as TaskOrchestratorType } from "../src/orchestrator/taskOrchestrator.js";
import type { GitWorktreeManager as GitWorktreeManagerType } from "../src/execution/gitWorktree.js";
import type { ClaudeCodeExecutor, AnalyzeParams, ImplementParams, ReviewParams, RunTestsParams } from "../src/execution/ClaudeCodeExecutor.js";
import type { ExecutionReport, ReviewReport, SpecialistReport, Task, TestRunResult } from "../src/types/index.js";

const execFileAsync = promisify(execFile);
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

/**
 * Real-mode-shaped fixture (Phase 31 proposal §29, phase prompt §12-14):
 * `mode: "real"` so `TaskOrchestrator` prepares a genuine isolated git
 * worktree via `GitWorktreeManager`, but no actual `claude` CLI is
 * involved. `implement()` writes and commits a marker file named after
 * `task.attempt` directly into the prepared worktree — real git state to
 * assert on, not a self-report. `review()` deterministically blocks on
 * attempt 1 (so attempt 1 reaches a retryable `blocked` status only after a
 * real commit exists on the task branch) and passes on attempt 2+.
 */
class RealModeRetryFixtureExecutor implements ClaudeCodeExecutor {
  readonly mode = "real" as const;
  constructor(private readonly worktrees: GitWorktreeManagerType) {}

  async analyze({ agent, task }: AnalyzeParams): Promise<SpecialistReport> {
    return {
      agent,
      taskId: task.id,
      status: "completed",
      recommendation: "Add a GET /health endpoint.",
      findings: [{ summary: "ok", evidence: "fixture" }],
      risks: [],
      assumptions: [],
      confidence: 0.9,
      executionMode: "real",
      createdAt: new Date().toISOString(),
    };
  }

  async implement({ task, plan }: ImplementParams): Promise<ExecutionReport> {
    const ws = task.executionWorkspace!;
    await writeFile(path.join(ws.workspacePath, `marker-attempt-${task.attempt}.txt`), `attempt ${task.attempt}\n`, "utf-8");
    const { committed } = await this.worktrees.commitChanges(ws.workspacePath, `Agent: attempt ${task.attempt} marker`);
    const diff = committed ? await this.worktrees.diff(ws.workspacePath, ws.baseRevision) : { files: [], summary: "No changes." };
    return {
      taskId: task.id,
      executionMode: "real",
      status: "completed",
      changedFiles: diff.files.map((f) => f.path),
      tests: [],
      commandsExecuted: [],
      notes: plan.files.map((f) => f.path),
      diff: { baseRevision: ws.baseRevision, branch: ws.branch, files: diff.files, summary: diff.summary },
      createdAt: new Date().toISOString(),
    };
  }

  async runTests(_params: RunTestsParams): Promise<TestRunResult[]> {
    return [];
  }

  async review({ agent, task, attempt }: ReviewParams): Promise<ReviewReport> {
    if (task.attempt === 1) {
      return {
        agent,
        taskId: task.id,
        status: "FAIL",
        findings: [{ summary: "Forced blocking finding on attempt 1.", severity: "blocking", recommendation: "Retry." }],
        executionMode: "real",
        createdAt: new Date().toISOString(),
        attempt,
      };
    }
    return { agent, taskId: task.id, status: "PASS", findings: [], executionMode: "real", createdAt: new Date().toISOString(), attempt };
  }

  cancel(_taskId: string): void {
    // synchronous fixture — nothing to cancel
  }
}

let dataDir: string;
let tasksDir: string;
let repoDir: string;
let taskStore: TaskStore;
let artifactStore: ArtifactStoreType;
let orchestrator: TaskOrchestratorType;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "retryreal-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "retryreal-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "retryreal-repo-"));

  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ scripts: {} }));
  await git(["init", "-b", "main"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "add", "-A"], repoDir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"], repoDir);

  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;

  const { JsonFileTaskStore } = await import("../src/store/jsonFileTaskStore.js");
  const { ArtifactStore } = await import("../src/artifacts/artifactStore.js");
  const { TaskEventBus } = await import("../src/events/eventBus.js");
  const { GitWorktreeManager } = await import("../src/execution/gitWorktree.js");
  const { JsonFileMemoryStore } = await import("../src/memory/jsonFileMemoryStore.js");
  const { TaskOrchestrator } = await import("../src/orchestrator/taskOrchestrator.js");

  taskStore = new JsonFileTaskStore(dataDir);
  artifactStore = new ArtifactStore();
  const events = new TaskEventBus(artifactStore);
  const worktrees = new GitWorktreeManager();
  const memory = new JsonFileMemoryStore(dataDir);
  orchestrator = new TaskOrchestrator(taskStore, artifactStore, events, new RealModeRetryFixtureExecutor(worktrees), worktrees, memory);
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

async function waitForStatus(taskId: string, statuses: string[], timeoutMs = 8000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await taskStore.get(taskId);
    if (task && statuses.includes(task.status)) return task;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for status in [${statuses.join(", ")}], last: ${task?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Real-mode retry — git worktree isolation", () => {
  it("gives attempt 2 a genuinely fresh worktree at current HEAD, with none of attempt 1's committed changes", async () => {
    const now = new Date().toISOString();
    const task = await taskStore.create({
      id: "real-retry-task-1",
      title: "Add a GET /health endpoint",
      requirement: "Add a GET /health endpoint.",
      repository: repoDir,
      status: "created",
      detectedStack: null,
      selectedAgents: [],
      currentStage: "created",
      executionMode: "real",
      reviewRetryCount: 0,
      attempt: 1,
      createdAt: now,
      updatedAt: now,
    });
    await artifactStore.ensureWorkspace(task.id);
    await artifactStore.writeTask(task);

    await orchestrator.run(task.id);
    const blocked = await waitForStatus(task.id, ["blocked", "failed", "completed"]);
    expect(blocked.status).toBe("blocked");
    expect(blocked.attempt).toBe(1);

    const branch = blocked.executionWorkspace!.branch;
    expect(branch).toBe(`agent/task-${task.id}`);

    // Attempt 1 genuinely committed something onto the task branch.
    const logAfterAttempt1 = await git(["log", "--oneline", branch], repoDir);
    expect(logAfterAttempt1).toContain("attempt 1 marker");
    const attempt1CommitCount = logAfterAttempt1.trim().split("\n").filter(Boolean).length;
    expect(attempt1CommitCount).toBeGreaterThan(0);

    await orchestrator.retry(task.id);
    const afterRetry = await taskStore.get(task.id);
    expect(afterRetry?.attempt).toBe(2);

    const completed = await waitForStatus(task.id, ["completed", "failed", "blocked"]);
    expect(completed.status).toBe("completed");
    expect(completed.attempt).toBe(2);

    // The retried attempt prepared its own workspace, strictly after attempt 1's.
    expect(new Date(completed.executionWorkspace!.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(blocked.executionWorkspace!.createdAt).getTime()
    );

    // Ground truth via git, not the executor's self-report: the branch was
    // force-recreated from HEAD, so attempt 1's commit is gone and only
    // attempt 2's marker commit remains.
    const logAfterAttempt2 = await git(["log", "--oneline", branch], repoDir);
    expect(logAfterAttempt2).toContain("attempt 2 marker");
    expect(logAfterAttempt2).not.toContain("attempt 1 marker");
    // Exactly the base repo's own "initial" commit plus attempt 2's single
    // marker commit — attempt 1's marker commit is gone because `-B` reset
    // the branch back to baseRevision before attempt 2 ever ran.
    const markerCommitCount = logAfterAttempt2.split("\n").filter((line) => line.includes("marker")).length;
    expect(markerCommitCount).toBe(1);

    // The working checkout itself only has attempt 2's marker file.
    const worktreePath = completed.executionWorkspace!.workspacePath;
    const lsFiles = await git(["ls-files"], worktreePath);
    expect(lsFiles).toContain("marker-attempt-2.txt");
    expect(lsFiles).not.toContain("marker-attempt-1.txt");

    // The developer's own repository checkout was never touched.
    const status = await git(["status", "--porcelain"], repoDir);
    expect(status.trim()).toBe("");
    const currentBranch = (await git(["branch", "--show-current"], repoDir)).trim();
    expect(currentBranch).toBe("main");
    const mainLog = await git(["log", "--oneline", "main"], repoDir);
    expect(mainLog).not.toMatch(/marker/);
  });
});
