import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

let app: Express;
let dataDir: string;
let tasksDir: string;
let repoDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "repo-"));

  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ dependencies: { express: "^4.0.0" }, scripts: { test: "echo ok" } })
  );

  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;

  const { createApp } = await import("../src/app.js");
  app = createApp();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

describe("GET /api/health", () => {
  it("reports ok status and the active execution mode", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.executionMode).toBe("mock");
  });
});

describe("POST /api/tasks — validation", () => {
  it("rejects a task with no requirement", async () => {
    const res = await request(app).post("/api/tasks").send({ repository: repoDir });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/requirement/);
  });

  it("rejects a task with a repository path that does not exist", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ requirement: "Add an endpoint.", repository: "/does/not/exist/anywhere" });
    expect(res.status).toBe(400);
  });
});

describe("Task lifecycle", () => {
  let taskId: string;

  it("creates a task via POST /api/tasks", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "Add health route", requirement: "Add a GET /health endpoint.", repository: repoDir });
    expect(res.status).toBe(201);
    expect(res.body.task.status).toBe("created");
    taskId = res.body.task.id;
  });

  it("lists the created task via GET /api/tasks", async () => {
    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(200);
    expect(res.body.tasks.some((t: { id: string }) => t.id === taskId)).toBe(true);
  });

  it("returns 404 for an unknown task id", async () => {
    const res = await request(app).get("/api/tasks/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("starts the task and runs it to completion", async () => {
    const startRes = await request(app).post(`/api/tasks/${taskId}/start`);
    expect(startRes.status).toBe(202);

    let status = "";
    for (let i = 0; i < 50; i += 1) {
      const res = await request(app).get(`/api/tasks/${taskId}`);
      status = res.body.task.status;
      if (status === "completed" || status === "blocked" || status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(status).toBe("completed");
  });

  it("rejects starting a task that is no longer in the created state", async () => {
    const res = await request(app).post(`/api/tasks/${taskId}/start`);
    expect(res.status).toBe(409);
  });

  it("exposes the specialist agent reports", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.selectedAgents).toEqual(["node-backend"]);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].executionMode).toBe("mock");
  });

  it("exposes the reconciliation artifact", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body.reconciliation.status).toBe("AGREED");
  });

  it("exposes the final handoff with a markdown rendering", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/handoff`);
    expect(res.status).toBe(200);
    expect(res.body.handoff.status).toBe("completed");
    expect(res.body.markdown).toMatch(/MOCK \/ SIMULATED EXECUTION/);
  });
});

describe("GET /api/stats", () => {
  it("reflects the completed task", async () => {
    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.body.completed).toBeGreaterThanOrEqual(1);
  });
});
