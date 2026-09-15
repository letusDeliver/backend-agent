import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { JsonFileMemoryStore } from "../src/memory/jsonFileMemoryStore.js";
import type { MemoryItem } from "../src/memory/types.js";

let app: Express;
let memoryStore: JsonFileMemoryStore;
let dataDir: string;
let tasksDir: string;

function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    type: "candidate_lesson",
    scope: "/repo/a",
    content: "Use keyset pagination for large result sets.",
    technology: ["postgresql"],
    taskType: "database",
    validationStatus: "candidate",
    provenance: { taskId: "t1", agent: "database", artifact: "reconciliation.json", decision: "Use keyset pagination." },
    confidence: 0.85,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "memapi-data-"));
  tasksDir = await mkdtemp(path.join(tmpdir(), "memapi-tasks-"));
  process.env.DATA_DIR = dataDir;
  process.env.TASKS_DIR = tasksDir;

  const { createApp } = await import("../src/app.js");
  const container = await import("../src/container.js");
  app = createApp();
  memoryStore = container.memoryStore as JsonFileMemoryStore;
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
});

describe("Memory API", () => {
  it("GET /api/memory/candidates lists only candidates", async () => {
    await memoryStore.add(item({ id: "cand-1" }));
    await memoryStore.add(item({ id: "validated-1", type: "validated_lesson", validationStatus: "validated" }));

    const res = await request(app).get("/api/memory/candidates");
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: MemoryItem) => i.id)).toEqual(["cand-1"]);
  });

  it("POST /api/memory/:id/approve turns a candidate into validated memory with approval provenance", async () => {
    await memoryStore.add(item({ id: "to-approve" }));

    const res = await request(app).post("/api/memory/to-approve/approve").send({ approvedBy: "kunal" });

    expect(res.status).toBe(200);
    expect(res.body.item.validationStatus).toBe("validated");
    expect(res.body.item.type).toBe("validated_lesson");
    expect(res.body.item.provenance.approvedBy).toBe("kunal");
    expect(res.body.item.provenance.approvedAt).toBeTruthy();
    // Original provenance (task/agent/decision) must survive approval.
    expect(res.body.item.provenance.taskId).toBe("t1");
  });

  it("approving an already-validated item is rejected with 409", async () => {
    await memoryStore.add(item({ id: "already", validationStatus: "validated", type: "validated_lesson" }));
    const res = await request(app).post("/api/memory/already/approve").send({});
    expect(res.status).toBe(409);
  });

  it("POST /api/memory/:id/reject marks rejected but does not delete it", async () => {
    await memoryStore.add(item({ id: "to-reject" }));

    const res = await request(app).post("/api/memory/to-reject/reject").send({});
    expect(res.status).toBe(200);
    expect(res.body.item.validationStatus).toBe("rejected");

    const stillThere = await request(app).get("/api/memory/to-reject");
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.item.validationStatus).toBe("rejected");
  });

  it("a rejected item is never retrieved for context building", async () => {
    await memoryStore.add(item({ id: "rejected-item", content: "Rejected pagination advice." }));
    await request(app).post("/api/memory/rejected-item/reject").send({});

    const matches = await memoryStore.retrieve({ text: "pagination", scope: "/repo/a", technology: ["postgresql"] });
    expect(matches.map((m) => m.item.id)).not.toContain("rejected-item");
  });

  it("PATCH /api/memory/:id edits content and marks humanEdited", async () => {
    await memoryStore.add(item({ id: "to-edit" }));

    const res = await request(app).patch("/api/memory/to-edit").send({ content: "Use cursor pagination, revised by a human." });

    expect(res.status).toBe(200);
    expect(res.body.item.content).toBe("Use cursor pagination, revised by a human.");
    expect(res.body.item.provenance.humanEdited).toBe(true);
  });

  it("GET /api/memory/:id 404s for an unknown id", async () => {
    const res = await request(app).get("/api/memory/does-not-exist");
    expect(res.status).toBe(404);
  });
});
