import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactStore } from "../src/artifacts/artifactStore.js";
import type { TaskEventBus } from "../src/events/eventBus.js";

let tasksDir: string;
let artifactStore: ArtifactStore;
let eventBus: TaskEventBus;

beforeAll(async () => {
  tasksDir = await mkdtemp(path.join(tmpdir(), "events-"));
  process.env.TASKS_DIR = tasksDir;
  const artifactsModule = await import("../src/artifacts/artifactStore.js");
  const eventBusModule = await import("../src/events/eventBus.js");
  artifactStore = new artifactsModule.ArtifactStore();
  eventBus = new eventBusModule.TaskEventBus(artifactStore);
});

afterAll(async () => {
  await rm(tasksDir, { recursive: true, force: true });
});

describe("TaskEventBus", () => {
  it("notifies live subscribers and persists events for later reconstruction", async () => {
    const taskId = "task-events-1";
    const received: string[] = [];
    const unsubscribe = eventBus.subscribe(taskId, (event) => received.push(event.type));

    await eventBus.publish(taskId, "TASK_CREATED", "created");
    await eventBus.publish(taskId, "REPOSITORY_INSPECTION_STARTED", "inspecting");

    expect(received).toEqual(["TASK_CREATED", "REPOSITORY_INSPECTION_STARTED"]);
    unsubscribe();

    const history = await eventBus.history(taskId);
    expect(history.map((e) => e.type)).toEqual(["TASK_CREATED", "REPOSITORY_INSPECTION_STARTED"]);
  });

  it("reconstructs history for a subscriber that connects late", async () => {
    const taskId = "task-events-2";
    await eventBus.publish(taskId, "TASK_CREATED", "created");
    await eventBus.publish(taskId, "TASK_COMPLETED", "done");

    const history = await eventBus.history(taskId);
    expect(history).toHaveLength(2);
    expect(history[0].type).toBe("TASK_CREATED");
    expect(history[1].type).toBe("TASK_COMPLETED");
  });
});
