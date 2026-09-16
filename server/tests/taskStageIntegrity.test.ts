import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { TaskStore } from "../src/store/taskStore.js";
import type { ArtifactStore as ArtifactStoreType } from "../src/artifacts/artifactStore.js";
import type { TaskOrchestrator as TaskOrchestratorType } from "../src/orchestrator/taskOrchestrator.js";
import type { ClaudeCodeExecutor, AnalyzeParams, ConflictResolutionDecision, ConflictResolutionParams, DecomposeRequirementParams, DirectionDecision, DirectionDecisionParams, ImplementParams, ReviewParams, RunTestsParams, SubtaskDefinition } from "../src/execution/ClaudeCodeExecutor.js";
import type { ExecutionReport, ReviewReport, SpecialistReport, TestRunResult } from "../src/types/index.js";

/**
 * Real pipeline stage names (STAGE_SEQUENCE equivalents on the server side)
 * — used to assert `task.currentStage` is always one of these, never the
 * synthetic status strings "blocked"/"cancelled" the Phase 34 bug produced.
 */
const REAL_PIPELINE_STAGES = new Set([
  "created",
  "inspecting",
  "routing",
  "analyzing",
  "reconciling",
  "planning",
  "implementing",
  "reviewing",
  "completed",
]);

/**
 * Same genuinely-disagreeing fixture as reconciliationConflict.e2e.test.ts
 * — reused here (not imported, since that file doesn't export it) purely to
 * drive a task to `blocked` via a real material conflict, so this suite
 * proves the currentStage fix against a task the actual orchestrator put
 * into that state, not a hand-built fixture (Phase 34 §20's explicit
 * requirement).
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

describe("Task stage integrity — block() preserves the real pipeline stage (Phase 34)", () => {
  let dataDir: string;
  let tasksDir: string;
  let repoDir: string;
  let taskStore: TaskStore;
  let artifactStore: ArtifactStoreType;
  let orchestrator: TaskOrchestratorType;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "stageintegrity-data-"));
    tasksDir = await mkdtemp(path.join(tmpdir(), "stageintegrity-tasks-"));
    repoDir = await mkdtemp(path.join(tmpdir(), "stageintegrity-repo-"));
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
    const memory = new JsonFileMemoryStore(dataDir);
    orchestrator = new TaskOrchestrator(taskStore, artifactStore, events, new ConflictingStubExecutor(), new GitWorktreeManager(), memory);
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(tasksDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("blocked at reconciliation: currentStage is 'reconciling', never the literal 'blocked'", async () => {
    const now = new Date().toISOString();
    const task = await taskStore.create({
      id: "stage-integrity-reconciling",
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

    await orchestrator.run(task.id);

    const finished = await taskStore.get(task.id);
    expect(finished?.status).toBe("blocked");
    // The bug: block() used to overwrite this with the literal string
    // "blocked" — a task *status*, not a pipeline *stage* — which broke the
    // Task Detail stage timeline (every stage rendered as not-yet-reached).
    expect(finished?.currentStage).toBe("reconciling");
    expect(finished?.currentStage).not.toBe("blocked");
    expect(REAL_PIPELINE_STAGES.has(finished!.currentStage)).toBe(true);

    // Archived-attempt outcome summary (Phase 34): reconciliation.json
    // exists for this attempt (written before the block), but no plan or
    // execution report ever got written — so the honest, evidence-only
    // answer is "reconciling", not a guess at whether it was specifically
    // this task's material-conflict block versus some other reconciliation
    // outcome (that specific reason isn't archived, only which files exist).
    // Archives directly via ArtifactStore rather than orchestrator.retry()
    // to avoid that method's fire-and-forget re-run racing this describe
    // block's own teardown.
    await artifactStore.archiveAttempt(task.id, 1);
    const attempts = await artifactStore.listAttempts(task.id);
    expect(attempts).toEqual([1]);
    expect(await artifactStore.describeArchivedAttempt(task.id, 1)).toBe("reconciling");
  });
});

describe("Task stage integrity — routing and cancellation (Phase 34)", () => {
  let app: Express;
  let dataDir: string;
  let tasksDir: string;
  let ambiguousRepoDir: string;
  let ordinaryRepoDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "stageintegrity2-data-"));
    tasksDir = await mkdtemp(path.join(tmpdir(), "stageintegrity2-tasks-"));
    ambiguousRepoDir = await mkdtemp(path.join(tmpdir(), "stageintegrity2-ambiguous-repo-"));
    ordinaryRepoDir = await mkdtemp(path.join(tmpdir(), "stageintegrity2-ordinary-repo-"));

    // No package.json/requirements.txt/pyproject.toml — repository inspection
    // resolves language "unknown"; combined with a requirement that names no
    // backend technology, routing legitimately selects zero agents.
    await writeFile(path.join(ambiguousRepoDir, "README.md"), "# Just some notes\n");

    await writeFile(path.join(ordinaryRepoDir, "package.json"), JSON.stringify({ dependencies: { express: "^4.0.0" }, scripts: { test: "echo ok" } }));

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
    await rm(ordinaryRepoDir, { recursive: true, force: true });
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

  it("blocked at routing (no specialist selected): currentStage is 'routing', never 'blocked'", async () => {
    const createRes = await request(app).post("/api/tasks").send({
      title: "Improve the documentation clarity",
      requirement: "Improve the documentation clarity.",
      repository: ambiguousRepoDir,
    });
    expect(createRes.status).toBe(201);
    const taskId = createRes.body.task.id;

    await request(app).post(`/api/tasks/${taskId}/start`);
    const task = await waitForTerminal(taskId);

    expect(task.status).toBe("blocked");
    expect(task.error).toMatch(/No specialist could be confidently selected/i);
    expect(task.currentStage).toBe("routing");
    expect(task.currentStage).not.toBe("blocked");
    expect(REAL_PIPELINE_STAGES.has(task.currentStage)).toBe(true);

    // Archived-attempt outcome (Phase 34): nothing was ever written for this
    // attempt (blocked before any specialist ran), so the honest answer is
    // "early" — not invented, just the absence of every artifact checked.
    // Archives directly rather than via /retry to avoid that endpoint's
    // fire-and-forget re-run racing this describe block's own teardown.
    const { artifactStore } = await import("../src/container.js");
    await artifactStore.archiveAttempt(taskId, 1);
    expect(await artifactStore.describeArchivedAttempt(taskId, 1)).toBe("early");
  });

  it("cancel preserves the real currentStage instead of overwriting it with 'cancelled'", async () => {
    // Seed a task directly at a known non-terminal status/currentStage —
    // this exercises exactly the code path that had the bug (the cancel
    // route handler), deterministically, without racing a live pipeline.
    const { taskStore, artifactStore } = await import("../src/container.js");
    const now = new Date().toISOString();
    const task = await taskStore.create({
      id: "stage-integrity-cancel-implementing",
      title: "Add a widget endpoint",
      requirement: "Add a GET /widgets endpoint.",
      repository: ordinaryRepoDir,
      status: "implementing",
      detectedStack: { language: "node", packageManager: "npm", framework: null, database: null, testCommand: "echo ok", lintCommand: null, typecheckCommand: null, evidence: [] },
      selectedAgents: ["node-backend"],
      currentStage: "implementing",
      executionMode: "mock",
      reviewRetryCount: 0,
      attempt: 1,
      createdAt: now,
      updatedAt: now,
    });
    await artifactStore.ensureWorkspace(task.id);
    await artifactStore.writeTask(task);

    const cancelRes = await request(app).post(`/api/tasks/${task.id}/cancel`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.task.status).toBe("cancelled");
    // The bug: the cancel route used to overwrite currentStage with the
    // literal string "cancelled", also breaking the stage timeline.
    expect(cancelRes.body.task.currentStage).toBe("implementing");
    expect(cancelRes.body.task.currentStage).not.toBe("cancelled");
    expect(REAL_PIPELINE_STAGES.has(cancelRes.body.task.currentStage)).toBe(true);

    const persisted = await request(app).get(`/api/tasks/${task.id}`);
    expect(persisted.body.task.currentStage).toBe("implementing");
  });
});
