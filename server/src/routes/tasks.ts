import { randomUUID } from "node:crypto";
import { Router } from "express";
import { artifactStore, eventBus, executor, orchestrator, taskStore } from "../container.js";
import { config } from "../config.js";
import { resolveRepositoryPath } from "../utils/paths.js";
import { ApiError } from "../middleware/errorHandler.js";
import { describeUnresolvedQuestion, hasUnresolvedMaterialConflict, recomputeStatus } from "../orchestrator/reconciliation.js";
import type { Task, TaskCreateInput } from "../types/index.js";

export const tasksRouter = Router();

function validateCreateInput(body: unknown): TaskCreateInput {
  if (typeof body !== "object" || body === null) {
    throw new ApiError(400, "Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const requirement = typeof b.requirement === "string" ? b.requirement.trim() : "";
  const repository = typeof b.repository === "string" ? b.repository.trim() : "";

  if (!requirement) throw new ApiError(400, "requirement is required.");
  if (!repository) throw new ApiError(400, "repository is required.");
  if (requirement.length > 8000) throw new ApiError(400, "requirement is too long (max 8000 characters).");

  return {
    title: title || requirement.slice(0, 60),
    requirement,
    repository,
    preferredTechnology: typeof b.preferredTechnology === "string" ? b.preferredTechnology.trim() || undefined : undefined,
    preferredDatabase: typeof b.preferredDatabase === "string" ? b.preferredDatabase.trim() || undefined : undefined,
    constraints: typeof b.constraints === "string" ? b.constraints.trim() || undefined : undefined,
  };
}

tasksRouter.post("/tasks", async (req, res, next) => {
  try {
    const input = validateCreateInput(req.body);
    const resolvedRepository = resolveRepositoryPath(input.repository);

    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      title: input.title,
      requirement: input.requirement,
      repository: resolvedRepository,
      preferredTechnology: input.preferredTechnology,
      preferredDatabase: input.preferredDatabase,
      constraints: input.constraints,
      status: "created",
      detectedStack: null,
      selectedAgents: [],
      currentStage: "created",
      executionMode: config.executionMode,
      reviewRetryCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    await artifactStore.ensureWorkspace(task.id);
    await taskStore.create(task);
    await artifactStore.writeTask(task);
    await eventBus.publish(task.id, "TASK_CREATED", `Task "${task.title}" created.`);

    res.status(201).json({ task });
  } catch (err) {
    next(err);
  }
});

tasksRouter.get("/tasks", async (_req, res, next) => {
  try {
    const tasks = await taskStore.list();
    res.json({ tasks });
  } catch (err) {
    next(err);
  }
});

tasksRouter.get("/tasks/:id", async (req, res, next) => {
  try {
    const task = await taskStore.get(req.params.id);
    if (!task) throw new ApiError(404, "Task not found.");
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

tasksRouter.post("/tasks/:id/start", async (req, res, next) => {
  try {
    const task = await taskStore.get(req.params.id);
    if (!task) throw new ApiError(404, "Task not found.");
    if (task.status !== "created") {
      throw new ApiError(409, `Task cannot be started from status "${task.status}".`);
    }
    // Orchestration runs asynchronously; errors are captured inside
    // TaskOrchestrator.run and surfaced as a TASK_FAILED event + status.
    void orchestrator.run(task.id);
    res.status(202).json({ task: { ...task, status: "inspecting" } });
  } catch (err) {
    next(err);
  }
});

const TERMINAL_STATUSES = new Set<Task["status"]>(["completed", "failed", "blocked", "cancelled"]);

tasksRouter.post("/tasks/:id/cancel", async (req, res, next) => {
  try {
    const task = await taskStore.get(req.params.id);
    if (!task) throw new ApiError(404, "Task not found.");
    if (TERMINAL_STATUSES.has(task.status)) {
      throw new ApiError(409, `Task cannot be cancelled from status "${task.status}".`);
    }

    task.status = "cancelled";
    task.currentStage = "cancelled";
    task.updatedAt = new Date().toISOString();
    await taskStore.update(task);
    await artifactStore.writeTask(task);

    // Best-effort: kill any in-flight Claude Code process for this task.
    // Orchestrator.run() also checks persisted status between phases so it
    // stops making further progress even if nothing was actively running.
    executor.cancel(task.id);

    await eventBus.publish(task.id, "TASK_CANCELLED", "Task cancelled by developer request.");
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

tasksRouter.get("/tasks/:id/events", async (req, res, next) => {
  try {
    const task = await taskStore.get(req.params.id);
    if (!task) throw new ApiError(404, "Task not found.");

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const history = await eventBus.history(task.id);
    for (const event of history) {
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }

    const unsubscribe = eventBus.subscribe(task.id, (event) => {
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  } catch (err) {
    next(err);
  }
});

tasksRouter.get("/tasks/:id/agents", async (req, res, next) => {
  try {
    const task = await taskStore.get(req.params.id);
    if (!task) throw new ApiError(404, "Task not found.");
    const reports = await artifactStore.readSpecialistReports(task.id, task.selectedAgents);
    res.json({ selectedAgents: task.selectedAgents, reports });
  } catch (err) {
    next(err);
  }
});

tasksRouter.get("/tasks/:id/reconciliation", async (req, res, next) => {
  try {
    const task = await taskStore.get(req.params.id);
    if (!task) throw new ApiError(404, "Task not found.");
    const reconciliation = await artifactStore.readReconciliation(task.id);
    res.json({ reconciliation });
  } catch (err) {
    next(err);
  }
});

tasksRouter.post("/tasks/:id/reconciliation/conflicts/:conflictId/resolve", async (req, res, next) => {
  try {
    const task = await taskStore.get(req.params.id);
    if (!task) throw new ApiError(404, "Task not found.");

    const reconciliation = await artifactStore.readReconciliation(task.id);
    if (!reconciliation) throw new ApiError(404, "Reconciliation not found for this task.");

    const conflict = reconciliation.conflicts.find((c) => c.id === req.params.conflictId);
    if (!conflict) throw new ApiError(404, "Conflict not found.");
    if (conflict.resolution) throw new ApiError(409, "Conflict is already resolved.");

    const body = req.body as Record<string, unknown>;
    const resolution = typeof body.resolution === "string" ? body.resolution.trim() : "";
    if (!resolution) throw new ApiError(400, "resolution is required.");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const resolvedBy = typeof body.resolvedBy === "string" && body.resolvedBy.trim() ? body.resolvedBy.trim() : "developer";

    // Computed before mutating the conflict — describeUnresolvedQuestion is a
    // pure function of the conflict's decision content, not its resolution
    // state, so this is the exact string to remove from unresolvedQuestions.
    const questionText = describeUnresolvedQuestion(conflict);

    conflict.resolution = { resolution, reason, resolvedBy, resolvedAt: new Date().toISOString() };
    reconciliation.unresolvedQuestions = reconciliation.unresolvedQuestions.filter((q) => q !== questionText);
    reconciliation.status = recomputeStatus(reconciliation);
    await artifactStore.writeReconciliation(reconciliation);

    let resumed = false;
    if (task.status === "blocked" && !hasUnresolvedMaterialConflict(reconciliation)) {
      resumed = true;
      void orchestrator.resumeAfterConflictResolution(task.id);
    }

    res.json({ reconciliation, resumed });
  } catch (err) {
    next(err);
  }
});

tasksRouter.get("/tasks/:id/implementation-plan", async (req, res, next) => {
  try {
    const task = await taskStore.get(req.params.id);
    if (!task) throw new ApiError(404, "Task not found.");
    const plan = await artifactStore.readImplementationPlan(task.id);
    res.json({ plan });
  } catch (err) {
    next(err);
  }
});

tasksRouter.get("/tasks/:id/execution-report", async (req, res, next) => {
  try {
    const task = await taskStore.get(req.params.id);
    if (!task) throw new ApiError(404, "Task not found.");
    const report = await artifactStore.readExecutionReport(task.id);
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

tasksRouter.get("/tasks/:id/reviews", async (req, res, next) => {
  try {
    const task = await taskStore.get(req.params.id);
    if (!task) throw new ApiError(404, "Task not found.");
    const reviews = await artifactStore.readLatestReviews(task.id, task.selectedAgents);
    res.json({ reviews });
  } catch (err) {
    next(err);
  }
});

tasksRouter.get("/tasks/:id/memory", async (req, res, next) => {
  try {
    const task = await taskStore.get(req.params.id);
    if (!task) throw new ApiError(404, "Task not found.");
    const contextPack = await artifactStore.readMemoryRetrieval(task.id);
    res.json({ contextPack });
  } catch (err) {
    next(err);
  }
});

tasksRouter.get("/tasks/:id/handoff", async (req, res, next) => {
  try {
    const task = await taskStore.get(req.params.id);
    if (!task) throw new ApiError(404, "Task not found.");
    const handoff = await artifactStore.readFinalHandoff(task.id);
    const markdown = await artifactStore.readFinalHandoffMarkdown(task.id);
    res.json({ handoff, markdown });
  } catch (err) {
    next(err);
  }
});
