import { describe, expect, it } from "vitest";
import { routeTask } from "../src/orchestrator/routingEngine.js";
import type { DetectedStack, Task } from "../src/types/index.js";

function makeTask(overrides: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    title: "Task",
    requirement: "",
    repository: "/tmp/repo",
    status: "created",
    detectedStack: null,
    selectedAgents: [],
    currentStage: "created",
    executionMode: "mock",
    reviewRetryCount: 0,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeStack(overrides: Partial<DetectedStack>): DetectedStack {
  return {
    language: "unknown",
    packageManager: null,
    framework: null,
    database: null,
    testCommand: null,
    lintCommand: null,
    typecheckCommand: null,
    evidence: [],
    ...overrides,
  };
}

describe("routeTask — Phase 24 cross-stack routing benchmark matrix", () => {
  it("routes a Python-only API task to the Python specialist alone", () => {
    const task = makeTask({ requirement: "Add a GET endpoint that lists the current user's profile." });
    const stack = makeStack({ language: "python", framework: "FastAPI" });
    const result = routeTask(task, stack);
    expect(result.agents).toEqual(["python-backend"]);
    expect(result.needsEscalation).toBe(false);
  });

  it("routes a Node-only API task to the Node specialist alone", () => {
    const task = makeTask({ requirement: "Add a POST endpoint that creates a comment." });
    const stack = makeStack({ language: "node", framework: "Express" });
    const result = routeTask(task, stack);
    expect(result.agents).toEqual(["node-backend"]);
    expect(result.needsEscalation).toBe(false);
  });

  it("routes Python + PostgreSQL to Python and Database in parallel", () => {
    const task = makeTask({ requirement: "Add an order creation API with PostgreSQL persistence and a transaction." });
    const stack = makeStack({ language: "python", framework: "FastAPI", database: "PostgreSQL" });
    const result = routeTask(task, stack);
    expect(result.agents.sort()).toEqual(["database", "python-backend"].sort());
    expect(result.needsEscalation).toBe(false);
  });

  it("routes Node + MongoDB to Node and Database in parallel", () => {
    const task = makeTask({ requirement: "Add an endpoint backed by MongoDB with a new schema field." });
    const stack = makeStack({ language: "node", framework: "Express", database: "MongoDB" });
    const result = routeTask(task, stack);
    expect(result.agents.sort()).toEqual(["database", "node-backend"].sort());
  });

  it("routes a cross-stack migration to Python + Node + Database and flags escalation", () => {
    const task = makeTask({ requirement: "Migrate this Python FastAPI service to Node.js and update the PostgreSQL schema." });
    const stack = makeStack({ language: "python", framework: "FastAPI", database: "PostgreSQL" });
    const result = routeTask(task, stack);
    expect(result.agents).toContain("python-backend");
    expect(result.agents).toContain("node-backend");
    expect(result.agents).toContain("database");
    expect(result.needsEscalation).toBe(true);
  });

  it("routes a database-only task to the Database Agent alone", () => {
    const task = makeTask({ requirement: "Add a composite index and optimize the query plan for the orders table schema." });
    const stack = makeStack({ language: "unknown" });
    const result = routeTask(task, stack);
    expect(result.agents).toEqual(["database"]);
    expect(result.needsEscalation).toBe(false);
  });

  it("does not invoke the Database Agent for an incidental dependency with no material persistence concern", () => {
    const task = makeTask({ requirement: "Add input validation to the existing signup endpoint." });
    const stack = makeStack({ language: "node", framework: "Express", database: "PostgreSQL" });
    const result = routeTask(task, stack);
    expect(result.agents).toEqual(["node-backend"]);
  });

  it("escalates instead of guessing when the stack is ambiguous and the requirement names no technology", () => {
    const task = makeTask({ requirement: "Add support for exporting reports." });
    const stack = makeStack({ language: "unknown" });
    const result = routeTask(task, stack);
    expect(result.agents).toEqual([]);
    expect(result.needsEscalation).toBe(true);
  });
});
