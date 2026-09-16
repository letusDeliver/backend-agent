import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  DirectionDecision,
  DirectionDecisionParams,
  ImplementParams,
  ReviewParams,
  RunTestsParams,
  SubtaskDefinition,
} from "../src/execution/ClaudeCodeExecutor.js";
import type { ExecutionReport, ReconciliationConflict, ReviewReport, SpecialistReport, TestRunResult } from "../src/types/index.js";

describe("MockClaudeCodeExecutor.decideConflictResolution — Phase 37 deterministic fixture", () => {
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

  function makeConflict(overrides: Partial<ReconciliationConflict> = {}): ReconciliationConflict {
    return {
      id: "conflict-1",
      kind: "specialist-disagreement",
      category: "transaction",
      subject: "Order creation persistence",
      detectedAt: "reconciliation",
      participants: [
        { agent: "node-backend", decision: "Use a transaction.", rationale: "Writes must be atomic.", evidence: "src/routes/orders.ts", confidence: 0.9, polarity: "affirmative", memoryInfluenced: false, memoryIds: [] },
        { agent: "database", decision: "Do not use a transaction.", rationale: "Eventually consistent via outbox.", evidence: "schema.sql", confidence: 0.6, polarity: "negative", memoryInfluenced: false, memoryIds: [] },
      ],
      materiality: "material",
      reason: "Both agents made a material, opposing transaction decision for the same subject.",
      resolution: null,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeTask() {
    const now = new Date().toISOString();
    return {
      id: "task-1",
      title: "Task",
      requirement: "Add an order creation endpoint with a database transaction.",
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

  it("adopts the highest-confidence participant's position", async () => {
    const result = await executor.decideConflictResolution({ task: makeTask(), conflict: makeConflict() });
    expect(result.resolution).toMatch(/Use a transaction\./);
    expect(result.reason).toMatch(/MOCK \/ SIMULATED EXECUTION/);
    expect(result.executionMode).toBe("mock");
  });

  it("still returns a usable (low-confidence) result when there are no participants", async () => {
    const result = await executor.decideConflictResolution({ task: makeTask(), conflict: makeConflict({ participants: [] }) });
    expect(result.resolution).toBeTruthy();
    expect(result.confidence).toBeLessThan(0.5);
  });
});

/**
 * Same genuinely-disagreeing fixture as reconciliationConflict.e2e.test.ts
 * (two specialists materially disagree on the same transaction decision),
 * extended with a working decideConflictResolution() so this suite can
 * drive the real orchestrator's autonomous-arbitration branch end to end.
 */
class ConflictingStubExecutor implements ClaudeCodeExecutor {
  readonly mode = "mock" as const;

  async analyze({ agent, task }: AnalyzeParams): Promise<SpecialistReport> {
    const base = {
      agent,
      taskId: task.id,
      status: "completed" as const,
      risks: [],
      assumptions: [],
      confidence: 0.9,
      executionMode: "mock" as const,
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
    return {
      taskId: task.id,
      executionMode: "mock",
      status: "completed",
      changedFiles: plan.files.map((f) => f.path),
      tests: [],
      commandsExecuted: [],
      notes: ["Deterministic conflict-fixture executor — no files actually touched."],
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
    throw new Error("decideDirection is not exercised by this fixture.");
  }

  async decideConflictResolution({ conflict }: ConflictResolutionParams): Promise<ConflictResolutionDecision> {
    return {
      resolution: "Use a transaction. The outbox/eventually-consistent design does not apply here.",
      reason: `Autonomous arbitration for "${conflict.subject}": order creation does not actually span services in this repository.`,
      confidence: 0.75,
      executionMode: "mock",
      createdAt: new Date().toISOString(),
    };
  }

  async decomposeRequirement(_params: DecomposeRequirementParams): Promise<SubtaskDefinition[]> {
    throw new Error("decomposeRequirement is not exercised by this fixture.");
  }
}

class ThrowingConflictExecutor extends ConflictingStubExecutor {
  async decideConflictResolution(_params: ConflictResolutionParams): Promise<ConflictResolutionDecision> {
    throw new Error("Simulated arbitration failure.");
  }
}

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
  const events = new TaskEventBus(artifactStore);
  const memory = new JsonFileMemoryStore(dataDir);
  const orchestrator: TaskOrchestratorType = new TaskOrchestrator(taskStore, artifactStore, events, executor, new GitWorktreeManager(), memory);

  return { dataDir, tasksDir, repoDir, taskStore, artifactStore, events, orchestrator };
}

describe("Autonomous reconciliation-conflict resolution — end to end (Phase 37)", () => {
  let ctx: Awaited<ReturnType<typeof buildOrchestrator>>;

  beforeAll(async () => {
    ctx = await buildOrchestrator(new ConflictingStubExecutor(), "autonomous-conflict");
  });

  afterAll(async () => {
    await rm(ctx.dataDir, { recursive: true, force: true });
    await rm(ctx.tasksDir, { recursive: true, force: true });
    await rm(ctx.repoDir, { recursive: true, force: true });
  });

  it("resolves the material conflict autonomously and completes instead of blocking", async () => {
    const now = new Date().toISOString();
    const task = await ctx.taskStore.create({
      id: "autonomous-conflict-task-1",
      title: "Add order creation endpoint",
      requirement: "Add an order creation endpoint with a database transaction.",
      repository: ctx.repoDir,
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
    await ctx.artifactStore.ensureWorkspace(task.id);
    await ctx.artifactStore.writeTask(task);

    await ctx.orchestrator.run(task.id);

    const finished = await ctx.taskStore.get(task.id);
    expect(finished?.status).toBe("completed");

    expect(finished?.autonomousDecisions).toHaveLength(1);
    const decision = finished!.autonomousDecisions![0];
    expect(decision.subject).toBe("reconciliation-conflict");
    expect(decision.executionMode).toBe("mock");
    expect(typeof decision.confidence).toBe("number");

    const reconciliation = await ctx.artifactStore.readReconciliation(task.id);
    expect(reconciliation?.status).toBe("AGREED");
    expect(reconciliation?.conflicts).toHaveLength(1);
    const conflict = reconciliation!.conflicts[0];
    expect(conflict.resolution?.resolvedBy).toBe("autonomous-arbitration");
    expect(decision.conflictId).toBe(conflict.id);

    const history = await ctx.events.history(task.id);
    expect(history.some((e) => e.type === "AUTONOMOUS_DECISION_MADE")).toBe(true);
  });
});

describe("Autonomous reconciliation-conflict resolution — arbitration failure falls back to blocking (Phase 37)", () => {
  let ctx: Awaited<ReturnType<typeof buildOrchestrator>>;

  beforeAll(async () => {
    ctx = await buildOrchestrator(new ThrowingConflictExecutor(), "autonomous-conflict-fail");
  });

  afterAll(async () => {
    await rm(ctx.dataDir, { recursive: true, force: true });
    await rm(ctx.tasksDir, { recursive: true, force: true });
    await rm(ctx.repoDir, { recursive: true, force: true });
  });

  it("blocks exactly as before when the arbitration call itself fails, recording no decision", async () => {
    const now = new Date().toISOString();
    const task = await ctx.taskStore.create({
      id: "autonomous-conflict-fail-task-1",
      title: "Add order creation endpoint",
      requirement: "Add an order creation endpoint with a database transaction.",
      repository: ctx.repoDir,
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
    await ctx.artifactStore.ensureWorkspace(task.id);
    await ctx.artifactStore.writeTask(task);

    await ctx.orchestrator.run(task.id);

    const finished = await ctx.taskStore.get(task.id);
    expect(finished?.status).toBe("blocked");
    expect(finished?.error).toMatch(/material engineering conflict/i);
    expect(finished?.autonomousDecisions).toEqual([]);

    const reconciliation = await ctx.artifactStore.readReconciliation(task.id);
    expect(reconciliation?.conflicts[0]?.resolution).toBeNull();
  });
});
