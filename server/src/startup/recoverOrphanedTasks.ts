import type { TaskStore } from "../store/taskStore.js";
import type { ArtifactStore } from "../artifacts/artifactStore.js";
import type { TaskEventBus } from "../events/eventBus.js";
import type { Task } from "../types/index.js";

/**
 * Non-terminal statuses that only ever exist while an orchestrator process
 * is actively running a task. `created` is excluded — a task legitimately
 * rests there until a developer calls `/start`, so it is not orphaned.
 */
const IN_FLIGHT_STATUSES = new Set<Task["status"]>([
  "inspecting",
  "routing",
  "analyzing",
  "reconciling",
  "planning",
  "implementing",
  "reviewing",
]);

/**
 * Startup crash recovery (Phase 31 proposal §5, phase prompt §15-17). Must
 * run once, synchronously, before the HTTP server starts accepting
 * requests, so no `orchestrator.run()` call from this process can possibly
 * be in flight for a task this sweep is about to touch — a task found
 * in-flight here can only be one an earlier, now-dead process left behind.
 *
 * There is no work to resume (the process that was running it is gone), so
 * this only corrects the persisted status to `failed` — it never calls
 * into `TaskOrchestrator`. The developer can then `POST /tasks/:id/retry`.
 */
export async function recoverOrphanedTasks(taskStore: TaskStore, artifacts: ArtifactStore, events: TaskEventBus): Promise<number> {
  const tasks = await taskStore.list();
  let recovered = 0;

  for (const task of tasks) {
    if (!IN_FLIGHT_STATUSES.has(task.status)) continue;

    const stage = task.currentStage;
    task.status = "failed";
    task.error = `Orchestrator restarted while this task was in progress (stage: ${stage}). Retry to restart from repository inspection.`;
    task.updatedAt = new Date().toISOString();

    await taskStore.update(task);
    await artifacts.writeTask(task);
    await events.publish(task.id, "TASK_FAILED", task.error);
    recovered += 1;
  }

  return recovered;
}
