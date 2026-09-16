import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MockClaudeCodeExecutor as MockClaudeCodeExecutorType } from "../src/execution/MockClaudeCodeExecutor.js";
import type { TaskStore } from "../src/store/taskStore.js";
import type { ArtifactStore as ArtifactStoreType } from "../src/artifacts/artifactStore.js";
import type { TaskOrchestrator as TaskOrchestratorType } from "../src/orchestrator/taskOrchestrator.js";
import type { TaskEventBus as TaskEventBusType } from "../src/events/eventBus.js";
import type {
  ClaudeCodeExecutor,
  ActiveSubtask,
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
import type { ExecutionReport, ReviewReport, SpecialistReport, Task, TestRunResult } from "../src/types/index.js";

describe("MockClaudeCodeExecutor.decomposeRequirement — Phase 39 deterministic fixture", () => {
  let executor: MockClaudeCodeExecutorType;

  beforeAll(async () => {
    // Dynamically imported, never at file top level: a real (non-type)
    // top-level import of this module would evaluate config.js — and
    // therefore freeze config.tasksDir/dataDir to their real-project
    // defaults — before any other describe block in this file gets a
    // chance to override DATA_DIR/TASKS_DIR in its own beforeAll. An
    // earlier version of this file did exactly that and leaked task
    // directories into the real project's tasks/ folder as a result.
    const { MockClaudeCodeExecutor } = await import("../src/execution/MockClaudeCodeExecutor.js");
    executor = new MockClaudeCodeExecutor();
  });

  function makeTask(requirement: string): Task {
    const now = new Date().toISOString();
    return {
      id: "task-1",
      title: "Task",
      requirement,
      repository: "/tmp/repo",
      status: "created",
      detectedStack: null,
      selectedAgents: [],
      currentStage: "created",
      executionMode: "mock",
      reviewRetryCount: 0,
      attempt: 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  const plan = { taskId: "task-1", summary: "s", files: [], validationCommands: [], createdAt: new Date().toISOString() };
  const reconciliation = {
    taskId: "task-1",
    status: "AGREED" as const,
    decisions: [],
    agreements: [],
    conflicts: [],
    unresolvedQuestions: [],
    risks: [],
    confidencePercent: 90,
    createdAt: new Date().toISOString(),
  };

  it("returns a single subtask covering the whole requirement when it isn't numbered", async () => {
    const subtasks = await executor.decomposeRequirement({ task: makeTask("Add a login endpoint."), plan, reconciliation });
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0].description).toBe("Add a login endpoint.");
  });

  it("splits a numbered requirement into one subtask per marker", async () => {
    const requirement =
      "Core scope: (1) Staff authentication with JWT. (2) Student CRUD with soft delete. (3) Teacher CRUD. (4) Class CRUD with enrollment.";
    const subtasks = await executor.decomposeRequirement({ task: makeTask(requirement), plan, reconciliation });
    expect(subtasks).toHaveLength(4);
    expect(subtasks[0].description).toMatch(/Staff authentication/);
    expect(subtasks[3].description).toMatch(/Class CRUD/);
  });
});

/**
 * A controllable fixture: each implement()/review() call is tracked, and
 * behavior (pass/blocking finding/exception) is driven by a per-call script
 * keyed on which subtask index is active — lets these tests drive the real
 * orchestrator's multi-step loop deterministically without the real `claude`
 * CLI.
 */
class ScriptedSubtaskExecutor implements ClaudeCodeExecutor {
  readonly mode = "mock" as const;
  readonly implementCalls: (ActiveSubtask | undefined)[] = [];
  readonly reviewCalls: (ActiveSubtask | undefined)[] = [];

  constructor(
    private readonly subtaskDefs: SubtaskDefinition[],
    private readonly blockingAtIndex: number | null = null
  ) {}

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

  async implement({ task, plan, activeSubtask }: ImplementParams): Promise<ExecutionReport> {
    this.implementCalls.push(activeSubtask);
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

  async review({ agent, task, attempt, activeSubtask }: ReviewParams): Promise<ReviewReport> {
    this.reviewCalls.push(activeSubtask);
    const isBlockingRound = this.blockingAtIndex !== null && activeSubtask?.index === this.blockingAtIndex;
    return {
      agent,
      taskId: task.id,
      status: isBlockingRound ? "FAIL" : "PASS",
      findings: isBlockingRound
        ? [{ summary: "Simulated blocking finding.", severity: "blocking", recommendation: "n/a" }]
        : [],
      executionMode: "mock",
      createdAt: new Date().toISOString(),
      attempt,
    };
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

  async decomposeRequirement(_params: DecomposeRequirementParams): Promise<SubtaskDefinition[]> {
    return this.subtaskDefs;
  }
}

const THREE_STEP_BACKLOG: SubtaskDefinition[] = [
  { title: "Step 1: scaffold", description: "Set up the project skeleton." },
  { title: "Step 2: auth", description: "Add login." },
  { title: "Step 3: students", description: "Add student CRUD." },
];

async function buildOrchestrator(executor: ClaudeCodeExecutor, prefix: string) {
  const dataDir = await mkdtemp(path.join(tmpdir(), `${prefix}-data-`));
  const tasksDir = await mkdtemp(path.join(tmpdir(), `${prefix}-tasks-`));
  const repoDir = await mkdtemp(path.join(tmpdir(), `${prefix}-repo-`));
  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ dependencies: { express: "^4.0.0" }, scripts: { test: "echo ok" } }));

  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;

  const { JsonFileTaskStore } = await import("../src/store/jsonFileTaskStore.js");
  const { ArtifactStore } = await import("../src/artifacts/artifactStore.js");
  const { TaskEventBus } = await import("../src/events/eventBus.js");
  const { GitWorktreeManager } = await import("../src/execution/gitWorktree.js");
  const { JsonFileMemoryStore } = await import("../src/memory/jsonFileMemoryStore.js");
  const { TaskOrchestrator } = await import("../src/orchestrator/taskOrchestrator.js");

  const taskStore: TaskStore = new JsonFileTaskStore(dataDir);
  const artifactStore: ArtifactStoreType = new ArtifactStore();
  const events: TaskEventBusType = new TaskEventBus(artifactStore);
  const memory = new JsonFileMemoryStore(dataDir);
  const orchestrator: TaskOrchestratorType = new TaskOrchestrator(taskStore, artifactStore, events, executor, new GitWorktreeManager(), memory);

  return { dataDir, tasksDir, repoDir, taskStore, artifactStore, events, orchestrator };
}

