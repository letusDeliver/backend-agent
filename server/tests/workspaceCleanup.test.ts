import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskStore } from "../src/store/taskStore.js";
import type { ArtifactStore as ArtifactStoreType } from "../src/artifacts/artifactStore.js";
import type { TaskOrchestrator as TaskOrchestratorType } from "../src/orchestrator/taskOrchestrator.js";
import type { GitWorktreeManager as GitWorktreeManagerType } from "../src/execution/gitWorktree.js";
import type { ClaudeCodeExecutor, AnalyzeParams, ConflictResolutionDecision, ConflictResolutionParams, DirectionDecision, DirectionDecisionParams, ImplementParams, ReviewParams, RunTestsParams } from "../src/execution/ClaudeCodeExecutor.js";
import type { ExecutionReport, ReviewReport, SpecialistReport, Task, TestRunResult } from "../src/types/index.js";

const execFileAsync = promisify(execFile);
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

/**
 * Always agrees, always passes review, commits a marker file. Used for the
 * "completed task → cleanup" and "retry after cleanup" lifecycle tests,
 * where the point is real git state around cleanup, not reconciliation
 * behavior (already covered elsewhere).
 */
class AlwaysPassRealExecutor implements ClaudeCodeExecutor {
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
    return { agent, taskId: task.id, status: "PASS", findings: [], executionMode: "real", createdAt: new Date().toISOString(), attempt };
  }

  cancel(_taskId: string): void {
    // synchronous fixture — nothing to cancel
  }

  async decideDirection(_params: DirectionDecisionParams): Promise<DirectionDecision> {
    throw new Error("decideDirection is not exercised by this fixture.");
  }

  async decideConflictResolution(_params: ConflictResolutionParams): Promise<ConflictResolutionDecision> {
    throw new Error("decideConflictResolution is not exercised by this fixture.");
  }
}

/**
 * Real-mode-shaped genuine specialist disagreement (same technique as
 * `reconciliationConflict.e2e.test.ts`, but `mode: "real"` so a real
 * workspace is prepared before the task blocks) — used to prove cleanup
 * refuses a `blocked` task and that Phase 30's conflict-resolution resume
 * still works against the exact same, uncleaned workspace afterward.
 */
class ConflictingRealExecutor implements ClaudeCodeExecutor {
  readonly mode = "real" as const;
  constructor(private readonly worktrees: GitWorktreeManagerType) {}

  async analyze({ agent, task }: AnalyzeParams): Promise<SpecialistReport> {
    const base = {
      agent,
      taskId: task.id,
      status: "completed" as const,
      risks: [],
      assumptions: [],
      confidence: 0.9,
      executionMode: "real" as const,
      createdAt: new Date().toISOString(),
    };
    if (agent === "node-backend") {
      return {
        ...base,
        recommendation: "Use a PostgreSQL transaction for order creation.",
        findings: [{ summary: "Order creation writes must be atomic.", evidence: "src/routes/orders.ts" }],
      };
    }
    return {
      ...base,
      recommendation: "Do not use a transaction here; keep this eventually consistent across services.",
      findings: [{ summary: "Order creation now spans two services via an outbox pattern.", evidence: "schema.sql" }],
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
    return { agent, taskId: task.id, status: "PASS", findings: [], executionMode: "real", createdAt: new Date().toISOString(), attempt };
  }

  cancel(_taskId: string): void {
    // synchronous fixture — nothing to cancel
  }

  async decideDirection(_params: DirectionDecisionParams): Promise<DirectionDecision> {
    throw new Error("decideDirection is not exercised by this fixture.");
  }

  async decideConflictResolution(_params: ConflictResolutionParams): Promise<ConflictResolutionDecision> {
    throw new Error("decideConflictResolution is not exercised by this fixture.");
  }
}

let dataDir: string;
let tasksDir: string;
let repoDir: string;
let taskStore: TaskStore;
let artifactStore: ArtifactStoreType;
let worktrees: GitWorktreeManagerType;
/** Used for `cleanupWorkspace()` calls — doesn't depend on the executor. */
let cleanupOrchestrator: TaskOrchestratorType;
let passOrchestrator: TaskOrchestratorType;
let conflictOrchestrator: TaskOrchestratorType;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "cleanup-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "cleanup-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "cleanup-repo-"));

  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ dependencies: { express: "^4.0.0" }, scripts: { test: "echo ok" } }));
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
  worktrees = new GitWorktreeManager();
  const memory = new JsonFileMemoryStore(dataDir);

  cleanupOrchestrator = new TaskOrchestrator(taskStore, artifactStore, events, new AlwaysPassRealExecutor(worktrees), worktrees, memory);
  passOrchestrator = new TaskOrchestrator(taskStore, artifactStore, events, new AlwaysPassRealExecutor(worktrees), worktrees, memory);
  conflictOrchestrator = new TaskOrchestrator(taskStore, artifactStore, events, new ConflictingRealExecutor(worktrees), worktrees, memory);
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

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Synthetic-state construction (matches this project's established
 * technique for eligibility-matrix tests — see `retryApi.test.ts`): builds
 * a task record directly, with a genuinely prepared git worktree, at
 * whatever status the test needs, without running the full pipeline. */
