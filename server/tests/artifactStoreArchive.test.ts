import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactStore as ArtifactStoreType } from "../src/artifacts/artifactStore.js";
import type { ExecutionReport, ImplementationPlan, Reconciliation, ReviewReport, SpecialistReport } from "../src/types/index.js";

let tasksDir: string;
let artifactStore: ArtifactStoreType;

beforeAll(async () => {
  tasksDir = await mkdtemp(path.join(tmpdir(), "archive-tasks-"));
  process.env.TASKS_DIR = tasksDir;
  process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "archive-data-"));

  const { ArtifactStore } = await import("../src/artifacts/artifactStore.js");
  artifactStore = new ArtifactStore();
});

afterAll(async () => {
  await rm(tasksDir, { recursive: true, force: true });
});

function specialistReport(taskId: string): SpecialistReport {
  return {
    agent: "node-backend",
    taskId,
    status: "completed",
    recommendation: "Add the endpoint.",
    findings: [],
    risks: [],
    assumptions: [],
    confidence: 0.9,
    executionMode: "mock",
    createdAt: new Date().toISOString(),
  };
}

function reconciliation(taskId: string): Reconciliation {
  return {
    taskId,
    status: "AGREED",
    decisions: [],
    agreements: [],
    conflicts: [],
    unresolvedQuestions: [],
    risks: [],
    confidencePercent: 90,
    createdAt: new Date().toISOString(),
  };
}

function plan(taskId: string): ImplementationPlan {
  return { taskId, summary: "Add the endpoint.", files: [{ path: "src/health.ts", description: "New route" }], validationCommands: [], createdAt: new Date().toISOString() };
}

function report(taskId: string): ExecutionReport {
  return { taskId, executionMode: "mock", status: "completed", changedFiles: ["src/health.ts"], tests: [], commandsExecuted: [], notes: [], createdAt: new Date().toISOString() };
}

function review(taskId: string): ReviewReport {
  return { agent: "node-backend", taskId, status: "PASS", findings: [], executionMode: "mock", createdAt: new Date().toISOString(), attempt: 1 };
}

