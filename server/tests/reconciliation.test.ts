import { describe, expect, it } from "vitest";
import { reconcile } from "../src/orchestrator/reconciliation.js";
import type { SpecialistReport } from "../src/types/index.js";
import type { RoutingResult } from "../src/orchestrator/routingEngine.js";

function makeReport(overrides: Partial<SpecialistReport>): SpecialistReport {
  return {
    agent: "python-backend",
    taskId: "task-1",
    status: "completed",
    recommendation: "Do the thing.",
    findings: [{ summary: "finding", evidence: "evidence" }],
    risks: [],
    assumptions: [],
    confidence: 0.9,
    executionMode: "mock",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const baseRouting: RoutingResult = { agents: ["python-backend"], rationale: [], scenario: "Python-only API", needsEscalation: false };

describe("reconcile", () => {
  it("marks reconciliation AGREED when specialists complete with no escalation", () => {
    const result = reconcile("task-1", [makeReport({})], baseRouting);
    expect(result.status).toBe("AGREED");
    expect(result.decisions).toHaveLength(1);
  });

  it("marks reconciliation NEEDS_USER_DECISION when routing flagged escalation", () => {
    const routing: RoutingResult = { ...baseRouting, needsEscalation: true, rationale: ["cross-stack migration detected"] };
    const result = reconcile("task-1", [makeReport({})], routing);
    expect(result.status).toBe("NEEDS_USER_DECISION");
  });

  it("marks reconciliation UNKNOWN when a specialist analysis failed", () => {
    const result = reconcile("task-1", [makeReport({ status: "failed", confidence: 0 })], baseRouting);
    expect(result.status).toBe("UNKNOWN");
  });

  it("never fabricates certainty when there are no specialist reports", () => {
    const result = reconcile("task-1", [], baseRouting);
    expect(result.status).toBe("UNKNOWN");
    expect(result.confidencePercent).toBe(0);
  });
});