async function makeRealTaskWithWorkspace(status: Task["status"], overrides: Partial<Task> = {}): Promise<Task> {
  const id = nextId("cleanup-task");
  const info = await worktrees.prepare(repoDir, id, tasksDir);
  const now = new Date().toISOString();
  const task: Task = {
    id,
    title: "Synthetic cleanup-eligibility task",
    requirement: "n/a",
    repository: repoDir,
    status,
    detectedStack: null,
    selectedAgents: [],
    currentStage: status,
    executionMode: "real",
    reviewRetryCount: 0,
    attempt: 1,
    executionWorkspace: { workspacePath: info.workspacePath, branch: info.branch, baseRevision: info.baseRevision, status: "ready", createdAt: now },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await taskStore.create(task);
  await artifactStore.ensureWorkspace(task.id);
  await artifactStore.writeTask(task);
  return task;
}

describe("TaskOrchestrator.cleanupWorkspace — eligibility", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "cleans up a %s real-mode task's workspace, verified against real git state",
    async (status) => {
      const task = await makeRealTaskWithWorkspace(status);
      const { workspacePath, branch } = task.executionWorkspace!;
      expect(existsSync(workspacePath)).toBe(true);

      const cleaned = await cleanupOrchestrator.cleanupWorkspace(task.id);
      expect(cleaned.executionWorkspace?.cleanupStatus).toBe("cleaned");
      expect(cleaned.executionWorkspace?.cleanedAt).toBeTruthy();
      expect(cleaned.status).toBe(status); // engineering outcome unchanged

      // Ground truth via git, not the orchestrator's self-report.
      expect(existsSync(workspacePath)).toBe(false);
      const worktreeList = await git(["worktree", "list"], repoDir);
      expect(worktreeList).not.toContain(workspacePath);
      const branches = await git(["branch", "--list", branch], repoDir);
      expect(branches.trim()).toBe("");

      const events = await artifactStore.readEvents(task.id);
      expect(events.some((e) => e.type === "WORKSPACE_CLEANED")).toBe(true);
    }
  );

  it("rejects a blocked task and leaves the worktree/branch untouched", async () => {
    const task = await makeRealTaskWithWorkspace("blocked");
    const { workspacePath, branch } = task.executionWorkspace!;

    await expect(cleanupOrchestrator.cleanupWorkspace(task.id)).rejects.toThrow(/blocked/i);

    expect(existsSync(workspacePath)).toBe(true);
    const branches = await git(["branch", "--list", branch], repoDir);
    expect(branches.trim()).not.toBe("");
    const persisted = await taskStore.get(task.id);
    expect(persisted?.executionWorkspace?.cleanupStatus).not.toBe("cleaned");
  });

  it("rejects an in-flight task and leaves the worktree/branch untouched", async () => {
    const task = await makeRealTaskWithWorkspace("implementing");
    const { workspacePath, branch } = task.executionWorkspace!;

    await expect(cleanupOrchestrator.cleanupWorkspace(task.id)).rejects.toThrow(/in progress/i);

    expect(existsSync(workspacePath)).toBe(true);
    const branches = await git(["branch", "--list", branch], repoDir);
    expect(branches.trim()).not.toBe("");
  });

  it("rejects a mock-mode task", async () => {
    const now = new Date().toISOString();
    const task: Task = {
      id: nextId("cleanup-mock"),
      title: "mock task",
      requirement: "n/a",
      repository: repoDir,
      status: "completed",
      detectedStack: null,
      selectedAgents: [],
      currentStage: "completed",
      executionMode: "mock",
      reviewRetryCount: 0,
      attempt: 1,
      createdAt: now,
      updatedAt: now,
    };
    await taskStore.create(task);
    await artifactStore.ensureWorkspace(task.id);
    await artifactStore.writeTask(task);

    await expect(cleanupOrchestrator.cleanupWorkspace(task.id)).rejects.toThrow(/real-mode/i);
  });

  it("rejects a real-mode task that never prepared a workspace", async () => {
    const now = new Date().toISOString();
    const task: Task = {
      id: nextId("cleanup-noworkspace"),
      title: "no workspace",
      requirement: "n/a",
      repository: repoDir,
      status: "failed",
      detectedStack: null,
      selectedAgents: [],
      currentStage: "failed",
      executionMode: "real",
      reviewRetryCount: 0,
      attempt: 1,
      createdAt: now,
      updatedAt: now,
    };
    await taskStore.create(task);
    await artifactStore.ensureWorkspace(task.id);
    await artifactStore.writeTask(task);

    await expect(cleanupOrchestrator.cleanupWorkspace(task.id)).rejects.toThrow(/no prepared workspace/i);
  });

  it("rejects a task whose workspace preparation itself failed", async () => {
    const task = await makeRealTaskWithWorkspace("blocked", {
      executionWorkspace: { workspacePath: "", branch: "", baseRevision: "", status: "failed", createdAt: new Date().toISOString(), error: "unsafe path" },
    });
    await expect(cleanupOrchestrator.cleanupWorkspace(task.id)).rejects.toThrow(/no prepared workspace/i);
  });

  it("rejects an unknown task", async () => {
    await expect(cleanupOrchestrator.cleanupWorkspace("no-such-task")).rejects.toThrow(/not found/i);
  });

  it("rejects a second cleanup request without attempting removal again", async () => {
    const task = await makeRealTaskWithWorkspace("completed");
    const { workspacePath } = task.executionWorkspace!;

    const first = await cleanupOrchestrator.cleanupWorkspace(task.id);
    expect(first.executionWorkspace?.cleanupStatus).toBe("cleaned");
    expect(existsSync(workspacePath)).toBe(false);

    await expect(cleanupOrchestrator.cleanupWorkspace(task.id)).rejects.toThrow(/already been cleaned/i);
  });
});

