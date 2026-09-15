import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFileMemoryStore } from "../src/memory/jsonFileMemoryStore.js";
import type { MemoryItem } from "../src/memory/types.js";

let dir: string;
let store: JsonFileMemoryStore;

function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    type: "validated_lesson",
    scope: "/repo/a",
    content: "Use connection pooling for PostgreSQL transactions.",
    technology: ["postgresql"],
    taskType: "database",
    validationStatus: "validated",
    provenance: { taskId: "t1" },
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "memory-"));
  store = new JsonFileMemoryStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("JsonFileMemoryStore.retrieve", () => {
  it("returns technology-relevant validated memory", async () => {
    await store.add(item({ id: "pg", technology: ["postgresql"], content: "Pool PostgreSQL connections." }));
    await store.add(item({ id: "mongo", technology: ["mongodb"], content: "Use MongoDB transactions carefully." }));

    const matches = await store.retrieve({ text: "add pagination", scope: "/repo/a", technology: ["postgresql"] });

    expect(matches.map((m) => m.item.id)).toContain("pg");
    expect(matches.map((m) => m.item.id)).not.toContain("mongo");
  });

  it("excludes irrelevant memory (no technology or keyword overlap, different scope)", async () => {
    await store.add(item({ id: "unrelated", scope: "/repo/other", technology: ["ruby"], content: "Rails routing conventions." }));

    const matches = await store.retrieve({ text: "add pagination", scope: "/repo/a", technology: ["postgresql"] });

    expect(matches.map((m) => m.item.id)).not.toContain("unrelated");
  });

  it("includes global-scope items alongside project-scope items", async () => {
    await store.add(item({ id: "global-item", scope: "global", technology: ["postgresql"], content: "General PostgreSQL indexing advice." }));

    const matches = await store.retrieve({ text: "indexing", scope: "/repo/a", technology: ["postgresql"] });

    expect(matches.map((m) => m.item.id)).toContain("global-item");
  });

  it("never returns a candidate or rejected item, even if it would score highest", async () => {
    await store.add(
      item({ id: "candidate", validationStatus: "candidate", technology: ["postgresql"], content: "Pool PostgreSQL connections aggressively." })
    );
    await store.add(item({ id: "rejected", validationStatus: "rejected", technology: ["postgresql"] }));
    await store.add(item({ id: "validated", validationStatus: "validated", technology: ["postgresql"] }));

    const matches = await store.retrieve({ text: "pool connections", scope: "/repo/a", technology: ["postgresql"] });

    expect(matches.map((m) => m.item.id)).toEqual(["validated"]);
  });

  it("scores project scope above global scope, all else equal", async () => {
    await store.add(item({ id: "project", scope: "/repo/a", technology: ["postgresql"], confidence: 0.9 }));
    await store.add(item({ id: "global", scope: "global", technology: ["postgresql"], confidence: 0.9 }));

    const matches = await store.retrieve({ text: "", scope: "/repo/a", technology: ["postgresql"] });

    expect(matches[0].item.id).toBe("project");
  });
});

describe("JsonFileMemoryStore CRUD", () => {
  it("update() merges a patch and bumps updatedAt", async () => {
    const created = await store.add(item({ id: "x", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" }));
    const updated = await store.update("x", { content: "Revised guidance." });

    expect(updated.content).toBe("Revised guidance.");
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
  });

  it("list() filters by validationStatus", async () => {
    await store.add(item({ id: "a", validationStatus: "candidate" }));
    await store.add(item({ id: "b", validationStatus: "validated" }));

    const candidates = await store.list({ validationStatus: "candidate" });
    expect(candidates.map((i) => i.id)).toEqual(["a"]);
  });
});
