import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskStore } from "../src/store/taskStore.js";
import type { ArtifactStore as ArtifactStoreType } from "../src/artifacts/artifactStore.js";
import type { TaskOrchestrator as TaskOrchestratorType, RetryNotAllowedError as RetryNotAllowedErrorType, TaskNotFoundError as TaskNotFoundErrorType } from "../src/orchestrator/taskOrchestrator.js";
import type { ClaudeCodeExecutor, AnalyzeParams, DirectionDecision, DirectionDecisionParams, ImplementParams, ReviewParams, RunTestsParams } from "../src/execution/ClaudeCodeExecutor.js";
import type { ExecutionReport, ReviewReport, SpecialistReport, Task, TaskStatus, TestRunResult } from "../src/types/index.js";

/**
 * Deterministic fixture executor (mock mode) whose review() blocks on the
 * task's *first* attempt and passes on every subsequent attempt — engineers
 * a genuine blocked -> retry -> completed lifecycle without needing the real
 * `claude` CLI, following the same "deterministic fixture" convention as
 * reconciliationConflict.e2e.test.ts's ConflictingStubExecutor.
 */
class BlockOnFirstAttemptExecutor implements ClaudeCodeExecutor {
  readonly mode = "mock" as const;

  async analyze({ agent, task }: AnalyzeParams): Promise<SpecialistReport> {
    return {
      agent,
      taskId: task.id,
      status: "completed",
      recommendation: "Add a GET /health endpoint following existing conventions.",
      findings: [{ summary: "Repository already exposes a routes directory.", evidence: "src/routes" }],
      risks: [],
      assumptions: [],
      confidence: 0.9,
      executionMode: "mock",
      createdAt: new Date().toISOString(),
    };
  }

  async implement({ task, plan }: ImplementParams): Promise<ExecutionReport> {
    return {
      taskId: task.id,
      executionMode: "mock",
      status: "completed",
      changedFiles: plan.files.map((f) => f.path),
      tests: [],
      commandsExecuted: [],
      notes: [`Fixture implement for attempt ${task.attempt}.`],
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
        findings: [{ summary: "Simulated blocking finding on attempt 1.", severity: "blocking", recommendation: "Fix it and retry." }],
        executionMode: "mock",
        createdAt: new Date().toISOString(),
        attempt,
      };
    }
    return { agent, taskId: task.id, status: "PASS", findings: [], executionMode: "mock", createdAt: new Date().toISOString(), attempt };
  }

  cancel(_taskId: string): void {
    // synchronous fixture — nothing to cancel
  }

  async decideDirection(_params: DirectionDecisionParams): Promise<DirectionDecision> {
    throw new Error("decideDirection is not exercised by this fixture.");
  }
}

let dataDir: string;
let tasksDir: string;
let repoDir: string;
let taskStore: TaskStore;
let artifactStore: ArtifactStoreType;
let orchestrator: TaskOrchestratorType;
let RetryNotAllowedError: typeof RetryNotAllowedErrorType;
let TaskNotFoundError: typeof TaskNotFoundErrorType;
let RETRYABLE_STATUSES_FROM_MODULE: Set<TaskStatus>;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "retry-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "retry-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "retry-repo-"));

  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ dependencies: { express: "^4.0.0" }, scripts: { test: "echo ok" } }));

  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;

  const { JsonFileTaskStore } = await import("../src/store/jsonFileTaskStore.js");
  const { ArtifactStore } = await import("../src/artifacts/artifactStore.js");
  const { TaskEventBus } = await import("../src/events/eventBus.js");
  const { GitWorktreeManager } = await import("../src/execution/gitWorktree.js");
  const { JsonFileMemoryStore } = await import("../src/memory/jsonFileMemoryStore.js");
  const orchestratorModule = await import("../src/orchestrator/taskOrchestrator.js");

  taskStore = new JsonFileTaskStore(dataDir);
  artifactStore = new ArtifactStore();
  const events = new TaskEventBus(artifactStore);
  const worktrees = new GitWorktreeManager();
  const memory = new JsonFileMemoryStore(dataDir);
  orchestrator = new orchestratorModule.TaskOrchestrator(taskStore, artifactStore, events, new BlockOnFirstAttemptExecutor(), worktrees, memory);
  RetryNotAllowedError = orchestratorModule.RetryNotAllowedError;
  TaskNotFoundError = orchestratorModule.TaskNotFoundError;
  RETRYABLE_STATUSES_FROM_MODULE = orchestratorModule.RETRYABLE_STATUSES;
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

let seq = 0;
async function makeTask(status: TaskStatus): Promise<Task> {
  seq += 1;
  const now = new Date().toISOString();
  const task: Task = {
    id: `retry-matrix-${seq}`,
    title: "Add a GET /health endpoint",
    requirement: "Add a GET /health endpoint to this repository.",
    repository: repoDir,
    status,
    detectedStack: null,
    selectedAgents: [],
    currentStage: status,
    executionMode: "mock",
    reviewRetryCount: 0,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
  };
  await taskStore.create(task);
  await artifactStore.ensureWorkspace(task.id);
  await artifactStore.writeTask(task);
  return task;
}

