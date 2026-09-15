import { Router } from "express";
import { config } from "../config.js";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    executionMode: config.executionMode,
    time: new Date().toISOString(),
  });
});
