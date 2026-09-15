import { Router } from "express";
import { memoryStore } from "../container.js";
import { ApiError } from "../middleware/errorHandler.js";
import type { MemoryListFilter, MemoryType, MemoryValidationStatus } from "../memory/types.js";

export const memoryRouter = Router();

const VALID_TYPES = new Set<MemoryType>(["task_history", "project_memory", "global_knowledge", "candidate_lesson", "validated_lesson"]);
const VALID_STATUSES = new Set<MemoryValidationStatus>(["validated", "candidate", "rejected", "historical"]);

function parseListFilter(query: Record<string, unknown>): MemoryListFilter {
  const filter: MemoryListFilter = {};
  if (typeof query.type === "string") {
    if (!VALID_TYPES.has(query.type as MemoryType)) throw new ApiError(400, `Invalid type "${query.type}".`);
    filter.type = query.type as MemoryType;
  }
  if (typeof query.validationStatus === "string") {
    if (!VALID_STATUSES.has(query.validationStatus as MemoryValidationStatus)) {
      throw new ApiError(400, `Invalid validationStatus "${query.validationStatus}".`);
    }
    filter.validationStatus = query.validationStatus as MemoryValidationStatus;
  }
  if (typeof query.scope === "string") filter.scope = query.scope;
  return filter;
}

// Registered before "/memory/:id" so "candidates" is never captured as an id.
memoryRouter.get("/memory/candidates", async (_req, res, next) => {
  try {
    const items = await memoryStore.list({ validationStatus: "candidate" });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

memoryRouter.get("/memory", async (req, res, next) => {
  try {
    const filter = parseListFilter(req.query as Record<string, unknown>);
    const items = await memoryStore.list(filter);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

memoryRouter.get("/memory/:id", async (req, res, next) => {
  try {
    const item = await memoryStore.get(req.params.id);
    if (!item) throw new ApiError(404, "Memory item not found.");
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

memoryRouter.post("/memory/:id/approve", async (req, res, next) => {
  try {
    const existing = await memoryStore.get(req.params.id);
    if (!existing) throw new ApiError(404, "Memory item not found.");
    if (existing.validationStatus === "validated") {
      throw new ApiError(409, "Memory item is already validated.");
    }
    const approvedBy = typeof req.body?.approvedBy === "string" && req.body.approvedBy.trim() ? req.body.approvedBy.trim() : "developer";
    const item = await memoryStore.update(req.params.id, {
      type: "validated_lesson",
      validationStatus: "validated",
      provenance: { ...existing.provenance, approvedAt: new Date().toISOString(), approvedBy },
    });
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

memoryRouter.post("/memory/:id/reject", async (req, res, next) => {
  try {
    const existing = await memoryStore.get(req.params.id);
    if (!existing) throw new ApiError(404, "Memory item not found.");
    if (existing.validationStatus === "rejected") {
      throw new ApiError(409, "Memory item is already rejected.");
    }
    const item = await memoryStore.update(req.params.id, {
      validationStatus: "rejected",
      provenance: { ...existing.provenance, rejectedAt: new Date().toISOString() },
    });
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

memoryRouter.patch("/memory/:id", async (req, res, next) => {
  try {
    const existing = await memoryStore.get(req.params.id);
    if (!existing) throw new ApiError(404, "Memory item not found.");

    const body = req.body as Record<string, unknown>;
    const patch: Parameters<typeof memoryStore.update>[1] = {};
    if (typeof body.content === "string" && body.content.trim()) patch.content = body.content.trim();
    if (Array.isArray(body.technology) && body.technology.every((t) => typeof t === "string")) {
      patch.technology = body.technology as string[];
    }
    if (typeof body.taskType === "string") patch.taskType = body.taskType;
    if (Object.keys(patch).length === 0) throw new ApiError(400, "No editable fields provided.");

    patch.provenance = { ...existing.provenance, humanEdited: true };
    const item = await memoryStore.update(req.params.id, patch);
    res.json({ item });
  } catch (err) {
    next(err);
  }
});
