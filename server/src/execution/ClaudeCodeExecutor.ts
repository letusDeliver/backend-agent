import type {
  AgentType,
  DetectedStack,
  ExecutionMode,
  ExecutionReport,
  ImplementationPlan,
  ReconciliationConflict,
  ReviewReport,
  SpecialistReport,
  Task,
  TestRunResult,
} from "../types/index.js";
import type { ContextPackEntry } from "../memory/contextPack.js";

export interface AnalyzeParams {
  agent: AgentType;
  task: Task;
  detectedStack: DetectedStack;
  specialistContract: string;
  question: string;
  /**
   * Validated engineering memory relevant to this agent, already filtered
   * by relevance and technology (see memory/contextPack.ts). Never contains
   * candidate/unapproved lessons — retrieve() itself enforces that. May be
   * empty; specialists must still weigh current repository evidence above
   * this (Phase 29 brief section 11).
   */
  memoryContext: ContextPackEntry[];
}

export interface ImplementParams {
  task: Task;
  plan: ImplementationPlan;
  detectedStack: DetectedStack;
}

export interface RunTestsParams {
  task: Task;
  detectedStack: DetectedStack;
}

/**
 * Phase 36: invoked only when routing could not confidently select any
 * specialist (repository inspection inconclusive and the requirement names
 * no backend technology) and the task opted into `autonomyLevel:
 * "autonomous"`. Never given repository file access — the decision is
 * reasoned purely from the requirement text and the (necessarily sparse)
 * `detectedStack`, not from reading the target repository, since the whole
 * premise of this call is that no stack signal exists yet to safely locate
 * a workspace against.
 */
export interface DirectionDecisionParams {
  task: Task;
  detectedStack: DetectedStack;
}

export interface DirectionDecision {
  language: "python" | "node";
  agents: AgentType[];
  rationale: string;
  confidence: number;
  executionMode: ExecutionMode;
  createdAt: string;
}

/**
 * Phase 37: invoked only when reconciliation found at least one unresolved
 * *material* conflict (which would otherwise block the task for a developer
 * to resolve — see `hasUnresolvedMaterialConflict()`) and the task opted
 * into `autonomyLevel: "autonomous"`. One call per conflict, not a batch —
 * each conflict is arbitrated and recorded independently, so a failure on
 * one never blocks arbitration of the others. Never given repository file
 * access, for the same reason as `decideDirection()`: this is reasoning over
 * already-captured specialist report text (`conflict.participants`), not
 * over repository content.
 */
export interface ConflictResolutionParams {
  task: Task;
  conflict: ReconciliationConflict;
}

export interface ConflictResolutionDecision {
  resolution: string;
  reason: string;
  confidence: number;
  executionMode: ExecutionMode;
  createdAt: string;
}

export interface ReviewParams {
  agent: AgentType;
  task: Task;
  specialistContract: string;
  plan: ImplementationPlan;
  executionReport: ExecutionReport;
  attempt: number;
}

/**
 * Execution abstraction the orchestrator depends on (never on a concrete
 * implementation). Per the build instructions this distinction must never be
 * hidden from the developer: every artifact this abstraction produces
 * carries `executionMode` so the UI can label it REAL EXECUTION or
 * MOCK / SIMULATED EXECUTION rather than letting either look like the other.
 */
export interface ClaudeCodeExecutor {
  readonly mode: ExecutionMode;
  analyze(params: AnalyzeParams): Promise<SpecialistReport>;
  implement(params: ImplementParams): Promise<ExecutionReport>;
  runTests(params: RunTestsParams): Promise<TestRunResult[]>;
  review(params: ReviewParams): Promise<ReviewReport>;
  decideDirection(params: DirectionDecisionParams): Promise<DirectionDecision>;
  decideConflictResolution(params: ConflictResolutionParams): Promise<ConflictResolutionDecision>;
  /**
   * Best-effort termination of any in-flight work for a task (Phase 28 —
   * cancellation). Mock execution has nothing to cancel (every call is
   * synchronous/instant); real execution kills the tracked child process(es).
   */
  cancel(taskId: string): void;
}
