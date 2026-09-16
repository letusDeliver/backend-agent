import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

/**
 * Containerized/production deployment serves the built Angular app from
 * this same Express process (see config.webDistPath, app.ts) — never
 * present in local dev, where the web workspace runs under its own
 * `ng serve` instead. This suite is what actually exercises that path,
 * since no other test ever sets WEB_DIST_PATH.
 */
describe("Static frontend serving (containerized deployment)", () => {
  let webDistDir: string;
  let dataDir: string;
  let tasksDir: string;
  let appWithStatic: Express;
  let appWithoutStatic: Express;

  beforeAll(async () => {
    webDistDir = await mkdtemp(path.join(tmpdir(), "web-dist-"));
    dataDir = await mkdtemp(path.join(tmpdir(), "static-data-"));
    tasksDir = await mkdtemp(path.join(tmpdir(), "static-tasks-"));
    await writeFile(path.join(webDistDir, "index.html"), "<!doctype html><title>Backend Agent</title>");
    await writeFile(path.join(webDistDir, "styles.css"), "body { margin: 0; }");

    process.env.DATA_DIR = dataDir;
    process.env.TASKS_DIR = tasksDir;

    const { createApp } = await import("../src/app.js");

    // config.webDistPath is a live getter (re-reads process.env on every
    // access, not cached at import time — the same Phase 39 fix that made
    // DATA_DIR/TASKS_DIR overrides reliable), so calling createApp() twice
    // with a different env value in between correctly produces two apps
    // with different static-serving behavior from one import.
    process.env.WEB_DIST_PATH = webDistDir;
    appWithStatic = createApp();

    delete process.env.WEB_DIST_PATH;
    appWithoutStatic = createApp();
  });

  afterAll(async () => {
    await rm(webDistDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
    await rm(tasksDir, { recursive: true, force: true });
    delete process.env.WEB_DIST_PATH;
  });

  it("serves the real index.html at / when WEB_DIST_PATH exists", async () => {
    const res = await request(appWithStatic).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Backend Agent");
  });

  it("serves a static asset directly by path", async () => {
    const res = await request(appWithStatic).get("/styles.css");
    expect(res.status).toBe(200);
    expect(res.text).toContain("margin: 0");
  });

  it("falls back to index.html for a client-side route (Angular routing), not a 404", async () => {
    const res = await request(appWithStatic).get("/tasks/some-task-id");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Backend Agent");
  });

  it("still 404s as JSON for an unmatched /api/* route, never serving the SPA there", async () => {
    const res = await request(appWithStatic).get("/api/this-route-does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: "Not found" } });
  });

  it("real API routes still work normally alongside static serving", async () => {
    const res = await request(appWithStatic).get("/api/tasks");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tasks");
  });

  it("mounts nothing and behaves exactly as before when WEB_DIST_PATH is absent (local dev/test, the default)", async () => {
    const res = await request(appWithoutStatic).get("/");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: "Not found" } });
  });
});
