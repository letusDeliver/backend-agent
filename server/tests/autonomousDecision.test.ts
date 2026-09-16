import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { MockClaudeCodeExecutor as MockClaudeCodeExecutorType } from "../src/execution/MockClaudeCodeExecutor.js";
import type { TaskStore } from "../src/store/taskStore.js";
import type { ArtifactStore as ArtifactStoreType } from "../src/artifacts/artifactStore.js";
import type { TaskOrchestrator as TaskOrchestratorType } from "../src/orchestrator/taskOrchestrator.js";
import type {
  ClaudeCodeExecutor,
  AnalyzeParams,
  ConflictResolutionDecision,
  ConflictResolutionParams,
  DecomposeRequirementParams,
  DirectionDecisionParams,
  DirectionDecision,
  ImplementParams,
  ReviewParams,
  RunTestsParams,
  SubtaskDefinition,
} from "../src/execution/ClaudeCodeExecutor.js";
import type { ExecutionReport, ReviewReport, SpecialistReport, TestRunResult } from "../src/types/index.js";

describe("MockClaudeCodeExecutor.decideDirection — Phase 36 deterministic fixture", () => {
  let executor: MockClaudeCodeExecutorType;

  beforeAll(async () => {
    // Dynamically imported, never at file top level — see the Phase 39
    // note in backlogDecomposition.test.ts for why a real top-level import
    // here would freeze config.tasksDir/dataDir before this file's other
    // describe blocks get to override DATA_DIR/TASKS_DIR in their own
    // beforeAll, leaking task directories into the real project's tasks/.
    const { MockClaudeCodeExecutor } = await import("../src/execution/MockClaudeCodeExecutor.js");
    executor = new MockClaudeCodeExecutor();
  });

  function makeTask(requirement: string) {
    const now = new Date().toISOString();
    return {
      id: "task-1",
      title: "Task",
      requirement,
      repository: "/tmp/repo",
      status: "created" as const,
      detectedStack: null,
      selectedAgents: [],
      currentStage: "created",
      executionMode: "mock" as const,
      reviewRetryCount: 0,
      attempt: 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  const stack = { language: "unknown" as const, packageManager: null, framework: null, database: null, testCommand: null, lintCommand: null, typecheckCommand: null, evidence: [] };

  it("defaults to Node.js when the requirement gives no stack signal at all", async () => {
    const result = await executor.decideDirection({ task: makeTask("Build the thing we discussed."), detectedStack: stack });
    expect(result.language).toBe("node");
    expect(result.agents).toEqual(["node-backend"]);
    expect(result.executionMode).toBe("mock");
    expect(result.rationale).toMatch(/MOCK \/ SIMULATED EXECUTION/);
  });

  it("chooses Python when the requirement names a Python framework", async () => {
    const result = await executor.decideDirection({ task: makeTask("Build a FastAPI service for user signup."), detectedStack: stack });
    expect(result.language).toBe("python");
    expect(result.agents).toEqual(["python-backend"]);
  });

  it("adds the database specialist when persistence is mentioned", async () => {
    const result = await executor.decideDirection({ task: makeTask("Build a service with a PostgreSQL schema and migrations."), detectedStack: stack });
    expect(result.agents).toContain("database");
  });
});

describe("Autonomous routing decision — end to end (Phase 36)", () => {
  let app: Express;
  let dataDir: string;
  let tasksDir: string;
  let ambiguousRepoDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "autonomous-data-"));
    tasksDir = await mkdtemp(path.join(tmpdir(), "autonomous-tasks-"));
    ambiguousRepoDir = await mkdtemp(path.join(tmpdir(), "autonomous-repo-"));
    await writeFile(path.join(ambiguousRepoDir, "README.md"), "# Just some notes\n");

    process.env.DATA_DIR = dataDir;
    process.env.TASKS_DIR = tasksDir;
    process.env.CLAUDE_EXECUTION_MODE = "mock";

    const { createApp } = await import("../src/app.js");
    app = createApp();
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(tasksDir, { recursive: true, force: true });
    await rm(ambiguousRepoDir, { recursive: true, force: true });
  });

  async function waitForTerminal(taskId: string, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    let task;
    while (Date.now() < deadline) {
      const res = await request(app).get(`/api/tasks/${taskId}`);
      task = res.body.task;
      if (["completed", "blocked", "failed", "cancelled"].includes(task.status)) return task;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return task;
  }

  it("a task created without autonomyLevel defaults to advisory", async () => {
    const createRes = await request(app).post("/api/tasks").send({
      title: "Improve the documentation clarity",
      requirement: "Improve the documentation clarity.",
      repository: ambiguousRepoDir,
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.task.autonomyLevel).toBe("advisory");
    expect(createRes.body.task.autonomousDecisions).toEqual([]);
  });

  it("autonomous mode decides a direction instead of blocking when routing is otherwise ambiguous", async () => {
    const createRes = await request(app).post("/api/tasks").send({
      title: "Improve the documentation clarity",
      requirement: "Improve the documentation clarity.",
      repository: ambiguousRepoDir,
      autonomyLevel: "autonomous",
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.task.autonomyLevel).toBe("autonomous");
    const taskId = createRes.body.task.id;

    await request(app).post(`/api/tasks/${taskId}/start`);
    const task = await waitForTerminal(taskId);

    // The ambiguous repo + vague requirement would otherwise block at
    // routing (see taskStageIntegrity.test.ts) — autonomous mode must
    // decide a direction and let the pipeline proceed all the way through.
    expect(task.status).not.toBe("blocked");
    expect(task.selectedAgents.length).toBeGreaterThan(0);

    expect(task.autonomousDecisions).toHaveLength(1);
    const decision = task.autonomousDecisions[0];
    expect(decision.subject).toBe("routing");
    expect(decision.agents.length).toBeGreaterThan(0);
    expect(decision.executionMode).toBe("mock");
    expect(typeof decision.confidence).toBe("number");

    // /events is a long-lived SSE stream (never closes on its own) — assert
    // via the event history helper directly rather than issuing a plain
    // HTTP request against it, which would hang for the test's full timeout.
    const { eventBus } = await import("../src/container.js");
    const history = await eventBus.history(taskId);
    expect(history.some((e) => e.type === "AUTONOMOUS_DECISION_MADE")).toBe(true);
  });
});

class FailingDirectionExecutor implements ClaudeCodeExecutor {
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

  async implement({ task, plan }: ImplementParams): Promise<ExecutionReport> {
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

  async decideDirection(_params: DirectionDecisionParams): Promise<DirectionDecision> {
    throw new Error("Simulated arbitration failure.");
  }

  async decideConflictResolution(_params: ConflictResolutionParams): Promise<ConflictResolutionDecision> {
    throw new Error("decideConflictResolution is not exercised by this fixture.");
  }

  async decomposeRequirement(_params: DecomposeRequirementParams): Promise<SubtaskDefinition[]> {
    throw new Error("decomposeRequirement is not exercised by this fixture.");
  }
}

describe("Autonomous routing decision — arbitration failure falls back to blocking (Phase 36)", () => {
  let dataDir: string;
  let tasksDir: string;
  let repoDir: string;
  let taskStore: TaskStore;
  let artifactStore: ArtifactStoreType;
  let orchestrator: TaskOrchestratorType;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "autonomous-fail-data-"));
    tasksDir = await mkdtemp(path.join(tmpdir(), "autonomous-fail-tasks-"));
    repoDir = await mkdtemp(path.join(tmpdir(), "autonomous-fail-repo-"));
    await writeFile(path.join(repoDir, "README.md"), "# Just some notes\n");

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
    const memory = new JsonFileMemoryStore(dataDir);
    orchestrator = new TaskOrchestrator(taskStore, artifactStore, events, new FailingDirectionExecutor(), new GitWorktreeManager(), memory);
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(tasksDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("blocks with a clear reason when the autonomous decision call itself fails", async () => {
    const now = new Date().toISOString();
    const task = await taskStore.create({
      id: "autonomous-arbitration-failure",
      title: "Improve the documentation clarity",
      requirement: "Improve the documentation clarity.",
      repository: repoDir,
      status: "created",
      detectedStack: null,
      selectedAgents: [],
      currentStage: "created",
      executionMode: "mock",
      reviewRetryCount: 0,
      autonomyLevel: "autonomous",
      autonomousDecisions: [],
      attempt: 1,
      createdAt: now,
      updatedAt: now,
    });

    await orchestrator.run(task.id);

    const finished = await taskStore.get(task.id);
    expect(finished?.status).toBe("blocked");
    expect(finished?.error).toMatch(/Autonomous decision mode was enabled, but no confident direction could be decided either/);
    expect(finished?.autonomousDecisions).toEqual([]);
  });
});
