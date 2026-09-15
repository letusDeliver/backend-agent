import { describe, expect, it } from "vitest";
import { containsSensitiveContent, generateCandidateLessons } from "../src/memory/candidateLessons.js";
import type { ArchitectureDecision, DetectedStack, Reconciliation, Task } from "../src/types/index.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Add pagination",
    requirement: "Add pagination to the reports endpoint.",
    repository: "/repo/a",
    status: "completed",
    detectedStack: null,
    selectedAgents: ["database"],
    currentStage: "completed",
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

function decision(overrides: Partial<ArchitectureDecision> = {}): ArchitectureDecision {
  return {
    decision: "Use keyset (cursor) pagination.",
    alternatives: ["Offset pagination"],
    evidence: "Existing endpoints already use cursor pagination in src/routes/orders.js.",
    rationale: "Keyset pagination avoids page-drift under concurrent writes.",
    confidence: 0.85,
    owner: "database",
    ...overrides,
  };
}

function reconciliation(decisions: ArchitectureDecision[]): Reconciliation {
  return { taskId: "t1", status: "AGREED", decisions, risks: [], conflicts: [], confidencePercent: 85, createdAt: "now" };
}

describe("generateCandidateLessons", () => {
  it("generates a candidate lesson per high-confidence decision, with provenance", () => {
    const lessons = generateCandidateLessons(makeTask(), reconciliation([decision()]), stack());

    expect(lessons).toHaveLength(1);
    expect(lessons[0].validationStatus).toBe("candidate");
    expect(lessons[0].type).toBe("candidate_lesson");
    expect(lessons[0].provenance).toEqual({
      taskId: "t1",
      agent: "database",
      artifact: "reconciliation.json",
      decision: "Use keyset (cursor) pagination.",
    });
    expect(lessons[0].content).toContain("keyset");
    expect(lessons[0].technology).toEqual(["node", "express", "postgresql"]);
  });

  it("skips decisions below the confidence threshold", () => {
    const lessons = generateCandidateLessons(makeTask(), reconciliation([decision({ confidence: 0.3 })]), stack());
    expect(lessons).toEqual([]);
  });

  it("returns no lessons when there is no reconciliation", () => {
    expect(generateCandidateLessons(makeTask(), null, stack())).toEqual([]);
  });

  it("filters out a decision whose text contains what looks like a secret", () => {
    const lessons = generateCandidateLessons(
      makeTask(),
      reconciliation([decision({ rationale: "Connect using password=hunter2secret in the pool config." })]),
      stack()
    );
    expect(lessons).toEqual([]);
  });
});

describe("containsSensitiveContent", () => {
  it("detects an AWS access key id", () => {
    expect(containsSensitiveContent("key: AKIAABCDEFGHIJKLMNOP")).toBe(true);
  });

  it("detects a private key header", () => {
    expect(containsSensitiveContent("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });

  it("detects a password/token/secret assignment", () => {
    expect(containsSensitiveContent("api_key: sk_live_abcdef123456")).toBe(true);
  });

  it("does not flag ordinary engineering text", () => {
    expect(containsSensitiveContent("Use keyset pagination for large result sets.")).toBe(false);
  });
});
