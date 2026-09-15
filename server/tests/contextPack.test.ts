import { describe, expect, it } from "vitest";
import { buildContextPack, memoryForAgent } from "../src/memory/contextPack.js";
import { JsonFileMemoryStore } from "../src/memory/jsonFileMemoryStore.js";
import type { DetectedStack, Task } from "../src/types/index.js";
import type { MemoryItem } from "../src/memory/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Add pagination",
    requirement: "Add pagination to the reports endpoint.",
    repository: "/repo/a",
    status: "routing",
    detectedStack: null,
    selectedAgents: ["node-backend", "database"],
    currentStage: "routing",
    executionMode: "mock",
    reviewRetryCount: 0,
    createdAt: "now",
    updatedAt: "now",
    ...overrides,
  };
}

function stack(overrides: Partial<DetectedStack> = {}): DetectedStack {
  return {
    language: "node",
    packageManager: "npm",
    framework: "express",
    database: "postgresql",
    testCommand: null,
    lintCommand: null,
    typecheckCommand: null,
    evidence: [],
    ...overrides,
  };
}

function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    type: "validated_lesson",
    scope: "/repo/a",
    content: "Use cursor-based pagination for large PostgreSQL result sets.",
    technology: ["postgresql"],
    taskType: "database",
    validationStatus: "validated",
    provenance: { taskId: "prior-task" },
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

let dir: string;

async function makeStore() {
  dir = await mkdtemp(path.join(tmpdir(), "context-pack-"));
  return new JsonFileMemoryStore(dir);
}

describe("buildContextPack", () => {
  it("includes relevant memory and records retrieved/included/excluded counts", async () => {
    const store = await makeStore();
    await store.add(item({ id: "relevant" }));
    const task = makeTask();

    const pack = await buildContextPack(task, stack(), store);

    expect(pack.entries.map((e) => e.memoryId)).toContain("relevant");
    expect(pack.includedCount).toBe(1);
    expect(pack.retrievedCount).toBe(1);
    expect(pack.excludedCount).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("flags a conflict when memory names a different database than repository evidence", async () => {
    const store = await makeStore();
    await store.add(item({ id: "mongo-lesson", technology: ["mongodb"], content: "Use MongoDB transactions for pagination." }));
    const task = makeTask();

    const pack = await buildContextPack(task, stack({ database: "postgresql" }), store);

    expect(pack.conflicts.length).toBeGreaterThan(0);
    expect(pack.conflicts[0]).toMatch(/mongodb/i);
    expect(pack.conflicts[0]).toMatch(/repository evidence takes precedence/i);
    await rm(dir, { recursive: true, force: true });
  });

  it("does not flag a conflict when memory agrees with repository evidence", async () => {
    const store = await makeStore();
    await store.add(item({ id: "pg-lesson", technology: ["postgresql"] }));
    const task = makeTask();

    const pack = await buildContextPack(task, stack({ database: "postgresql" }), store);

    expect(pack.conflicts).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("memoryForAgent", () => {
  it("routes a database-tagged lesson to the database agent but not node-backend", async () => {
    const pack = {
      taskId: "t1",
      query: { text: "", technology: [], scope: "/repo/a" },
      retrievedCount: 1,
      includedCount: 1,
      excludedCount: 0,
      entries: [
        {
          memoryId: "pg",
          type: "validated_lesson" as const,
          validationStatus: "validated" as const,
          scope: "/repo/a",
          confidence: 0.9,
          technology: ["postgresql"],
          summary: "Pool connections.",
          reason: "technology:postgresql",
          score: 3,
        },
      ],
      excludedIds: [],
      conflicts: [],
      createdAt: "now",
    };

    expect(memoryForAgent("database", pack).map((e) => e.memoryId)).toEqual(["pg"]);
    expect(memoryForAgent("node-backend", pack)).toEqual([]);
  });

  it("routes a tag-less general lesson to every agent", () => {
    const pack = {
      taskId: "t1",
      query: { text: "", technology: [], scope: "/repo/a" },
      retrievedCount: 1,
      includedCount: 1,
      excludedCount: 0,
      entries: [
        {
          memoryId: "general",
          type: "validated_lesson" as const,
          validationStatus: "validated" as const,
          scope: "/repo/a",
          confidence: 0.9,
          technology: [],
          summary: "Always add input validation at the API boundary.",
          reason: "relevance score",
          score: 1,
        },
      ],
      excludedIds: [],
      conflicts: [],
      createdAt: "now",
    };

    expect(memoryForAgent("database", pack).map((e) => e.memoryId)).toEqual(["general"]);
    expect(memoryForAgent("node-backend", pack).map((e) => e.memoryId)).toEqual(["general"]);
  });
});
