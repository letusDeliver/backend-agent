import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

describe("Requirement docs — end to end pipeline integration (Phase 38)", () => {
  let app: Express;
  let dataDir: string;
  let tasksDir: string;
  let repoDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "reqdocs-e2e-data-"));
    tasksDir = await mkdtemp(path.join(tmpdir(), "reqdocs-e2e-tasks-"));
    repoDir = await mkdtemp(path.join(tmpdir(), "reqdocs-e2e-repo-"));

    // Deliberately bare: no package.json/pyproject.toml, so routing has no
    // stack signal from repository inspection at all — the only signal
    // comes from the requirement doc, proving this reaches routing for
    // real, not just in the unit-level routingEngine test.
    await mkdir(path.join(repoDir, "docs"), { recursive: true });
    await writeFile(
      path.join(repoDir, "docs", "requirements.md"),
      "Build this backend with FastAPI and a PostgreSQL schema for orders."
    );

    process.env.DATA_DIR = dataDir;
    process.env.TASKS_DIR = tasksDir;
    process.env.CLAUDE_EXECUTION_MODE = "mock";

    const { createApp } = await import("../src/app.js");
    app = createApp();
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(tasksDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  async function waitForTerminal(taskId: string, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    let task;
    while (Date.now() < deadline) {
      const res = await request(app).get(`/api/tasks/${taskId}`);
      task = res.body.task;
      if (["completed", "blocked", "failed", "cancelled"].includes(task.status)) return task;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return task;
  }

  it("reads the referenced doc at inspection time and routes from its content, not just the requirement field", async () => {
    const createRes = await request(app).post("/api/tasks").send({
      title: "Add order support",
      requirement: "Add support for orders.",
      repository: repoDir,
      requirementDocPaths: ["docs/requirements.md", "docs/missing.md"],
    });
    expect(createRes.status).toBe(201);
    const taskId = createRes.body.task.id;

    await request(app).post(`/api/tasks/${taskId}/start`);
    const task = await waitForTerminal(taskId);

    expect(task.requirementDocs).toHaveLength(2);
    const found = task.requirementDocs.find((d: any) => d.path === "docs/requirements.md");
    const missing = task.requirementDocs.find((d: any) => d.path === "docs/missing.md");
    expect(found.readError).toBeUndefined();
    expect(found.content).toContain("FastAPI");
    expect(missing.readError).toBeTruthy();

    // No package.json in the repo — without the doc's content, routing
    // would have escalated (agents: []). Instead it resolved Python +
    // Database from the doc alone.
    expect(task.selectedAgents.sort()).toEqual(["database", "python-backend"].sort());
    expect(task.status).not.toBe("blocked");

    const { eventBus } = await import("../src/container.js");
    const history = await eventBus.history(taskId);
    const docsEvent = history.find((e) => e.type === "REQUIREMENT_DOCS_READ");
    expect(docsEvent).toBeTruthy();
    expect(docsEvent!.message).toMatch(/Read 1 of 2/);
  });
});
