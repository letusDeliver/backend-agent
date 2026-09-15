// Shared contracts for the orchestrator. Field shapes intentionally follow the
// vocabulary established in Project Memory Phases 15-17 (Task / AgentRun /
// Handoff) and the Phase 27 artifact filenames in
// claude-code-platform-architecture-v0.1/protocols/artifact-contracts.json —
// without reintroducing the Model Adapter / Tool Gateway runtime that Phase 19
// retired in favor of Claude Code as the execution substrate.

export type TaskStatus =
  | "created"
  | "inspecting"
  | "routing"
  | "analyzing"
  | "reconciling"
  | "planning"
  | "implementing"
  | "reviewing"
  | "completed"
  | "failed"
  | "blocked";

export type AgentType = "python-backend" | "node-backend" | "database";

export type ExecutionMode = "real" | "mock";

export interface TaskCreateInput {
  title: string;
  requirement: string;
  repository: string;
  preferredTechnology?: string;
  preferredDatabase?: string;
  constraints?: string;
}

export interface DetectedStack {
  language: "python" | "node" | "unknown";
  packageManager: string | null;
  framework: string | null;
  database: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  typecheckCommand: string | null;
  evidence: string[];
}

export interface Task {
  id: string;
  title: string;
  requirement: string;
  repository: string;
  preferredTechnology?: string;
  preferredDatabase?: string;
  constraints?: string;
  status: TaskStatus;
  detectedStack: DetectedStack | null;
  selectedAgents: AgentType[];
  currentStage: string;
  executionMode: ExecutionMode;
  reviewRetryCount: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export type EventType =
  | "TASK_CREATED"
  | "REPOSITORY_INSPECTION_STARTED"
  | "REPOSITORY_INSPECTION_COMPLETED"
  | "AGENT_SELECTED"
  | "AGENT_ANALYSIS_STARTED"
  | "AGENT_ANALYSIS_COMPLETED"
  | "RECONCILIATION_STARTED"
  | "RECONCILIATION_COMPLETED"
  | "IMPLEMENTATION_PLAN_CREATED"
  | "IMPLEMENTATION_STARTED"
  | "IMPLEMENTATION_COMPLETED"
  | "REVIEW_STARTED"
  | "REVIEW_COMPLETED"
  | "REVIEW_BLOCKING_ISSUE_FOUND"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "TASK_BLOCKED";

export interface TaskEvent {
  id: string;
  taskId: string;
  type: EventType;
  message: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export type SpecialistRunStatus = "not_required" | "pending" | "analyzing" | "completed" | "failed";

export interface SpecialistFinding {
  summary: string;
  evidence: string;
}

export interface SpecialistRisk {
  summary: string;
  severity: "low" | "medium" | "high";
}

export interface SpecialistReport {
  agent: AgentType;
  taskId: string;
  status: SpecialistRunStatus;
  recommendation: string;
  findings: SpecialistFinding[];
  risks: SpecialistRisk[];
  assumptions: string[];
  confidence: number;
  executionMode: ExecutionMode;
  createdAt: string;
}

export type ReconciliationStatus = "AGREED" | "CONFLICT" | "UNKNOWN" | "NEEDS_USER_DECISION";

export interface ArchitectureDecision {
  decision: string;
  alternatives: string[];
  evidence: string;
  rationale: string;
  confidence: number;
  owner: AgentType | "orchestrator";
}

export interface Reconciliation {
  taskId: string;
  status: ReconciliationStatus;
  decisions: ArchitectureDecision[];
  risks: SpecialistRisk[];
  conflicts: string[];
  confidencePercent: number;
  createdAt: string;
}

export interface ImplementationPlanFile {
  path: string;
  description: string;
}

export interface ImplementationPlan {
  taskId: string;
  summary: string;
  files: ImplementationPlanFile[];
  validationCommands: string[];
  createdAt: string;
}

export interface TestRunResult {
  command: string;
  status: "passed" | "failed" | "skipped";
  passed: number;
  failed: number;
  evidenceRef: string;
}

export interface ExecutionReport {
  taskId: string;
  executionMode: ExecutionMode;
  status: "completed" | "failed";
  changedFiles: string[];
  tests: TestRunResult[];
  commandsExecuted: string[];
  notes: string[];
  createdAt: string;
}

export interface ReviewFinding {
  summary: string;
  severity: "warning" | "blocking";
  location?: string;
  recommendation: string;
}

export interface ReviewReport {
  agent: AgentType;
  taskId: string;
  status: "PASS" | "FAIL";
  findings: ReviewFinding[];
  executionMode: ExecutionMode;
  createdAt: string;
  attempt: number;
}

export interface FinalHandoff {
  taskId: string;
  summary: string;
  agentsUsed: AgentType[];
  filesChanged: number;
  testsPassed: number;
  testsFailed: number;
  reviewsPassed: number;
  reviewsFailed: number;
  architectureDecisions: number;
  warnings: number;
  executionMode: ExecutionMode;
  status: "completed" | "blocked";
  createdAt: string;
}
