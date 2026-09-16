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
  dataDir = await mkdtemp(path.join(tmpdir(), "memloop-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "memloop-tasks-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "memloop-repo-"));

  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ dependencies: { express: "^4.0.0", pg: "^8.0.0" }, scripts: { test: "echo ok" } })
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

async function runTaskToCompletion(requirement: string): Promise<string> {
  const create = await request(app).post("/api/tasks").send({ requirement, repository: repoDir });
  expect(create.status).toBe(201);
  const taskId: string = create.body.task.id;

  await request(app).post(`/api/tasks/${taskId}/start`);

  // 50 x 100ms, matching e2e.test.ts/api.test.ts's budget — this test's
  // previous 50 x 50ms budget was flaky under the CPU contention of a full
  // parallel `vitest run` (harmless when run alone).
  let status = "created";
  for (let i = 0; i < 50; i += 1) {
    const res = await request(app).get(`/api/tasks/${taskId}`);
    status = res.body.task.status;
    if (["completed", "blocked", "failed"].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(status).toBe("completed");
  return taskId;
}

/**
 * The most important test in this phase (Phase 29 brief section 23): proves
 * the memory loop actually closes, not just that each piece compiles in
 * isolation.
 *
 *   Task A -> completes -> candidate lesson generated -> human approves it
 *   via the API -> Task B (same repository/stack) -> memory retrieval ->
 *   context pack -> the approved lesson is provably handed to the
 *   specialist that analyzes Task B (asserted against the specialist
 *   report's own content, not merely "no error was thrown").
 */
describe("Memory loop: candidate lesson -> human approval -> retrieval on a later task", () => {
  it("closes the loop end to end", async () => {
    const requirement = "Add pagination to the GET /reports endpoint using PostgreSQL cursor-based queries with a new index on created_at.";

    const taskAId = await runTaskToCompletion(requirement);

    const candidatesRes = await request(app).get("/api/memory/candidates");
    const candidatesFromTaskA = candidatesRes.body.items.filter((i: { provenance: { taskId?: string } }) => i.provenance.taskId === taskAId);
    expect(candidatesFromTaskA.length).toBeGreaterThan(0);

    const databaseCandidate = candidatesFromTaskA.find((i: { taskType?: string }) => i.taskType === "database") ?? candidatesFromTaskA[0];
    expect(databaseCandidate.validationStatus).toBe("candidate");

    const approveRes = await request(app)
      .post(`/api/memory/${databaseCandidate.id}/approve`)
      .send({ approvedBy: "test-developer" });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.item.validationStatus).toBe("validated");
    const approvedContent: string = approveRes.body.item.content;

    const taskBId = await runTaskToCompletion(requirement);

    const memoryRes = await request(app).get(`/api/tasks/${taskBId}/memory`);
    expect(memoryRes.status).toBe(200);
    expect(memoryRes.body.contextPack).not.toBeNull();
    expect(memoryRes.body.contextPack.includedCount).toBeGreaterThan(0);
    expect(memoryRes.body.contextPack.entries.some((e: { memoryId: string }) => e.memoryId === databaseCandidate.id)).toBe(true);

    const agentsRes = await request(app).get(`/api/tasks/${taskBId}/agents`);
    const databaseReport = agentsRes.body.reports.find((r: { agent: string }) => r.agent === "database");
    expect(databaseReport).toBeTruthy();
    const assumptionsText = databaseReport.assumptions.join(" ");
    expect(assumptionsText).toMatch(/Incorporated \d+ relevant validated memory item/);
    expect(assumptionsText).toContain(approvedContent.slice(0, 40));
  });

  it("a rejected candidate never reaches a later task's context pack", async () => {
    const requirement = "Add pagination to the GET /orders endpoint using PostgreSQL cursor-based queries with a new index on updated_at.";

    const taskAId = await runTaskToCompletion(requirement);
    const candidatesRes = await request(app).get("/api/memory/candidates");
    const fromTaskA = candidatesRes.body.items.filter((i: { provenance: { taskId?: string } }) => i.provenance.taskId === taskAId);
    expect(fromTaskA.length).toBeGreaterThan(0);

    for (const candidate of fromTaskA) {
      await request(app).post(`/api/memory/${candidate.id}/reject`).send({});
    }

    const taskBId = await runTaskToCompletion(requirement);
    const memoryRes = await request(app).get(`/api/tasks/${taskBId}/memory`);
    const includedIds = memoryRes.body.contextPack.entries.map((e: { memoryId: string }) => e.memoryId);
    for (const candidate of fromTaskA) {
      expect(includedIds).not.toContain(candidate.id);
    }
  });
});
