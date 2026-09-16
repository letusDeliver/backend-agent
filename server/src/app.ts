import path from "node:path";
import { existsSync } from "node:fs";
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { healthRouter } from "./routes/health.js";
import { tasksRouter } from "./routes/tasks.js";
import { specialistsRouter } from "./routes/specialists.js";
import { statsRouter } from "./routes/stats.js";
import { memoryRouter } from "./routes/memory.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.use("/api", healthRouter);
  app.use("/api", tasksRouter);
  app.use("/api", specialistsRouter);
  app.use("/api", statsRouter);
  app.use("/api", memoryRouter);

  // Containerized/production deployment only: serves the built Angular
  // app from this same process when it's actually present alongside the
  // server (see config.webDistPath) — local dev never has this directory
  // (the web workspace runs under its own `ng serve` instead), so this is
  // a no-op there and in every test. Registered after the /api routers but
  // before notFoundHandler, so an unmatched /api/* request still correctly
  // 404s as JSON — only non-API routes fall through to the SPA.
  //
  // config.webDistPath is deliberately read exactly once, into this local
  // constant, rather than re-read inside the request handler below.
  // config.webDistPath is a live getter (re-reads process.env on every
  // access, by design — see config.ts), and express.static() itself
  // already captures whatever path it's given at setup time, not
  // per-request — evaluating the getter again inside the handler would
  // silently disagree with express.static()'s fixed root the moment
  // anything ever changed WEB_DIST_PATH after startup (never expected to
  // happen in a real deployment, but worth being consistent regardless).
  const webDistPath = config.webDistPath;
  if (existsSync(webDistPath)) {
    app.use(express.static(webDistPath));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDistPath, "index.html"));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
