import { describe, expect, it } from "vitest";
import { reconcile, hasUnresolvedMaterialConflict, recomputeStatus } from "../src/orchestrator/reconciliation.js";
import type { DetectedStack, SpecialistReport } from "../src/types/index.js";
import type { RoutingResult } from "../src/orchestrator/routingEngine.js";
import type { ContextPack } from "../src/memory/contextPack.js";

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
const noStack: DetectedStack | null = null;

describe("reconcile — status precedence (unchanged behavior)", () => {
  it("marks reconciliation AGREED when specialists complete with no escalation", () => {
    const result = reconcile("task-1", [makeReport({})], baseRouting, noStack, null);
    expect(result.status).toBe("AGREED");
    expect(result.decisions).toHaveLength(1);
  });

  it("marks reconciliation NEEDS_USER_DECISION when routing flagged escalation", () => {
    const routing: RoutingResult = { ...baseRouting, needsEscalation: true, rationale: ["cross-stack migration detected"] };
    const result = reconcile("task-1", [makeReport({})], routing, noStack, null);
    expect(result.status).toBe("NEEDS_USER_DECISION");
  });

  it("marks reconciliation UNKNOWN when a specialist analysis failed", () => {
    const result = reconcile("task-1", [makeReport({ status: "failed", confidence: 0 })], baseRouting, noStack, null);
    expect(result.status).toBe("UNKNOWN");
  });

  it("never fabricates certainty when there are no specialist reports", () => {
    const result = reconcile("task-1", [], baseRouting, noStack, null);
    expect(result.status).toBe("UNKNOWN");
    expect(result.confidencePercent).toBe(0);
  });
});

const twoAgentRouting: RoutingResult = { agents: ["node-backend", "database"], rationale: [], scenario: "node + database", needsEscalation: false };

describe("reconcile — agreement", () => {
  it("AGREED when two agents make the same-category recommendation with the same polarity", () => {
    const reports = [
      makeReport({
        agent: "node-backend",
        recommendation: "Use a PostgreSQL transaction for order creation.",
        findings: [{ summary: "Order creation touches two tables.", evidence: "src/routes/orders.ts" }],
      }),
      makeReport({
        agent: "database",
        recommendation: "Use a transaction for order creation to keep both writes atomic.",
        findings: [{ summary: "Order creation writes to orders and inventory.", evidence: "schema.sql" }],
      }),
    ];
    const result = reconcile("task-1", reports, twoAgentRouting, noStack, null);
    expect(result.status).toBe("AGREED");
    expect(result.conflicts).toHaveLength(0);
    expect(result.agreements.length).toBeGreaterThan(0);
    expect(result.agreements[0]).toMatch(/transaction/);
  });

  it("AGREED when the same subject is recommended with different wording/rationale (false-positive guard)", () => {
    const reports = [
      makeReport({
        agent: "node-backend",
        recommendation: "Wrap order creation in a database transaction so partial writes never occur.",
        findings: [{ summary: "Two related tables are written together.", evidence: "src/routes/orders.ts" }],
      }),
      makeReport({
        agent: "database",
        recommendation: "Order creation should be transactional to guarantee atomicity across the writes.",
        findings: [{ summary: "Referential integrity depends on both rows existing together.", evidence: "schema.sql" }],
      }),
    ];
    const result = reconcile("task-1", reports, twoAgentRouting, noStack, null);
    expect(result.status).toBe("AGREED");
    expect(result.conflicts).toHaveLength(0);
  });
});

