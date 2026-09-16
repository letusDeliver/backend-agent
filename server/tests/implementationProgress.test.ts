import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskStore } from "../src/store/taskStore.js";
import type { ArtifactStore as ArtifactStoreType } from "../src/artifacts/artifactStore.js";
import type { TaskOrchestrator as TaskOrchestratorType } from "../src/orchestrator/taskOrchestrator.js";
import type { TaskEventBus as TaskEventBusType } from "../src/events/eventBus.js";
import type {
  ClaudeCodeExecutor,
  AnalyzeParams,
  ConflictResolutionDecision,
  ConflictResolutionParams,
  DecomposeRequirementParams,
  DirectionDecision,
  DirectionDecisionParams,
  ImplementParams,
  ReviewParams,
  RunTestsParams,
  SubtaskDefinition,
} from "../src/execution/ClaudeCodeExecutor.js";
import type { ExecutionReport, ReviewReport, SpecialistReport, TestRunResult } from "../src/types/index.js";

/**
 * Simulates what RealClaudeCodeExecutor.implement() actually does with a
 * streaming CLI response (Phase 41): calls onProgress synchronously,
 * multiple times, for tool_use/text events, before resolving with the
 * final ExecutionReport — without needing the real `claude` CLI.
 */
class ProgressEmittingExecutor implements ClaudeCodeExecutor {
  readonly mode = "mock" as const;

  async analyze({ agent, task }: AnalyzeParams): Promise<SpecialistReport> {
    return {
      agent,
      taskId: task.id,
      status: "completed",
      recommendation: "n/a",
      findings: [],
      risks: [],
      assumptions: [],
      confidence: 0.9,
      executionMode: "mock",
      createdAt: new Date().toISOString(),
    };
  }

  async implement({ task, plan, onProgress }: ImplementParams): Promise<ExecutionReport> {
    onProgress?.({ kind: "text", detail: "Scaffolding the health endpoint." });
    onProgress?.({ kind: "tool_use", tool: "Write", detail: "src/routes/health.ts" });
    onProgress?.({ kind: "tool_use", tool: "Bash", detail: "npm test" });
    return {
      taskId: task.id,
      executionMode: "mock",
      status: "completed",
      changedFiles: plan.files.map((f) => f.path),
      tests: [],
      commandsExecuted: [],
      notes: [],
      createdAt: new Date().toISOString(),
    };
  }

  async runTests(_params: RunTestsParams): Promise<TestRunResult[]> {
    return [];
  }

  async review({ agent, task, attempt }: ReviewParams): Promise<ReviewReport> {
    return { agent, taskId: task.id, status: "PASS", findings: [], executionMode: "mock", createdAt: new Date().toISOString(), attempt };
  }

  cancel(_taskId: string): void {
    // synchronous fixture — nothing to cancel
  }

  cancelAllInFlight(): void {
    // synchronous fixture — nothing to cancel
  }

  async decideDirection(_params: DirectionDecisionParams): Promise<DirectionDecision> {
    throw new Error("decideDirection is not exercised by this fixture.");
  }

  async decideConflictResolution(_params: ConflictResolutionParams): Promise<ConflictResolutionDecision> {
    throw new Error("decideConflictResolution is not exercised by this fixture.");
  }

  async decomposeRequirement(_params: DecomposeRequirementParams): Promise<SubtaskDefinition[]> {
    throw new Error("decomposeRequirement is not exercised by this fixture.");
  }
}

describe("Implementation progress events — orchestrator wiring (Phase 41)", () => {
  let dataDir: string;
  let tasksDir: string;
  let repoDir: string;
  let taskStore: TaskStore;
  let artifactStore: ArtifactStoreType;
  let events: TaskEventBusType;
  let orchestrator: TaskOrchestratorType;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "impl-progress-data-"));
    tasksDir = await mkdtemp(path.join(tmpdir(), "impl-progress-tasks-"));
    repoDir = await mkdtemp(path.join(tmpdir(), "impl-progress-repo-"));
    await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ dependencies: { express: "^4.0.0" }, scripts: { test: "echo ok" } }));

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
    events = new TaskEventBus(artifactStore);
    const memory = new JsonFileMemoryStore(dataDir);
    orchestrator = new TaskOrchestrator(taskStore, artifactStore, events, new ProgressEmittingExecutor(), new GitWorktreeManager(), memory);
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(tasksDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("publishes an IMPLEMENTATION_PROGRESS event, in order, for each progress callback the executor makes", async () => {
    const now = new Date().toISOString();
    const task = await taskStore.create({
      id: "progress-task-1",
      title: "Add a health endpoint",
      requirement: "Add a GET /health endpoint.",
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

    const finished = await taskStore.get(task.id);
    expect(finished?.status).toBe("completed");

    const history = await events.history(task.id);
    const progressEvents = history.filter((e) => e.type === "IMPLEMENTATION_PROGRESS");
    expect(progressEvents).toHaveLength(3);
    expect(progressEvents[0].message).toBe("Scaffolding the health endpoint.");
    expect(progressEvents[1].message).toBe("Write: src/routes/health.ts");
    expect(progressEvents[1].data).toEqual({ kind: "tool_use", tool: "Write", detail: "src/routes/health.ts" });
    expect(progressEvents[2].message).toBe("Bash: npm test");

    // Progress events happened strictly between IMPLEMENTATION_STARTED and
    // IMPLEMENTATION_COMPLETED, not scattered outside that window.
    const startedIndex = history.findIndex((e) => e.type === "IMPLEMENTATION_STARTED");
    const completedIndex = history.findIndex((e) => e.type === "IMPLEMENTATION_COMPLETED");
    const firstProgressIndex = history.indexOf(progressEvents[0]);
    const lastProgressIndex = history.indexOf(progressEvents[2]);
    expect(firstProgressIndex).toBeGreaterThan(startedIndex);
    expect(lastProgressIndex).toBeLessThan(completedIndex);
  });
});
