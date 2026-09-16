import type {
  ClaudeCodeExecutor,
  AnalyzeParams,
  ConflictResolutionDecision,
  ConflictResolutionParams,
  DecomposeRequirementParams,
  DirectionDecision,
  DirectionDecisionParams,
  ImplementParams,
  ReviewParams,
  RunTestsParams,
  SubtaskDefinition,
} from "./ClaudeCodeExecutor.js";
import type { AgentType, ExecutionReport, ReviewReport, SpecialistReport, TestRunResult } from "../types/index.js";
import { combinedRequirementText } from "../orchestrator/requirementDocs.js";

const MOCK_PYTHON_KEYWORDS = ["python", "fastapi", "django", "flask", "pytest", "sqlalchemy"];
const MOCK_DATABASE_KEYWORDS = ["database", "postgres", "postgresql", "mongo", "mongodb", "redis", "schema", "migration", "transaction", "persistence"];

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
        ...((task.requirementDocs?.length ?? 0) > 0
          ? [`Incorporated ${task.requirementDocs!.length} requirement document(s) read from the repository: ${task.requirementDocs!.map((d) => d.path).join(", ")}`]
          : []),
      ],
      confidence: 0.7,
      executionMode: "mock",
      createdAt: new Date().toISOString(),
    };
  }

  async implement({ task, plan, activeSubtask }: ImplementParams): Promise<ExecutionReport> {
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
        ...(activeSubtask ? [`Scoped to subtask ${activeSubtask.index}/${activeSubtask.total}: ${activeSubtask.title}`] : []),
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

  cancelAllInFlight(): void {
    // Every mock call resolves synchronously/instantly — nothing to cancel.
  }

  /**
   * Deterministic stand-in for the real arbitration call: a simple keyword
   * check on the requirement, defaulting to Node.js (this platform's own
   * stack) when the text gives no signal at all, exactly the scenario this
   * method exists for. Confidence is fixed and low (0.4) — mock decisions
   * must never look as trustworthy as a real one, per this project's
   * standing rule that simulated output is always clearly labeled.
   */
  async decideDirection({ task }: DirectionDecisionParams): Promise<DirectionDecision> {
    // Phase 38: scans requirement docs too, not just the requirement field —
    // the exact "no clue where to begin, my docs say what I want" scenario
    // this method exists for.
    const text = combinedRequirementText(task.requirement, task.requirementDocs).toLowerCase();
    const pythonMatched = MOCK_PYTHON_KEYWORDS.some((k) => text.includes(k));
    const language: "python" | "node" = pythonMatched ? "python" : "node";
    const agents: AgentType[] = [language === "python" ? "python-backend" : "node-backend"];
    if (MOCK_DATABASE_KEYWORDS.some((k) => text.includes(k))) {
      agents.push("database");
    }
    return {
      language,
      agents,
      rationale: pythonMatched
        ? "MOCK / SIMULATED EXECUTION: no live reasoning was performed. Chose Python from a keyword match in the requirement text/documents."
        : "MOCK / SIMULATED EXECUTION: no live reasoning was performed. Defaulted to Node.js (this platform's own stack) " +
          "because the requirement, its documents, and repository evidence gave no real stack signal to reason from.",
      confidence: 0.4,
      executionMode: "mock",
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Deterministic stand-in for the real arbitration call: adopts whichever
   * participant reported the highest confidence, rather than reasoning
   * about the actual disagreement. Same fixed low confidence (0.4) and
   * MOCK-labeled rationale convention as `decideDirection()`.
   */
  async decideConflictResolution({ conflict }: ConflictResolutionParams): Promise<ConflictResolutionDecision> {
    const top = [...conflict.participants].sort((a, b) => b.confidence - a.confidence)[0];
    return {
      resolution: top ? `Adopt this position: ${top.decision}` : "No participant recommendation was available to adopt.",
      reason: top
        ? `MOCK / SIMULATED EXECUTION: no live reasoning was performed. Chose the participant with the highest reported confidence (${top.agent}, ${top.confidence}).`
        : "MOCK / SIMULATED EXECUTION: no live reasoning was performed, and no participant was available to choose from.",
      confidence: 0.4,
      executionMode: "mock",
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Deterministic stand-in for the real backlog-decomposition call: splits
   * on numbered markers "(1) ... (2) ..." if the requirement is already
   * written that way (as this project's own requirement prompts often are),
   * otherwise returns a single subtask covering the whole requirement —
   * identical in effect to not decomposing at all. Real reasoning about how
   * to split an unstructured requirement into a sensible backlog is exactly
   * the kind of judgment this heuristic doesn't attempt.
   */
  async decomposeRequirement({ task }: DecomposeRequirementParams): Promise<SubtaskDefinition[]> {
    const markerCount = (task.requirement.match(/\(\d+\)/g) ?? []).length;
    if (markerCount < 2) {
      return [{ title: task.title, description: task.requirement }];
    }
    const withMarkerAtStart = task.requirement.trimStart().startsWith("(");
    const parts = task.requirement
      .split(/\(\d+\)\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    const items = withMarkerAtStart ? parts : parts.slice(1);
    return items.map((item, i) => ({
      title: `Step ${i + 1}: ${item.split(/[.\n]/)[0].slice(0, 80).trim()}`,
      description: item,
    }));
  }
}