describe("reconcile — explicit disagreement", () => {
  it("CONFLICT when one agent affirms and another negates the same transaction decision", () => {
    const reports = [
      makeReport({
        agent: "node-backend",
        recommendation: "Use a PostgreSQL transaction for order creation.",
        findings: [{ summary: "Order creation writes must be atomic.", evidence: "src/routes/orders.ts" }],
      }),
      makeReport({
        agent: "database",
        recommendation: "Do not use a transaction here; this operation must remain eventually consistent across services.",
        findings: [{ summary: "Order creation spans two services via an outbox pattern.", evidence: "schema.sql" }],
      }),
    ];
    const result = reconcile("task-1", reports, twoAgentRouting, noStack, null);
    expect(result.status).toBe("CONFLICT");
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict.kind).toBe("specialist-disagreement");
    expect(conflict.category).toBe("transaction");
    expect(conflict.materiality).toBe("material");
    expect(conflict.participants.map((p) => p.agent).sort()).toEqual(["database", "node-backend"]);
    expect(conflict.participants.find((p) => p.agent === "node-backend")!.polarity).toBe("affirmative");
    expect(conflict.participants.find((p) => p.agent === "database")!.polarity).toBe("negative");
    expect(conflict.resolution).toBeNull();
    expect(result.unresolvedQuestions.some((q) => q.includes("transaction"))).toBe(true);
  });

  it("CONFLICT for synchronous vs asynchronous processing recommendations", () => {
    const routing: RoutingResult = { agents: ["python-backend", "node-backend"], rationale: [], scenario: "cross-stack", needsEscalation: false };
    const reports = [
      makeReport({
        agent: "python-backend",
        recommendation: "Introduce synchronous processing for the report export job.",
        findings: [{ summary: "Report export must return the file inline.", evidence: "app/reports.py" }],
      }),
      makeReport({
        agent: "node-backend",
        recommendation: "This requires asynchronous processing; the report export job depends on an asynchronous transaction boundary.",
        findings: [{ summary: "Report export triggers a downstream queue.", evidence: "src/services/reports.ts" }],
      }),
    ];
    const result = reconcile("task-1", reports, routing, noStack, null);
    expect(result.status).toBe("CONFLICT");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].category).toBe("architecture");
  });
});

describe("reconcile — different subjects never produce a false conflict", () => {
  it("does not compare decisions from different categories", () => {
    const reports = [
      makeReport({
        agent: "node-backend",
        recommendation: "Use JWT-based authentication for the new endpoint.",
        findings: [{ summary: "No auth middleware currently guards this route.", evidence: "src/middleware/auth.ts" }],
      }),
      makeReport({
        agent: "database",
        recommendation: "Add a caching layer in front of the read-heavy query to improve latency.",
        findings: [{ summary: "The query scans a large table on every request.", evidence: "schema.sql" }],
      }),
    ];
    const result = reconcile("task-1", reports, twoAgentRouting, noStack, null);
    expect(result.status).toBe("AGREED");
    expect(result.conflicts).toHaveLength(0);
  });

  it("does not force-match same-category decisions with no shared subject terms (broad category)", () => {
    const reports = [
      makeReport({
        agent: "node-backend",
        recommendation: "Improve error handling around outbound webhook delivery retries.",
        findings: [{ summary: "Webhook failures are currently swallowed silently.", evidence: "src/services/webhooks.ts" }],
      }),
      makeReport({
        agent: "database",
        recommendation: "Improve error handling for connection pool exhaustion during migrations.",
        findings: [{ summary: "Migrations can hang indefinitely under load.", evidence: "migrations/runner.ts" }],
      }),
    ];
    const result = reconcile("task-1", reports, twoAgentRouting, noStack, null);
    expect(result.conflicts).toHaveLength(0);
  });
});

describe("reconcile — repository evidence conflicts", () => {
  const mongoStack: DetectedStack = {
    language: "node",
    packageManager: "npm",
    framework: "Express",
    database: "MongoDB",
    testCommand: "npm test",
    lintCommand: null,
    typecheckCommand: null,
    evidence: ["Dependency indicates MongoDB (mongodb/mongoose)."],
  };

  it("records an evidence-contradiction conflict without rewriting the recommendation", () => {
    const reports = [
      makeReport({
        agent: "node-backend",
        recommendation: "Persist the new order using a PostgreSQL transaction.",
        findings: [{ summary: "Order writes must be atomic.", evidence: "src/routes/orders.ts" }],
      }),
    ];
    const result = reconcile("task-1", reports, baseRouting, mongoStack, null);
    expect(result.status).toBe("CONFLICT");
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict.kind).toBe("evidence-contradiction");
    expect(conflict.materiality).toBe("material");
    expect(conflict.repositoryEvidence).toMatch(/MongoDB/);
    expect(conflict.participants[0].decision).toBe("Persist the new order using a PostgreSQL transaction.");
    expect(result.decisions[0].decision).toBe("Persist the new order using a PostgreSQL transaction.");
  });

  it("no evidence conflict when the recommendation matches the detected database (alias-aware)", () => {
    const postgresStack: DetectedStack = { ...mongoStack, database: "PostgreSQL" };
    const reports = [
      makeReport({
        agent: "node-backend",
        recommendation: "Use a Postgres transaction for order creation.",
        findings: [{ summary: "Order writes must be atomic.", evidence: "src/routes/orders.ts" }],
      }),
    ];
    const result = reconcile("task-1", reports, baseRouting, postgresStack, null);
    expect(result.conflicts).toHaveLength(0);
  });
});