async function makeDecomposedTask(taskStore: TaskStore, artifactStore: ArtifactStoreType, repoDir: string, id: string) {
  const now = new Date().toISOString();
  const task = await taskStore.create({
    id,
    title: "Build the backend",
    requirement: "Build the backend.",
    repository: repoDir,
    status: "created",
    detectedStack: null,
    selectedAgents: [],
    currentStage: "created",
    executionMode: "mock",
    reviewRetryCount: 0,
    decomposeRequirement: true,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
  });
  await artifactStore.ensureWorkspace(task.id);
  await artifactStore.writeTask(task);
  return task;
}

describe("Backlog decomposition — end to end (Phase 39)", () => {
  let ctx: Awaited<ReturnType<typeof buildOrchestrator>>;
  let executor: ScriptedSubtaskExecutor;

  beforeAll(async () => {
    executor = new ScriptedSubtaskExecutor(THREE_STEP_BACKLOG, null);
    ctx = await buildOrchestrator(executor, "backlog-success");
  });

  afterAll(async () => {
    await rm(ctx.dataDir, { recursive: true, force: true });
    await rm(ctx.tasksDir, { recursive: true, force: true });
    await rm(ctx.repoDir, { recursive: true, force: true });
  });

  it("runs implement+review once per subtask, in order, and completes", async () => {
    const task = await makeDecomposedTask(ctx.taskStore, ctx.artifactStore, ctx.repoDir, "backlog-success-1");
    await ctx.orchestrator.run(task.id);

    const finished = await ctx.taskStore.get(task.id);
    expect(finished?.status).toBe("completed");
    expect(finished?.subtasks).toHaveLength(3);
    expect(finished?.subtasks!.map((s) => s.status)).toEqual(["completed", "completed", "completed"]);

    expect(executor.implementCalls).toHaveLength(3);
    expect(executor.implementCalls.map((s) => s?.index)).toEqual([1, 2, 3]);
    expect(executor.reviewCalls.map((s) => s?.index)).toEqual([1, 2, 3]);

    const history = await ctx.events.history(task.id);
    expect(history.filter((e) => e.type === "SUBTASK_STARTED")).toHaveLength(3);
    expect(history.filter((e) => e.type === "SUBTASK_COMPLETED")).toHaveLength(3);
    expect(history.some((e) => e.type === "SUBTASKS_DECOMPOSED")).toBe(true);
  });
});