describe("TaskOrchestrator.cleanupWorkspace — failure handling", () => {
  it("records cleanup_failed without altering task status when the underlying git removal genuinely fails", async () => {
    const now = new Date().toISOString();
    const { deriveWorkspaceLocation } = await import("../src/execution/gitWorktree.js");
    const id = nextId("cleanup-fail");
    const { workspacePath, branch } = deriveWorkspaceLocation(id, tasksDir);
    // A directory that exists on disk but was never registered as a git
    // worktree — `git worktree remove --force` genuinely fails against it
    // (verified directly in gitWorktree.test.ts), giving a deterministic,
    // non-mocked failure rather than a stubbed one.
    await mkdir(workspacePath, { recursive: true });

    const task: Task = {
      id,
      title: "forced cleanup failure",
      requirement: "n/a",
      repository: repoDir,
      status: "completed",
      detectedStack: null,
      selectedAgents: [],
      currentStage: "completed",
      executionMode: "real",
      reviewRetryCount: 0,
      attempt: 1,
      executionWorkspace: { workspacePath, branch, baseRevision: "0".repeat(40), status: "ready", createdAt: now },
      createdAt: now,
      updatedAt: now,
    };
    await taskStore.create(task);
    await artifactStore.ensureWorkspace(task.id);
    await artifactStore.writeTask(task);

    await expect(cleanupOrchestrator.cleanupWorkspace(id)).rejects.toThrow();

    const persisted = await taskStore.get(id);
    expect(persisted?.status).toBe("completed"); // engineering outcome untouched
    expect(persisted?.executionWorkspace?.cleanupStatus).toBe("cleanup_failed");
    expect(persisted?.executionWorkspace?.cleanupError).toBeTruthy();
    expect(persisted?.executionWorkspace?.cleanedAt).toBeUndefined();

    const events = await artifactStore.readEvents(id);
    expect(events.some((e) => e.type === "WORKSPACE_CLEANUP_FAILED")).toBe(true);
  });
});

describe("TaskOrchestrator.cleanupWorkspace — concurrency", () => {
  it("performs the git removal exactly once when two cleanup requests race for the same task", async () => {
    const task = await makeRealTaskWithWorkspace("completed");
    const { workspacePath, branch } = task.executionWorkspace!;

    const [a, b] = await Promise.allSettled([cleanupOrchestrator.cleanupWorkspace(task.id), cleanupOrchestrator.cleanupWorkspace(task.id)]);
    const outcomes = [a, b];
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    expect(existsSync(workspacePath)).toBe(false);
    const branches = await git(["branch", "--list", branch], repoDir);
    expect(branches.trim()).toBe("");

    const persisted = await taskStore.get(task.id);
    expect(persisted?.executionWorkspace?.cleanupStatus).toBe("cleaned");
  });

  it("never touches a different task's workspace", async () => {
    const cleanMe = await makeRealTaskWithWorkspace("completed");
    const leaveAlone = await makeRealTaskWithWorkspace("implementing");

    await cleanupOrchestrator.cleanupWorkspace(cleanMe.id);

    expect(existsSync(cleanMe.executionWorkspace!.workspacePath)).toBe(false);
    expect(existsSync(leaveAlone.executionWorkspace!.workspacePath)).toBe(true);
    const branches = await git(["branch", "--list", leaveAlone.executionWorkspace!.branch], repoDir);
    expect(branches.trim()).not.toBe("");

    const persistedOther = await taskStore.get(leaveAlone.id);
    expect(persistedOther?.executionWorkspace?.workspacePath).toBe(leaveAlone.executionWorkspace!.workspacePath);
    expect(persistedOther?.executionWorkspace?.cleanupStatus ?? "ready").not.toBe("cleaned");
  });
});