describe("reconcile — memory influence is recorded but does not by itself change precedence", () => {
  function pack(entries: ContextPack["entries"]): ContextPack {
    return { taskId: "task-1", query: { text: "", technology: [], scope: "global" }, retrievedCount: entries.length, includedCount: entries.length, excludedCount: 0, entries, excludedIds: [], conflicts: [], createdAt: new Date().toISOString() };
  }

  it("flags which side of a conflict was memory-influenced", () => {
    const memoryPack = pack([
      {
        memoryId: "mem-1",
        type: "validated_lesson",
        validationStatus: "validated",
        scope: "global",
        confidence: 0.8,
        technology: ["node"],
        summary: "Prior task used a transaction for similar writes.",
        reason: "keyword overlap",
        score: 0.5,
      },
    ]);
    const reports = [
      makeReport({
        agent: "node-backend",
        recommendation: "Use a PostgreSQL transaction for order creation.",
        findings: [{ summary: "Order creation writes must be atomic.", evidence: "src/routes/orders.ts" }],
      }),
      makeReport({
        agent: "database",
        recommendation: "Do not use a transaction here; fresh repository evidence shows this must stay eventually consistent.",
        findings: [{ summary: "Order creation now spans two services via an outbox pattern.", evidence: "schema.sql" }],
      }),
    ];
    const result = reconcile("task-1", reports, twoAgentRouting, noStack, memoryPack);
    expect(result.status).toBe("CONFLICT");
    const nodeParticipant = result.conflicts[0].participants.find((p) => p.agent === "node-backend")!;
    expect(nodeParticipant.memoryInfluenced).toBe(true);
    expect(nodeParticipant.memoryIds).toEqual(["mem-1"]);
    const dbParticipant = result.conflicts[0].participants.find((p) => p.agent === "database")!;
    expect(dbParticipant.memoryInfluenced).toBe(false);
  });
});

describe("reconcile — three-agent case", () => {
  it("conflict involves the dissenting third agent, majority pair still shown as agreement participants", () => {
    const routing: RoutingResult = { agents: ["python-backend", "node-backend", "database"], rationale: [], scenario: "cross-stack", needsEscalation: false };
    const reports = [
      makeReport({
        agent: "python-backend",
        recommendation: "Use a transaction for the ledger update.",
        findings: [{ summary: "Ledger rows must stay consistent.", evidence: "app/ledger.py" }],
      }),
      makeReport({
        agent: "node-backend",
        recommendation: "Use a transaction for the ledger update to avoid partial writes.",
        findings: [{ summary: "Ledger rows must stay consistent.", evidence: "src/services/ledger.ts" }],
      }),
      makeReport({
        agent: "database",
        recommendation: "Avoid a transaction for the ledger update; keep it eventually consistent via the outbox table.",
        findings: [{ summary: "Ledger writes fan out to an async outbox.", evidence: "schema.sql" }],
      }),
    ];
    const result = reconcile("task-1", reports, routing, noStack, null);
    expect(result.status).toBe("CONFLICT");
    expect(result.conflicts).toHaveLength(1);
    const agents = result.conflicts[0].participants.map((p) => p.agent).sort();
    expect(agents).toEqual(["database", "node-backend", "python-backend"]);
    expect(result.conflicts[0].participants.find((p) => p.agent === "database")!.polarity).toBe("negative");
  });
});

describe("reconcile — multiple independent conflicts", () => {
  it("keeps every conflict independently inspectable (specialist disagreement + evidence contradiction)", () => {
    const routing: RoutingResult = { agents: ["node-backend", "database"], rationale: [], scenario: "node + database", needsEscalation: false };
    const mysqlStack: DetectedStack = {
      language: "node",
      packageManager: "npm",
      framework: "Express",
      database: "MySQL",
      testCommand: null,
      lintCommand: null,
      typecheckCommand: null,
      evidence: [],
    };
    const reports = [
      makeReport({
        agent: "node-backend",
        recommendation: "Use a PostgreSQL transaction for order creation.",
        findings: [{ summary: "Order creation writes must be atomic.", evidence: "src/routes/orders.ts" }],
      }),
      makeReport({
        agent: "database",
        recommendation: "Avoid a transaction for order creation; keep it eventually consistent.",
        findings: [{ summary: "Order creation now spans services.", evidence: "schema.sql" }],
      }),
    ];
    const result = reconcile("task-1", reports, routing, mysqlStack, null);
    // (1) node-backend vs database disagree on the transaction decision itself
    // (2) node-backend's recommendation names PostgreSQL but the repository is MySQL
    expect(result.conflicts).toHaveLength(2);
    const kinds = result.conflicts.map((c) => c.kind).sort();
    expect(kinds).toEqual(["evidence-contradiction", "specialist-disagreement"]);
    const ids = new Set(result.conflicts.map((c) => c.id));
    expect(ids.size).toBe(result.conflicts.length);
  });
});

