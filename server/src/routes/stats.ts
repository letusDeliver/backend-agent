import { Router } from "express";
import { taskStore } from "../container.js";

export const statsRouter = Router();

const ACTIVE_STATUSES = new Set(["created", "inspecting", "routing", "analyzing", "reconciling", "planning", "implementing", "reviewing"]);

statsRouter.get("/stats", async (_req, res, next) => {
  try {
    const tasks = await taskStore.list();
    const active = tasks.filter((t) => ACTIVE_STATUSES.has(t.status)).length;
    const completed = tasks.filter((t) => t.status === "completed").length;
    const failed = tasks.filter((t) => t.status === "failed").length;
    const blocked = tasks.filter((t) => t.status === "blocked").length;
    res.json({ active, completed, failed, blocked, total: tasks.length });
  } catch (err) {
    next(err);
  }
});