describe("Blocked-task regression — Phase 30 conflict resolution must keep working", () => {
  it("refuses cleanup while blocked, and resolving + resuming still succeeds against the same, uncleaned workspace", async () => {
    const now = new Date().toISOString();
    const task = await taskStore.create({
      id: nextId("cleanup-conflict"),
      title: "Add order creation endpoint",
      requirement: "Add an order creation endpoint with a database transaction.",
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

    await conflictOrchestrator.run(task.id);
    const blocked = await waitForStatus(task.id, ["blocked", "failed", "completed"]);
    expect(blocked.status).toBe("blocked");
    const workspace = blocked.executionWorkspace!;
    expect(workspace.status).toBe("ready");

    // Cleanup must be refused, server-side, while blocked — not merely
    // hidden in a UI.
    await expect(cleanupOrchestrator.cleanupWorkspace(task.id)).rejects.toThrow(/blocked/i);
    expect(existsSync(workspace.workspacePath)).toBe(true);
    const branchesWhileBlocked = await git(["branch", "--list", workspace.branch], repoDir);
    expect(branchesWhileBlocked.trim()).not.toBe("");

    const reconciliation = await artifactStore.readReconciliation(task.id);
    expect(reconciliation?.status).toBe("CONFLICT");
    const conflict = reconciliation!.conflicts[0];
    conflict.resolution = {
      resolution: "Use a transaction. The outbox/eventually-consistent design was rejected after review.",
      reason: "Order creation does not actually span services in this repository.",
      resolvedBy: "developer",
      resolvedAt: new Date().toISOString(),
    };
    const { recomputeStatus } = await import("../src/orchestrator/reconciliation.js");
    reconciliation!.status = recomputeStatus(reconciliation!);
    await artifactStore.writeReconciliation(reconciliation!);

    await conflictOrchestrator.resumeAfterConflictResolution(task.id);
    const completed = await waitForStatus(task.id, ["completed", "failed", "blocked"]);
    expect(completed.status).toBe("completed");

    // Proves resume genuinely reused the same, never-recreated workspace:
    // the marker file implement() wrote lands in the exact directory that
    // was ready before the conflict blocked the task.
    const worktreeFiles = await git(["ls-files"], workspace.workspacePath);
    expect(worktreeFiles).toContain(`marker-attempt-1.txt`);
  });
});

describe("Retry after manual cleanup", () => {
  it("prepares a fresh workspace normally on retry, even though the prior attempt's workspace was manually cleaned up", async () => {
    // Attempt 1 is constructed directly at `failed` (synthetic-state
    // technique, as above) — retryable and cleanup-eligible, and the
    // fidelity of a genuine attempt-1-through-the-pipeline run is already
    // covered by `taskRetryRealMode.test.ts`. This test's own concern is
    // strictly the cleanup+retry interaction.
    const task = await makeRealTaskWithWorkspace("failed");
    const firstWorkspace = task.executionWorkspace!;

    const cleaned = await cleanupOrchestrator.cleanupWorkspace(task.id);
    expect(cleaned.executionWorkspace?.cleanupStatus).toBe("cleaned");
    expect(existsSync(firstWorkspace.workspacePath)).toBe(false);

    await passOrchestrator.retry(task.id);
    const afterRetry = await taskStore.get(task.id);
    expect(afterRetry?.attempt).toBe(2);

    const secondDone = await waitForStatus(task.id, ["completed", "failed", "blocked"]);
    expect(secondDone.status).toBe("completed");
    expect(secondDone.executionWorkspace?.status).toBe("ready");
    expect(existsSync(secondDone.executionWorkspace!.workspacePath)).toBe(true);

    // The developer's own repository checkout was never touched throughout.
    const status = await git(["status", "--porcelain"], repoDir);
    expect(status.trim()).toBe("");
    const currentBranch = (await git(["branch", "--show-current"], repoDir)).trim();
    expect(currentBranch).toBe("main");

    // Task artifacts (durable history, distinct from the worktree) remain
    // fully readable after the first attempt's workspace was cleaned up.
    const handoff = await artifactStore.readFinalHandoff(task.id);
    expect(handoff?.status).toBe("completed");
    const attempts = await artifactStore.listAttempts(task.id);
    expect(attempts).toContain(1);
  });
});
