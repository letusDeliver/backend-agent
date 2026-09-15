import type {
  AgentType,
  DetectedStack,
  ExecutionMode,
  ExecutionReport,
  ImplementationPlan,
  ReviewReport,
  SpecialistReport,
  Task,
  TestRunResult,
} from "../types/index.js";

export interface AnalyzeParams {
  agent: AgentType;
  task: Task;
  detectedStack: DetectedStack;
  specialistContract: string;
  question: string;
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
}
