import type {
  AgentType,
  DetectedStack,
  ExecutionMode,
  ExecutionReport,
  ImplementationPlan,
  Reconciliation,
  ReconciliationConflict,
  ReviewReport,
  SpecialistReport,
  Task,
  TestRunResult,
} from "../types/index.js";
import type { ContextPackEntry } from "../memory/contextPack.js";
import type { ImplementProgressEvent } from "./streamJsonParser.js";

/**
 * Phase 39: identifies which backlog step an `implement()`/`review()` call
 * is scoped to, when `Task.decomposeRequirement` is active. Its absence
 * means "the whole plan, in one pass" — today's original, still-default
 * behavior.
 */
export interface ActiveSubtask {
  index: number;
  total: number;
  title: string;
  description: string;
}

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
  activeSubtask?: ActiveSubtask;
  /**
   * Phase 41: called synchronously, zero or more times, as the real
   * `claude` CLI streams tool calls (Write/Edit/Bash/...) and assistant
   * text during this implementation pass — never a batch summary at the
   * end. Optional: mock execution never calls it (nothing real is
   * happening to report), and no existing fixture/test needs to change to
   * keep compiling.
   */
  onProgress?: (event: ImplementProgressEvent) => void;
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
  activeSubtask?: ActiveSubtask;
}

/**
 * Phase 39: invoked once per task, right after planning, only when
 * `Task.decomposeRequirement === true` — decomposes the reconciled plan
 * into an ordered backlog small enough for each step's own bounded
 * `implement()` call to realistically finish, instead of one monolithic
 * pass. Concretely motivated: a real-mode greenfield build was empirically
 * observed hitting `config.claudeTimeoutMs` on every attempt of a single
 * implement() call (see docs/PHASE_39_COMPLETION_REPORT.md).
 */
export interface DecomposeRequirementParams {
  task: Task;
  plan: ImplementationPlan;
  reconciliation: Reconciliation;
}

export interface SubtaskDefinition {
  title: string;
  description: string;
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
  decomposeRequirement(params: DecomposeRequirementParams): Promise<SubtaskDefinition[]>;
  /**
   * Best-effort termination of any in-flight work for a task (Phase 28 —
   * cancellation). Mock execution has nothing to cancel (every call is
   * synchronous/instant); real execution kills the tracked child process(es).
   */
  cancel(taskId: string): void;
  /**
   * Best-effort termination of *every* in-flight process, across every
   * task — for graceful server shutdown (see index.ts's SIGTERM/SIGINT
   * handlers), not per-task cancellation. Discovered as a real gap during
   * manual validation: killing the orchestrator process does not, on its
   * own, terminate `claude` CLI child processes it spawned — they were
   * found still running real API calls for tasks nobody could ever read
   * the result of. Mock execution has nothing to cancel.
   */
  cancelAllInFlight(): void;
}