describe("Backlog decomposition — stops at the first subtask that fails review (Phase 39)", () => {
  let ctx: Awaited<ReturnType<typeof buildOrchestrator>>;
  let executor: ScriptedSubtaskExecutor;

  beforeAll(async () => {
    executor = new ScriptedSubtaskExecutor(THREE_STEP_BACKLOG, 2);
    ctx = await buildOrchestrator(executor, "backlog-blocked");
  });

  afterAll(async () => {
    await rm(ctx.dataDir, { recursive: true, force: true });
    await rm(ctx.tasksDir, { recursive: true, force: true });
    await rm(ctx.repoDir, { recursive: true, force: true });
  });

  it("marks subtask 1 completed, subtask 2 blocked, and never attempts subtask 3", async () => {
    const task = await makeDecomposedTask(ctx.taskStore, ctx.artifactStore, ctx.repoDir, "backlog-blocked-1");
    await ctx.orchestrator.run(task.id);

    const finished = await ctx.taskStore.get(task.id);
    expect(finished?.status).toBe("blocked");
    expect(finished?.error).toMatch(/subtask 2\/3/i);
    expect(finished?.error).toMatch(/1 of 3 step\(s\) completed/i);

    const statuses = finished?.subtasks!.map((s) => s.status);
    expect(statuses).toEqual(["completed", "blocked", "pending"]);

    // Subtask 3's implement()/review() were never called.
    expect(executor.implementCalls.map((s) => s?.index)).toEqual([1, 2, 2, 2]); // 1 initial + 2 corrective retries for subtask 2
    expect(executor.implementCalls.every((s) => s?.index !== 3)).toBe(true);
  });
});

describe("Backlog decomposition — decomposition call itself failing blocks cleanly (Phase 39)", () => {
  class FailingDecomposeExecutor extends ScriptedSubtaskExecutor {
    async decomposeRequirement(_params: DecomposeRequirementParams): Promise<SubtaskDefinition[]> {
      throw new Error("Simulated decomposition failure.");
    }
  }

  let ctx: Awaited<ReturnType<typeof buildOrchestrator>>;

  beforeAll(async () => {
    ctx = await buildOrchestrator(new FailingDecomposeExecutor(THREE_STEP_BACKLOG), "backlog-decompose-fail");
  });

  afterAll(async () => {
    await rm(ctx.dataDir, { recursive: true, force: true });
    await rm(ctx.tasksDir, { recursive: true, force: true });
    await rm(ctx.repoDir, { recursive: true, force: true });
  });

  it("blocks with a clear reason and no subtasks recorded", async () => {
    const task = await makeDecomposedTask(ctx.taskStore, ctx.artifactStore, ctx.repoDir, "backlog-decompose-fail-1");
    await ctx.orchestrator.run(task.id);

    const finished = await ctx.taskStore.get(task.id);
    expect(finished?.status).toBe("blocked");
    expect(finished?.error).toMatch(/Backlog decomposition failed/);
    expect(finished?.subtasks).toBeUndefined();
  });
});

describe("Backlog decomposition — default behavior is unchanged when not opted in (Phase 39)", () => {
  it("a task without decomposeRequirement never calls decomposeRequirement() at all", async () => {
    class AssertNeverDecomposedExecutor extends ScriptedSubtaskExecutor {
      async decomposeRequirement(): Promise<SubtaskDefinition[]> {
        throw new Error("decomposeRequirement should never be called for a non-decomposed task.");
      }
    }
    const executor = new AssertNeverDecomposedExecutor(THREE_STEP_BACKLOG, null);
    const ctx = await buildOrchestrator(executor, "backlog-default");
    try {
      const now = new Date().toISOString();
      const task = await ctx.taskStore.create({
        id: "backlog-default-1",
        title: "Add a health endpoint",
        requirement: "Add a GET /health endpoint.",
        repository: ctx.repoDir,
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
      await ctx.artifactStore.ensureWorkspace(task.id);
      await ctx.artifactStore.writeTask(task);

      await ctx.orchestrator.run(task.id);

      const finished = await ctx.taskStore.get(task.id);
      expect(finished?.status).toBe("completed");
      expect(finished?.subtasks).toBeUndefined();
      expect(executor.implementCalls).toHaveLength(1);
      expect(executor.implementCalls[0]).toBeUndefined(); // no activeSubtask for a non-decomposed task
    } finally {
      await rm(ctx.dataDir, { recursive: true, force: true });
      await rm(ctx.tasksDir, { recursive: true, force: true });
      await rm(ctx.repoDir, { recursive: true, force: true });
    }
  });
});