describe("hasUnresolvedMaterialConflict / recomputeStatus", () => {
  it("gate flips from true to false once the only material conflict is resolved, and status recomputes to AGREED", () => {
    const reports = [
      makeReport({
        agent: "node-backend",
        recommendation: "Use a PostgreSQL transaction for order creation.",
        findings: [{ summary: "Order creation writes must be atomic.", evidence: "src/routes/orders.ts" }],
      }),
      makeReport({
        agent: "database",
        recommendation: "Do not use a transaction here; keep this eventually consistent.",
        findings: [{ summary: "Order creation spans two services.", evidence: "schema.sql" }],
      }),
    ];
    const result = reconcile("task-1", reports, twoAgentRouting, noStack, null);
    expect(hasUnresolvedMaterialConflict(result)).toBe(true);

    result.conflicts[0].resolution = {
      resolution: "Use a transaction; the outbox pattern was abandoned.",
      reason: "Developer decision after inspecting both evidence trails.",
      resolvedBy: "developer",
      resolvedAt: new Date().toISOString(),
    };
    expect(hasUnresolvedMaterialConflict(result)).toBe(false);
    expect(recomputeStatus(result)).toBe("AGREED");
  });

  it("non-material-only conflicts never set the material gate", () => {
    const reports = [
      makeReport({
        agent: "node-backend",
        recommendation: "Add unit test coverage for the retry path.",
        findings: [{ summary: "Retry path is untested.", evidence: "src/services/retry.ts" }],
      }),
      makeReport({
        agent: "database",
        recommendation: "Skip additional test coverage for the retry path; existing integration tests already cover it.",
        findings: [{ summary: "Integration suite already exercises retries.", evidence: "tests/integration/retry.test.ts" }],
      }),
    ];
    const result = reconcile("task-1", reports, twoAgentRouting, noStack, null);
    if (result.conflicts.length > 0) {
      expect(result.conflicts.every((c) => c.materiality === "non-material")).toBe(true);
    }
    expect(hasUnresolvedMaterialConflict(result)).toBe(false);
  });
});

describe("reconcile — false positives (section 19)", () => {
  it("different code examples for the same compatible approach do not conflict", () => {
    const reports = [
      makeReport({
        agent: "node-backend",
        recommendation: "Validate the request body using a Zod schema before persisting.",
        findings: [{ summary: "No validation currently guards this route.", evidence: "src/routes/orders.ts" }],
      }),
      makeReport({
        agent: "database",
        recommendation: "Validate incoming payloads against the schema before writing to avoid malformed rows.",
        findings: [{ summary: "Malformed rows have appeared before.", evidence: "schema.sql" }],
      }),
    ];
    const result = reconcile("task-1", reports, twoAgentRouting, noStack, null);
    expect(result.status).toBe("AGREED");
  });

  it("agent-specific concerns in unrelated categories never conflict", () => {
    const reports = [
      makeReport({
        agent: "node-backend",
        recommendation: "Add a feature flag to roll this out gradually.",
        findings: [{ summary: "This is a risky rollout.", evidence: "src/config/flags.ts" }],
      }),
      makeReport({
        agent: "database",
        recommendation: "Add an index to support the new query pattern.",
        findings: [{ summary: "The query currently does a full scan.", evidence: "schema.sql" }],
      }),
    ];
    const result = reconcile("task-1", reports, twoAgentRouting, noStack, null);
    expect(result.conflicts).toHaveLength(0);
  });

  it("irrelevant specialist output (empty findings) never fabricates a conflict", () => {
    const reports = [
      makeReport({ agent: "node-backend", recommendation: "Implement the endpoint.", findings: [] }),
      makeReport({ agent: "database", recommendation: "No persistence changes needed.", findings: [] }),
    ];
    const result = reconcile("task-1", reports, twoAgentRouting, noStack, null);
    expect(result.conflicts).toHaveLength(0);
  });
});
