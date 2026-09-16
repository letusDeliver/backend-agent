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
  dataDir = await mkdtemp(path.join(tmpdir(), "reconapi-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "reconapi-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "reconapi-repo-"));

  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ dependencies: { express: "^4.0.0" }, scripts: { test: "echo ok" } }));

  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;

  const { createApp } = await import("../src/app.js");
  const { artifactStore, taskStore } = await import("../src/container.js");
  app = createApp();

  // Runs through the real (mock-executor) pipeline to get a legitimate,
  // fully-populated task + reconciliation.json on disk, then injects a
  // synthetic unresolved material conflict — the resolve endpoint's own
  // request-validation behavior is what's under test here, independent of
  // conflict *detection* (covered by reconciliation.test.ts) or the
  // orchestrator's resume mechanics (covered by reconciliationConflict.e2e.test.ts).
  const createRes = await request(app).post("/api/tasks").send({
    title: "Seed task",
    requirement: "Add an order endpoint.",
    repository: repoDir,
  });
  taskId = createRes.body.task.id;
  await request(app).post(`/api/tasks/${taskId}/start`);
  for (let i = 0; i < 50; i += 1) {
    const res = await request(app).get(`/api/tasks/${taskId}`);
    if (["completed", "blocked", "failed"].includes(res.body.task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const reconciliation = await artifactStore.readReconciliation(taskId);
  if (!reconciliation) throw new Error("Expected a reconciliation artifact for the seed task.");
  reconciliation.conflicts.push({
    id: "synthetic-conflict-1",
    kind: "specialist-disagreement",
    category: "transaction",
    subject: "transaction",
    detectedAt: "reconciliation",
    participants: [
      { agent: "node-backend", decision: "Use a transaction.", rationale: "r", evidence: "e", confidence: 0.9, polarity: "affirmative", memoryInfluenced: false, memoryIds: [] },
      { agent: "database", decision: "Do not use a transaction.", rationale: "r", evidence: "e", confidence: 0.9, polarity: "negative", memoryInfluenced: false, memoryIds: [] },
    ],
    materiality: "material",
    reason: "synthetic test conflict",
    resolution: null,
    createdAt: new Date().toISOString(),
  });
  reconciliation.status = "CONFLICT";
  await artifactStore.writeReconciliation(reconciliation);

  const task = await taskStore.get(taskId);
  if (task) {
    task.status = "blocked";
    task.error = "Reconciliation found 1 unresolved material engineering conflict(s).";
    task.updatedAt = new Date().toISOString();
    await taskStore.update(task);
  }
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

let taskId: string;

describe("POST /tasks/:id/reconciliation/conflicts/:conflictId/resolve — validation", () => {
  it("404s for an unknown task", async () => {
    const res = await request(app).post("/api/tasks/does-not-exist/reconciliation/conflicts/synthetic-conflict-1/resolve").send({ resolution: "x" });
    expect(res.status).toBe(404);
  });

  it("404s for an unknown conflict id", async () => {
    const res = await request(app).post(`/api/tasks/${taskId}/reconciliation/conflicts/not-a-real-conflict/resolve`).send({ resolution: "x" });
    expect(res.status).toBe(404);
  });

  it("400s when resolution is missing or empty", async () => {
    const res = await request(app).post(`/api/tasks/${taskId}/reconciliation/conflicts/synthetic-conflict-1/resolve`).send({});
    expect(res.status).toBe(400);
    const res2 = await request(app).post(`/api/tasks/${taskId}/reconciliation/conflicts/synthetic-conflict-1/resolve`).send({ resolution: "   " });
    expect(res2.status).toBe(400);
  });

  it("resolves an unresolved material conflict, flips status to AGREED, and resumes the blocked task", async () => {
    const res = await request(app)
      .post(`/api/tasks/${taskId}/reconciliation/conflicts/synthetic-conflict-1/resolve`)
      .send({ resolution: "Use the transaction.", reason: "Confirmed with the team.", resolvedBy: "qa-test" });
    expect(res.status).toBe(200);
    expect(res.body.reconciliation.conflicts[0].resolution.resolution).toBe("Use the transaction.");
    expect(res.body.reconciliation.conflicts[0].resolution.resolvedBy).toBe("qa-test");
    expect(res.body.reconciliation.status).toBe("AGREED");
    expect(res.body.resumed).toBe(true);

    let finalStatus = "";
    for (let i = 0; i < 50; i += 1) {
      const taskRes = await request(app).get(`/api/tasks/${taskId}`);
      finalStatus = taskRes.body.task.status;
      if (finalStatus === "completed" || finalStatus === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(finalStatus).toBe("completed");
  });

  it("409s when resolving an already-resolved conflict", async () => {
    const res = await request(app)
      .post(`/api/tasks/${taskId}/reconciliation/conflicts/synthetic-conflict-1/resolve`)
      .send({ resolution: "Trying again." });
    expect(res.status).toBe(409);
  });
});
