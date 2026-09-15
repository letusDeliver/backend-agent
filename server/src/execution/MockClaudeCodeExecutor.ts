import type {
  ClaudeCodeExecutor,
  AnalyzeParams,
  ImplementParams,
  ReviewParams,
  RunTestsParams,
} from "./ClaudeCodeExecutor.js";
import type { ExecutionReport, ReviewReport, SpecialistReport, TestRunResult } from "../types/index.js";

/**
 * Deterministic, clearly-labeled synthetic executor. It never touches the
 * filesystem and never claims a test ran. Every artifact it produces sets
 * executionMode: "mock" so the UI can never present simulated output as real
 * execution evidence (master instructions §20/§10 — "do not claim execution
 * results unless they actually occurred").
 */
export class MockClaudeCodeExecutor implements ClaudeCodeExecutor {
  readonly mode = "mock" as const;

  async analyze({ agent, task, detectedStack, memoryContext }: AnalyzeParams): Promise<SpecialistReport> {
    const evidenceSample = detectedStack.evidence.slice(0, 3);
    const findings = [
      {
        summary: `Repository ${detectedStack.framework ?? "structure"} conventions inspected for "${task.title}".`,
        evidence: evidenceSample[0] ?? "No direct repository evidence available; treat as a general recommendation.",
      },
      {
        summary: agent === "database"
          ? "Existing persistence layer reviewed for schema/transaction impact."
          : "Existing router/service layering reviewed for the requested change.",
        evidence: evidenceSample[1] ?? "Repository layering inferred from directory conventions.",
      },
      {
        summary: agent === "database"
          ? "Indexing strategy considered for the query shape implied by the requirement."
          : "Validation and error-handling conventions checked against similar existing endpoints.",
        evidence: evidenceSample[2] ?? "No further repository evidence sampled.",
      },
    ];

    return {
      agent,
      taskId: task.id,
      status: "completed",
      recommendation:
        agent === "database"
          ? "Extend the existing persistence layer using the repository's current transaction and indexing conventions rather than introducing a new pattern."
          : `Implement "${task.title}" following the repository's existing router/service/data-access layering.`,
      findings,
      risks: [
        {
          summary:
            agent === "database"
              ? "New/changed indexes should be validated against real query plans before merge."
              : "Simulated analysis — validate assumptions against the real codebase before implementation.",
          severity: "medium",
        },
      ],
      assumptions: [
        "MOCK / SIMULATED EXECUTION: this report was generated heuristically and was not produced by a live Claude Code session.",
        ...(memoryContext.length > 0
          ? [
              `Incorporated ${memoryContext.length} relevant validated memory item(s): ${memoryContext
                .map((m) => m.summary)
                .join(" | ")}`,
            ]
          : []),
      ],
      confidence: 0.7,
      executionMode: "mock",
      createdAt: new Date().toISOString(),
    };
  }

  async implement({ task, plan }: ImplementParams): Promise<ExecutionReport> {
    return {
      taskId: task.id,
      executionMode: "mock",
      status: "completed",
      changedFiles: plan.files.map((f) => f.path),
      tests: [],
      commandsExecuted: [],
      notes: [
        "MOCK / SIMULATED EXECUTION: no files were modified on disk and no commands were run.",
        "This is a simulated implementation pass. Set CLAUDE_EXECUTION_MODE=real to execute through the local Claude Code CLI.",
      ],
      createdAt: new Date().toISOString(),
    };
  }

  async runTests(_params: RunTestsParams): Promise<TestRunResult[]> {
    return [
      {
        command: "(simulated — no test command executed)",
        status: "skipped",
        passed: 0,
        failed: 0,
        evidenceRef: "mock-execution-no-evidence",
      },
    ];
  }

  async review({ agent, task, attempt }: ReviewParams): Promise<ReviewReport> {
    return {
      agent,
      taskId: task.id,
      status: "PASS",
      findings: [
        {
          summary: "MOCK / SIMULATED EXECUTION: review generated heuristically, not by a live specialist session.",
          severity: "warning",
          recommendation: "Re-run with CLAUDE_EXECUTION_MODE=real for an evidence-backed review before merging.",
        },
      ],
      executionMode: "mock",
      createdAt: new Date().toISOString(),
      attempt,
    };
  }

  cancel(_taskId: string): void {
    // Every mock call resolves synchronously/instantly — nothing to cancel.
  }
}
