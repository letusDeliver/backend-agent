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
  dataDir = await mkdtemp(path.join(tmpdir(), "e2e-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "e2e-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "e2e-repo-"));

  // A representative Python + FastAPI + PostgreSQL repository, matching the
  // scenario in orchestrator/../examples/command-flow.md and Project Memory
  // §184 ("Standard Python + PostgreSQL Route").
  await writeFile(path.join(repoDir, "requirements.txt"), "fastapi\nsqlalchemy\npsycopg2-binary\npytest\n");

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

/**
 * End-to-end happy path (master build instructions §23):
 * Create Python + PostgreSQL task -> route Python + Database -> generate
 * specialist artifacts -> reconcile -> implementation stage -> review ->
 * complete.
 */
describe("End-to-end: Python + PostgreSQL task", () => {
  let taskId: string;

  it("creates the task", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({
        title: "Add order creation API",
        requirement: "Add an order creation API with PostgreSQL persistence. Validate the request, use a transaction and add tests.",
        repository: repoDir,
      });
    expect(res.status).toBe(201);
    taskId = res.body.task.id;
  });

  it("routes to the Python and Database specialists", async () => {
    await request(app).post(`/api/tasks/${taskId}/start`);

    let task: { status: string; selectedAgents: string[]; detectedStack: { framework: string | null } };
    for (let i = 0; i < 50; i += 1) {
      const res = await request(app).get(`/api/tasks/${taskId}`);
      task = res.body.task;
      if (task.status === "completed" || task.status === "blocked" || task.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(task!.detectedStack.framework).toBe("FastAPI");
    expect(task!.selectedAgents.sort()).toEqual(["database", "python-backend"]);
    expect(task!.status).toBe("completed");
  });

  it("generated a specialist report for each routed agent", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/agents`);
    expect(res.body.reports).toHaveLength(2);
    for (const report of res.body.reports) {
      expect(report.status).toBe("completed");
      expect(report.findings.length).toBeGreaterThan(0);
    }
  });

  it("reconciled the specialist recommendations", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/reconciliation`);
    expect(res.body.reconciliation.status).toBe("AGREED");
    expect(res.body.reconciliation.decisions.length).toBe(2);
  });

  it("produced an implementation plan and execution report", async () => {
    const planRes = await request(app).get(`/api/tasks/${taskId}/implementation-plan`);
    expect(planRes.body.plan.files.length).toBeGreaterThan(0);

    const execRes = await request(app).get(`/api/tasks/${taskId}/execution-report`);
    expect(execRes.body.report.status).toBe("completed");
    expect(execRes.body.report.executionMode).toBe("mock");
  });

  it("reviewed the implementation with no blocking findings", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/reviews`);
    expect(res.body.reviews).toHaveLength(2);
    for (const review of res.body.reviews) {
      expect(review.status).toBe("PASS");
    }
  });

  it("produced a final handoff", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/handoff`);
    expect(res.body.handoff.status).toBe("completed");
    expect(res.body.handoff.agentsUsed.sort()).toEqual(["database", "python-backend"]);
    expect(res.body.markdown).toContain("Final Handoff");
  });
});
