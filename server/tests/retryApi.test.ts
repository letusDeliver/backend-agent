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
  dataDir = await mkdtemp(path.join(tmpdir(), "retryapi-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "retryapi-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "retryapi-repo-"));

  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ dependencies: { express: "^4.0.0" }, scripts: { test: "echo ok" } }));

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

async function waitForStatus(taskId: string, statuses: string[], timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/api/tasks/${taskId}`);
    if (statuses.includes(res.body.task.status)) return res.body.task.status;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for status in [${statuses.join(", ")}]`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("POST /tasks/:id/retry", () => {
  it("404s for an unknown task", async () => {
    const res = await request(app).post("/api/tasks/does-not-exist/retry");
    expect(res.status).toBe(404);
  });

  it("409s for a freshly created task (not yet started)", async () => {
    const createRes = await request(app).post("/api/tasks").send({
      title: "Add a GET /health endpoint",
      requirement: "Add a GET /health endpoint.",
      repository: repoDir,
    });
    const taskId = createRes.body.task.id;
    const res = await request(app).post(`/api/tasks/${taskId}/retry`);
    expect(res.status).toBe(409);
  });

  it("202s and increments attempt for a blocked task, and its attempt-1 artifacts become readable via /attempts", async () => {
    const createRes = await request(app).post("/api/tasks").send({
      title: "Add a GET /health endpoint",
      requirement: "Add a GET /health endpoint.",
      repository: repoDir,
    });
    const taskId = createRes.body.task.id;
    await request(app).post(`/api/tasks/${taskId}/start`);
    await waitForStatus(taskId, ["completed", "failed", "blocked"]);

    // Force a deterministic "blocked" outcome regardless of what the mock
    // executor's heuristics actually produced for this requirement — the
    // same synthetic-state technique reconciliationApi.test.ts uses, since
    // this test is about the retry endpoint's own behavior, not about
    // engineering a genuine block through the pipeline (covered by
    // taskRetry.test.ts's fixture executor).
    const { taskStore } = await import("../src/container.js");
    const task = await taskStore.get(taskId);
    if (!task) throw new Error("expected seed task to exist");
    task.status = "blocked";
    task.error = "Forced blocked for API test determinism.";
    task.updatedAt = new Date().toISOString();
    await taskStore.update(task);

    const retryRes = await request(app).post(`/api/tasks/${taskId}/retry`);
    expect(retryRes.status).toBe(202);
    expect(retryRes.body.task.attempt).toBe(2);
    expect(retryRes.body.task.status).toBe("created");

    const attemptsRes = await request(app).get(`/api/tasks/${taskId}/attempts`);
    expect(attemptsRes.status).toBe(200);
    expect(attemptsRes.body.attempts).toEqual([1]);
    // Phase 34: additive per-attempt outcome summary, driven purely by
    // which artifact files exist for the attempt (never a guessed status —
    // see ArtifactStore.describeArchivedAttempt). This requirement
    // ("Add a GET /health endpoint.") reaches real completion in mock mode
    // before this test forces the live task to "blocked" above, so the
    // archived attempt genuinely has a final-handoff.json.
    expect(attemptsRes.body.attemptSummaries).toEqual([{ attempt: 1, reachedStage: "completed" }]);

    const reconciliationRes = await request(app).get(`/api/tasks/${taskId}/attempts/1/reconciliation`);
    expect(reconciliationRes.status).toBe(200);
    expect(reconciliationRes.body.reconciliation).not.toBeNull();

    const agentsRes = await request(app).get(`/api/tasks/${taskId}/attempts/1/agents`);
    expect(agentsRes.status).toBe(200);
    expect(agentsRes.body.reports.length).toBeGreaterThan(0);

    const invalidAttemptRes = await request(app).get(`/api/tasks/${taskId}/attempts/not-a-number/reconciliation`);
    expect(invalidAttemptRes.status).toBe(400);

    const missingTaskAttemptsRes = await request(app).get(`/api/tasks/does-not-exist/attempts/1/reconciliation`);
    expect(missingTaskAttemptsRes.status).toBe(404);

    await waitForStatus(taskId, ["completed", "failed", "blocked"]);
  });
});