describe("ArtifactStore.archiveAttempt", () => {
  it("moves every artifact into attempts/<n>/ and removes it from the top level, leaving task.json and events.log.jsonl untouched", async () => {
    const taskId = "archive-full-1";
    await artifactStore.ensureWorkspace(taskId);
    await artifactStore.writeTask({
      id: taskId,
      title: "t",
      requirement: "r",
      repository: "/tmp/x",
      status: "blocked",
      detectedStack: null,
      selectedAgents: ["node-backend"],
      currentStage: "reviewing",
      executionMode: "mock",
      reviewRetryCount: 0,
      attempt: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await artifactStore.appendEvent({ id: "e1", taskId, type: "TASK_CREATED", message: "created", createdAt: new Date().toISOString() });
    await artifactStore.writeSpecialistReport(specialistReport(taskId));
    await artifactStore.writeReconciliation(reconciliation(taskId));
    await artifactStore.writeImplementationPlan(plan(taskId));
    await artifactStore.writeExecutionReport(report(taskId));
    await artifactStore.writeReviewReport(review(taskId));
    await artifactStore.writeFinalHandoff(
      { taskId, summary: "s", agentsUsed: ["node-backend"], filesChanged: 1, testsPassed: 0, testsFailed: 0, reviewsPassed: 1, reviewsFailed: 0, architectureDecisions: 0, warnings: 0, executionMode: "mock", status: "completed", createdAt: new Date().toISOString() },
      "# Final Handoff"
    );

    const root = path.join(tasksDir, taskId);
    expect(existsSync(path.join(root, "reconciliation.json"))).toBe(true);

    await artifactStore.archiveAttempt(taskId, 1);

    // Top level is clear of attempt-scoped artifacts.
    expect(existsSync(path.join(root, "reconciliation.json"))).toBe(false);
    expect(existsSync(path.join(root, "implementation-plan.json"))).toBe(false);
    expect(existsSync(path.join(root, "execution-report.json"))).toBe(false);
    expect(existsSync(path.join(root, "final-handoff.json"))).toBe(false);
    expect(existsSync(path.join(root, "final-handoff.md"))).toBe(false);
    expect(existsSync(path.join(root, "specialist-reports", "specialist-node-backend.json"))).toBe(false);
    expect(existsSync(path.join(root, "reviews"))).toBe(false);

    // task.json and events.log.jsonl are never archived.
    expect(existsSync(path.join(root, "task.json"))).toBe(true);
    expect(existsSync(path.join(root, "events.log.jsonl"))).toBe(true);

    // Everything is readable back under attempts/1.
    expect(await artifactStore.readArchivedReconciliation(taskId, 1)).not.toBeNull();
    expect(await artifactStore.readArchivedImplementationPlan(taskId, 1)).not.toBeNull();
    expect(await artifactStore.readArchivedExecutionReport(taskId, 1)).not.toBeNull();
    expect(await artifactStore.readArchivedFinalHandoff(taskId, 1)).not.toBeNull();
    expect(await artifactStore.readArchivedFinalHandoffMarkdown(taskId, 1)).toBe("# Final Handoff");
    const reports = await artifactStore.readArchivedSpecialistReports(taskId, 1, ["node-backend", "python-backend", "database"]);
    expect(reports).toHaveLength(1);
    const reviews = await artifactStore.readArchivedReviews(taskId, 1, ["node-backend", "python-backend", "database"]);
    expect(reviews).toHaveLength(1);

    expect(await artifactStore.listAttempts(taskId)).toEqual([1]);
  });

  it("archives cleanly when a task failed before producing any artifacts beyond the empty workspace directories", async () => {
    const taskId = "archive-empty-1";
    await artifactStore.ensureWorkspace(taskId);
    await artifactStore.writeTask({
      id: taskId,
      title: "t",
      requirement: "r",
      repository: "/tmp/x",
      status: "failed",
      detectedStack: null,
      selectedAgents: [],
      currentStage: "inspecting",
      executionMode: "mock",
      reviewRetryCount: 0,
      attempt: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await expect(artifactStore.archiveAttempt(taskId, 1)).resolves.toBeUndefined();
    expect(await artifactStore.listAttempts(taskId)).toEqual([1]);
    expect(await artifactStore.readArchivedReconciliation(taskId, 1)).toBeNull();
  });

  it("throws and leaves prior state discoverable when a destination path is blocked, so the caller can abort the retry without resetting task.json", async () => {
    const taskId = "archive-fail-1";
    await artifactStore.ensureWorkspace(taskId);
    await artifactStore.writeTask({
      id: taskId,
      title: "t",
      requirement: "r",
      repository: "/tmp/x",
      status: "blocked",
      detectedStack: null,
      selectedAgents: ["node-backend"],
      currentStage: "reconciling",
      executionMode: "mock",
      reviewRetryCount: 0,
      attempt: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await artifactStore.writeReconciliation(reconciliation(taskId));
    await artifactStore.writeImplementationPlan(plan(taskId));

    // Deterministically force a real filesystem failure: pre-create the
    // destination reconciliation.json path as a directory, so renaming the
    // *file* onto it fails with EISDIR/ENOTEMPTY — a genuine fs condition,
    // not a mocked one.
    const blockedDest = path.join(tasksDir, taskId, "attempts", "1", "reconciliation.json");
    await mkdir(blockedDest, { recursive: true });

    await expect(artifactStore.archiveAttempt(taskId, 1)).rejects.toThrow();

    const root = path.join(tasksDir, taskId);
    // task.json is never touched by archiveAttempt itself.
    expect(existsSync(path.join(root, "task.json"))).toBe(true);
    // Nothing was silently lost: implementation-plan.json — alphabetically
    // after reconciliation.json is not guaranteed to have been reached, but
    // whatever *was* moved is still findable under attempts/1, and whatever
    // wasn't is still at the top level. Either way it exists somewhere.
    const planStillFindable = existsSync(path.join(root, "implementation-plan.json")) || existsSync(path.join(root, "attempts", "1", "implementation-plan.json"));
    expect(planStillFindable).toBe(true);
  });
});
