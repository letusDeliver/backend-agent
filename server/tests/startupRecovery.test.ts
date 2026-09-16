import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskStore } from "../src/store/taskStore.js";
import type { ArtifactStore as ArtifactStoreType } from "../src/artifacts/artifactStore.js";
import type { TaskEventBus as TaskEventBusType } from "../src/events/eventBus.js";
import type { Task, TaskStatus } from "../src/types/index.js";

let dataDir: string;
let tasksDir: string;
let taskStore: TaskStore;
let artifactStore: ArtifactStoreType;
let events: TaskEventBusType;
let recoverOrphanedTasks: (taskStore: TaskStore, artifacts: ArtifactStoreType, events: TaskEventBusType) => Promise<number>;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "recovery-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "recovery-tasks-"));
  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;

  const { JsonFileTaskStore } = await import("../src/store/jsonFileTaskStore.js");
  const { ArtifactStore } = await import("../src/artifacts/artifactStore.js");
  const { TaskEventBus } = await import("../src/events/eventBus.js");
  const recovery = await import("../src/startup/recoverOrphanedTasks.js");

  taskStore = new JsonFileTaskStore(dataDir);
  artifactStore = new ArtifactStore();
  events = new TaskEventBus(artifactStore);
  recoverOrphanedTasks = recovery.recoverOrphanedTasks;
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
});

async function seedTask(id: string, status: TaskStatus, currentStage: string): Promise<Task> {
  const now = new Date().toISOString();
  const task: Task = {
    id,
    title: "Add a GET /health endpoint",
    requirement: "Add a GET /health endpoint.",
    repository: "/tmp/does-not-matter",
    status,
    detectedStack: null,
    selectedAgents: ["node-backend"],
    currentStage,
    executionMode: "mock",
    reviewRetryCount: 0,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
  };
  await taskStore.create(task);
  await artifactStore.ensureWorkspace(id);
  await artifactStore.writeTask(task);
  return task;
}

describe("recoverOrphanedTasks — startup crash recovery sweep", () => {
  it("marks a mid-flight task failed, naming the stage it was stuck in, and appends TASK_FAILED", async () => {
    await seedTask("orphan-implementing", "implementing", "implementing");

    const recovered = await recoverOrphanedTasks(taskStore, artifactStore, events);
    expect(recovered).toBe(1);

    const after = await taskStore.get("orphan-implementing");
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/restarted while this task was in progress \(stage: implementing\)/i);
    expect(after?.error).toMatch(/retry/i);

    const eventLog = await artifactStore.readEvents("orphan-implementing");
    expect(eventLog.some((e) => e.type === "TASK_FAILED")).toBe(true);
  });

  it("does not touch a task already in a terminal status (regression guard against over-eager sweeping)", async () => {
    const terminalStatuses: TaskStatus[] = ["completed", "failed", "blocked", "cancelled"];
    for (const status of terminalStatuses) {
      await seedTask(`terminal-${status}`, status, status);
    }

    const recovered = await recoverOrphanedTasks(taskStore, artifactStore, events);
    expect(recovered).toBe(0);

    for (const status of terminalStatuses) {
      const task = await taskStore.get(`terminal-${status}`);
      expect(task?.status).toBe(status);
      expect(task?.error).toBeUndefined();
    }
  });

  it("does not touch a task resting in 'created' (never started, not orphaned)", async () => {
    await seedTask("resting-created", "created", "created");
    const recovered = await recoverOrphanedTasks(taskStore, artifactStore, events);
    expect(recovered).toBe(0);
    const task = await taskStore.get("resting-created");
    expect(task?.status).toBe("created");
  });

  it("recovers every in-flight stage, not just one", async () => {
    const stages: TaskStatus[] = ["inspecting", "routing", "analyzing", "reconciling", "planning", "reviewing"];
    for (const stage of stages) {
      await seedTask(`orphan-${stage}`, stage, stage);
    }

    const recovered = await recoverOrphanedTasks(taskStore, artifactStore, events);
    expect(recovered).toBe(stages.length);

    for (const stage of stages) {
      const task = await taskStore.get(`orphan-${stage}`);
      expect(task?.status).toBe("failed");
      expect(task?.error).toContain(`stage: ${stage}`);
    }
  });
});