async function waitForStatus(taskId: string, statuses: string[], timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await taskStore.get(taskId);
    if (task && statuses.includes(task.status)) return task;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for status in [${statuses.join(", ")}], last: ${task?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Static, not derived from the dynamically-imported module — vitest
// collects `it()` calls synchronously while `describe` bodies run, before
// `beforeAll` (and therefore the dynamic import of the orchestrator module)
// has resolved. Consistency with the module's own `RETRYABLE_STATUSES` is
// asserted separately below.
const NON_RETRYABLE_STATUSES: TaskStatus[] = [
  "created",
  "inspecting",
  "routing",
  "analyzing",
  "reconciling",
  "planning",
  "implementing",
  "reviewing",
  "completed",
];
const RETRYABLE_STATUSES: TaskStatus[] = ["failed", "blocked", "cancelled"];

describe("TaskOrchestrator.retry — status precondition table", () => {
  it("404s for an unknown task", async () => {
    await expect(orchestrator.retry("does-not-exist")).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it("RETRYABLE_STATUSES exported by the orchestrator matches failed/blocked/cancelled exactly", () => {
    expect(RETRYABLE_STATUSES_FROM_MODULE).toEqual(new Set(RETRYABLE_STATUSES));
  });

  for (const status of NON_RETRYABLE_STATUSES) {
    it(`rejects retry from "${status}" and leaves the task unchanged`, async () => {
      const task = await makeTask(status);
      await expect(orchestrator.retry(task.id)).rejects.toBeInstanceOf(RetryNotAllowedError);

      const after = await taskStore.get(task.id);
      expect(after?.status).toBe(status);
      expect(after?.attempt).toBe(1);
    });
  }

  for (const status of RETRYABLE_STATUSES) {
    it(`accepts retry from "${status}"`, async () => {
      const task = await makeTask(status);
      await orchestrator.retry(task.id);
      const after = await taskStore.get(task.id);
      expect(after?.attempt).toBe(2);
      // Status immediately after retry() resolves is "created"; run() then
      // proceeds asynchronously — wait for it to leave "created" so the
      // background run doesn't bleed into a later test's fixtures.
      await waitForStatus(task.id, ["completed", "failed", "blocked", "cancelled"], 8000);
    });
  }
});

describe("TaskOrchestrator.retry — full lifecycle", () => {
  it("blocks on attempt 1, retries, and completes on attempt 2 — preserving attempt 1's artifact history", async () => {
    const now = new Date().toISOString();
    const task = await taskStore.create({
      id: "retry-lifecycle-1",
      title: "Add a GET /health endpoint",
      requirement: "Add a GET /health endpoint to this repository.",
      repository: repoDir,
      status: "created",
      detectedStack: null,
      selectedAgents: [],
      currentStage: "created",
      executionMode: "mock",
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

    // Attempt 1's artifacts genuinely exist before retry.
    const reconciliationBefore = await artifactStore.readReconciliation(task.id);
    const planBefore = await artifactStore.readImplementationPlan(task.id);
    const reportBefore = await artifactStore.readExecutionReport(task.id);
    expect(reconciliationBefore).not.toBeNull();
    expect(planBefore).not.toBeNull();
    expect(reportBefore).not.toBeNull();

    await orchestrator.retry(task.id);
    const afterRetry = await taskStore.get(task.id);
    expect(afterRetry?.attempt).toBe(2);

    const completed = await waitForStatus(task.id, ["completed", "failed", "blocked"]);
    expect(completed.status).toBe("completed");
    expect(completed.attempt).toBe(2);

    // Attempt 1's artifacts are archived, unmodified, and readable.
    const attempts = await artifactStore.listAttempts(task.id);
    expect(attempts).toEqual([1]);

    const archivedReconciliation = await artifactStore.readArchivedReconciliation(task.id, 1);
    const archivedPlan = await artifactStore.readArchivedImplementationPlan(task.id, 1);
    const archivedReport = await artifactStore.readArchivedExecutionReport(task.id, 1);
    const archivedReviews = await artifactStore.readArchivedReviews(task.id, 1, ["node-backend", "python-backend", "database"]);
    expect(archivedReconciliation?.createdAt).toBe(reconciliationBefore?.createdAt);
    expect(archivedPlan?.createdAt).toBe(planBefore?.createdAt);
    expect(archivedReport?.createdAt).toBe(reportBefore?.createdAt);
    expect(archivedReviews.length).toBeGreaterThan(0);
    expect(archivedReviews[0].status).toBe("FAIL");

    // Attempt 2's fresh artifacts live at the top level.
    const currentReconciliation = await artifactStore.readReconciliation(task.id);
    expect(currentReconciliation?.createdAt).not.toBe(reconciliationBefore?.createdAt);

    // Full, unbroken event history across both attempts (this test drives
    // the task via taskStore.create() directly rather than the
    // POST /tasks route, so no TASK_CREATED event is published here — that
    // event's presence in a real lifecycle is covered by api.test.ts).
    const events = await artifactStore.readEvents(task.id);
    const types = events.map((e) => e.type);
    expect(types).toContain("TASK_BLOCKED");
    expect(types).toContain("TASK_RETRIED");
    expect(types).toContain("TASK_COMPLETED");
    // Chronological: the retry boundary sits after the first block and
    // before the final completion.
    expect(types.indexOf("TASK_BLOCKED")).toBeLessThan(types.indexOf("TASK_RETRIED"));
    expect(types.indexOf("TASK_RETRIED")).toBeLessThan(types.indexOf("TASK_COMPLETED"));

    const handoff = await artifactStore.readFinalHandoff(task.id);
    expect(handoff?.status).toBe("completed");
  });

  it("rejects a concurrent retry while the task is mid-flight and leaves it unchanged", async () => {
    const task = await makeTask("implementing");
    await expect(orchestrator.retry(task.id)).rejects.toBeInstanceOf(RetryNotAllowedError);
    const after = await taskStore.get(task.id);
    expect(after?.status).toBe("implementing");
    expect(after?.attempt).toBe(1);
  });
});
