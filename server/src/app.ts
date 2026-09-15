import express from "express";
import cors from "cors";
import { healthRouter } from "./routes/health.js";
import { tasksRouter } from "./routes/tasks.js";
import { specialistsRouter } from "./routes/specialists.js";
import { statsRouter } from "./routes/stats.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.use("/api", healthRouter);
  app.use("/api", tasksRouter);
  app.use("/api", specialistsRouter);
  app.use("/api", statsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
