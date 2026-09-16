import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskStore } from "../src/store/taskStore.js";
import type { ArtifactStore as ArtifactStoreType } from "../src/artifacts/artifactStore.js";
import type { TaskOrchestrator as TaskOrchestratorType } from "../src/orchestrator/taskOrchestrator.js";
import type { ClaudeCodeExecutor, AnalyzeParams, ConflictResolutionDecision, ConflictResolutionParams, DirectionDecision, DirectionDecisionParams, ImplementParams, ReviewParams, RunTestsParams } from "../src/execution/ClaudeCodeExecutor.js";
import type { ExecutionReport, ReviewReport, SpecialistReport, TestRunResult } from "../src/types/index.js";
import { recomputeStatus } from "../src/orchestrator/reconciliation.js";

/**
 * A deterministic fixture executor whose two specialists genuinely disagree
 * on the same engineering decision (plan section 29 — "use a deterministic
 * fixture where possible" for manual/e2e validation). Deliberately
 * constructed directly rather than via the shared MockClaudeCodeExecutor so
 * that executor's own, already-covered heuristic output stays untouched.
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

  async decideConflictResolution(_params: ConflictResolutionParams): Promise<ConflictResolutionDecision> {
    throw new Error("decideConflictResolution is not exercised by this fixture.");
  }
}

let dataDir: string;
let tasksDir: string;
let repoDir: string;
let taskStore: TaskStore;
let artifactStore: ArtifactStoreType;
let orchestrator: TaskOrchestratorType;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "conflict-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "conflict-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "conflict-repo-"));

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
  const events = new TaskEventBus(artifactStore);
  const worktrees = new GitWorktreeManager();
  const memory = new JsonFileMemoryStore(dataDir);
  orchestrator = new TaskOrchestrator(taskStore, artifactStore, events, new ConflictingStubExecutor(), worktrees, memory);
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

async function waitForStatus(taskId: string, statuses: string[], timeoutMs = 5000): Promise<{ status: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await taskStore.get(taskId);
    if (task && statuses.includes(task.status)) return task;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for status in [${statuses.join(", ")}], last: ${task?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Reconciliation CONFLICT — full pipeline demonstration", () => {
  it("blocks the task on a genuine specialist disagreement, then resumes to completion once resolved", async () => {
    const now = new Date().toISOString();
    const task = await taskStore.create({
      id: "conflict-task-1",
      title: "Add order creation endpoint",
      requirement: "Add an order creation endpoint with a database transaction.",
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
    expect(blocked.error).toMatch(/material engineering conflict/i);

    const reconciliation = await artifactStore.readReconciliation(task.id);
    expect(reconciliation?.status).toBe("CONFLICT");
    expect(reconciliation?.conflicts).toHaveLength(1);
    const conflict = reconciliation!.conflicts[0];
    expect(conflict.kind).toBe("specialist-disagreement");
    expect(conflict.category).toBe("transaction");
    expect(conflict.materiality).toBe("material");
    expect(conflict.participants.map((p) => p.agent).sort()).toEqual(["database", "node-backend"]);

    // Developer inspects evidence, then resolves — same state transition the
    // API route performs (see routes/tasks.ts's resolve handler).
    conflict.resolution = {
      resolution: "Use a transaction. The outbox/eventually-consistent design was rejected after review.",
      reason: "Order creation does not actually span services in this repository.",
      resolvedBy: "developer",
      resolvedAt: new Date().toISOString(),
    };
    reconciliation!.status = recomputeStatus(reconciliation!);
    await artifactStore.writeReconciliation(reconciliation!);
    expect(reconciliation!.status).toBe("AGREED");

    await orchestrator.resumeAfterConflictResolution(task.id);

    const completed = await waitForStatus(task.id, ["completed", "failed", "blocked"]);
    expect(completed.status).toBe("completed");

    const finalReconciliation = await artifactStore.readReconciliation(task.id);
    expect(finalReconciliation?.conflicts[0].resolution?.resolvedBy).toBe("developer");

    const handoff = await artifactStore.readFinalHandoff(task.id);
    expect(handoff?.status).toBe("completed");
  });
});
