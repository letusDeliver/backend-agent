import { describe, expect, it } from "vitest";
import { extractDecision, groupBySubject, sameSubject, materialityOf, classifyDecisionText } from "../src/orchestrator/decisionExtraction.js";
import type { SpecialistReport } from "../src/types/index.js";

function report(overrides: Partial<SpecialistReport>): SpecialistReport {
  return {
    agent: "python-backend",
    taskId: "task-1",
    status: "completed",
    recommendation: "Do the thing.",
    findings: [],
    risks: [],
    assumptions: [],
    confidence: 0.8,
    executionMode: "mock",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("extractDecision", () => {
  it("returns null for a non-completed report", () => {
    expect(extractDecision(report({ status: "failed" }), [])).toBeNull();
    expect(extractDecision(report({ status: "not_required" as SpecialistReport["status"] }), [])).toBeNull();
  });

  it("classifies category from recommendation + findings text", () => {
    const decision = extractDecision(
      report({
        recommendation: "Add a database index for the new query pattern.",
        findings: [{ summary: "Query planner shows a sequential scan.", evidence: "EXPLAIN ANALYZE output on the orders query." }],
      }),
      []
    );
    expect(decision?.category).toBe("database");
  });

  it("falls back to the architecture category when nothing more specific matches", () => {
    const decision = extractDecision(report({ recommendation: "Refactor the module for clarity." }), []);
    expect(decision?.category).toBe("architecture");
  });

  it("records memory influence from the agent's context-pack entries", () => {
    const withMemory = extractDecision(report({}), [
      { memoryId: "m1", type: "validated_lesson", validationStatus: "validated", scope: "global", confidence: 0.9, technology: [], summary: "s", reason: "r", score: 1 },
    ]);
    expect(withMemory?.memoryInfluenced).toBe(true);
    expect(withMemory?.memoryIds).toEqual(["m1"]);

    const withoutMemory = extractDecision(report({}), []);
    expect(withoutMemory?.memoryInfluenced).toBe(false);
  });
});

describe("classifyDecisionText — category classification", () => {
  const cases: Array<[string, string]> = [
    ["Wrap this in a PostgreSQL transaction.", "transaction"],
    ["Require JWT authentication on this route.", "authentication"],
    ["Add a role-based authorization check.", "authorization"],
    ["Add a migration to extend the schema.", "data-model"],
    ["Add an index to the orders table for this query.", "database"],
    ["Expose a new REST API endpoint.", "api"],
    ["Add input validation for the request body.", "validation"],
    ["Improve exception handling for the retry path.", "error-handling"],
    ["Add caching to reduce latency.", "performance"],
    ["Add unit test coverage for this path.", "testing"],
    ["Introduce a new third-party dependency.", "dependency"],
    ["Move this value into an environment variable.", "configuration"],
    ["Update the CI/CD rollout for this service.", "deployment"],
  ];

  it.each(cases)("classifies %j as %s", (text, expected) => {
    expect(classifyDecisionText(text).category).toBe(expected);
  });

  it("treats 'asynchronous transaction boundary' as a concurrency (architecture) signal, not transaction", () => {
    expect(classifyDecisionText("This depends on an asynchronous transaction boundary.").category).toBe("architecture");
  });
});

describe("classifyDecisionText — polarity / negation precision", () => {
  it("detects negation immediately governing the category keyword", () => {
    expect(classifyDecisionText("Do not use a transaction for this write.").polarity).toBe("negative");
    expect(classifyDecisionText("Avoid a transaction here.").polarity).toBe("negative");
  });

  it("does not misfire on negation words governing an unrelated noun in the same sentence", () => {
    // "never" governs "occur" (an outcome), not "transaction" (the mechanism).
    expect(classifyDecisionText("Wrap this in a transaction so partial writes never occur.").polarity).toBe("affirmative");
    // "avoid" governs "malformed rows", not "schema"/"validation".
    expect(classifyDecisionText("Validate against the schema to avoid malformed rows.").polarity).toBe("affirmative");
  });

  it("recognizes the two antonym pairs named explicitly in the phase brief", () => {
    expect(classifyDecisionText("This must remain eventually consistent, no transaction.").polarity).toBe("negative");
    expect(classifyDecisionText("Introduce asynchronous processing here.").polarity).toBe("negative");
    expect(classifyDecisionText("Introduce synchronous processing here.").polarity).toBe("affirmative");
  });
});

describe("sameSubject / groupBySubject", () => {
  it("narrow categories group by category alone", () => {
    const a = extractDecision(report({ agent: "node-backend", recommendation: "Use a transaction for the ledger write." }), [])!;
    const b = extractDecision(report({ agent: "database", recommendation: "Use a transaction for order creation." }), [])!;
    expect(sameSubject(a, b)).toBe(true);
  });

  it("broad categories require shared significant terms", () => {
    const a = extractDecision(report({ agent: "node-backend", recommendation: "Improve error handling for outbound webhook retries." }), [])!;
    const b = extractDecision(report({ agent: "database", recommendation: "Improve error handling for connection pool exhaustion during migrations." }), [])!;
    expect(sameSubject(a, b)).toBe(false);
  });

  it("groups three decisions into one group when all share a subject, isolating a fourth unrelated one", () => {
    const a = extractDecision(report({ agent: "python-backend", recommendation: "Use a transaction for the ledger update." }), [])!;
    const b = extractDecision(report({ agent: "node-backend", recommendation: "Use a transaction for the ledger update." }), [])!;
    const c = extractDecision(report({ agent: "database", recommendation: "Avoid a transaction for the ledger update; stay eventually consistent." }), [])!;
    const d = extractDecision(report({ agent: "node-backend", recommendation: "Add a caching layer for the read path." }), [])!;
    const groups = groupBySubject([a, b, c, d]);
    expect(groups).toHaveLength(2);
    const transactionGroup = groups.find((g) => g.length === 3)!;
    expect(transactionGroup.map((d) => d.agent).sort()).toEqual(["database", "node-backend", "python-backend"]);
  });
});

describe("materialityOf", () => {
  it("classifies the documented material categories", () => {
    for (const category of ["architecture", "api", "database", "data-model", "transaction", "authentication", "authorization", "deployment"] as const) {
      expect(materialityOf(category)).toBe("material");
    }
  });

  it("classifies the documented non-material categories", () => {
    for (const category of ["validation", "error-handling", "performance", "testing", "dependency", "configuration"] as const) {
      expect(materialityOf(category)).toBe("non-material");
    }
  });
});
