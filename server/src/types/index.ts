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
  | "blocked"
  | "cancelled";

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

/**
 * The isolated git worktree real execution runs against, for a given task.
 * Never populated in mock mode. `status: "failed"` means workspace
 * preparation itself failed (unsafe/non-git path, etc.) — the task is
 * `blocked` with `error` set to the same reason.
 */
export interface RealExecutionWorkspace {
  workspacePath: string;
  branch: string;
  baseRevision: string;
  status: "ready" | "failed";
  createdAt: string;
  error?: string;
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
  executionWorkspace?: RealExecutionWorkspace;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export type EventType =
  | "TASK_CREATED"
  | "REPOSITORY_INSPECTION_STARTED"
  | "REPOSITORY_INSPECTION_COMPLETED"
  | "AGENT_SELECTED"
  | "WORKSPACE_PREPARED"
  | "WORKSPACE_PREPARATION_FAILED"
  | "MEMORY_RETRIEVED"
  | "CANDIDATE_LESSONS_GENERATED"
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
  | "TASK_BLOCKED"
  | "TASK_CANCELLED";

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

/**
 * The fixed, deliberately small taxonomy conflict detection classifies
 * decisions into (Phase 30 brief section 6). Order in reconciliation.ts's
 * keyword table matters (most specific first, "architecture" is the
 * fallback) — this type is just the closed set of legal values.
 */
export type DecisionCategory =
  | "architecture"
  | "api"
  | "database"
  | "data-model"
  | "transaction"
  | "validation"
  | "authentication"
  | "authorization"
  | "error-handling"
  | "performance"
  | "testing"
  | "dependency"
  | "configuration"
  | "deployment";

export type DecisionPolarity = "affirmative" | "negative";

export interface ConflictParticipant {
  agent: AgentType;
  decision: string;
  rationale: string;
  evidence: string;
  confidence: number;
  polarity: DecisionPolarity;
  memoryInfluenced: boolean;
  memoryIds: string[];
}

export interface ConflictResolution {
  resolution: string;
  reason: string;
  resolvedBy: string;
  resolvedAt: string;
}

export type ConflictMateriality = "material" | "non-material";

/**
 * A material engineering disagreement the orchestrator refuses to silently
 * resolve (PHASE_30_IMPLEMENTATION_PLAN.md sections 3/6/8). `kind:
 * "evidence-contradiction"` has exactly one participant — the disagreeing
 * agent — plus `repositoryEvidence` describing what the repository actually
 * shows; the recommendation itself is never rewritten (section 6/8).
 */
export interface ReconciliationConflict {
  id: string;
  kind: "specialist-disagreement" | "evidence-contradiction";
  category: DecisionCategory;
  subject: string;
  detectedAt: "reconciliation" | "review";
  participants: ConflictParticipant[];
  repositoryEvidence?: string;
  materiality: ConflictMateriality;
  reason: string;
  resolution: ConflictResolution | null;
  createdAt: string;
}

export interface Reconciliation {
  taskId: string;
  status: ReconciliationStatus;
  decisions: ArchitectureDecision[];
  agreements: string[];
  conflicts: ReconciliationConflict[];
  unresolvedQuestions: string[];
  risks: SpecialistRisk[];
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

export interface ExecutionDiffFile {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * Ground-truth `git diff` evidence for a real-mode implementation pass —
 * never self-reported by the CLI. Absent for mock-mode reports.
 */
export interface ExecutionDiff {
  baseRevision: string;
  branch: string;
  files: ExecutionDiffFile[];
  summary: string;
}

export interface ExecutionReport {
  taskId: string;
  executionMode: ExecutionMode;
  status: "completed" | "failed";
  changedFiles: string[];
  tests: TestRunResult[];
  commandsExecuted: string[];
  notes: string[];
  diff?: ExecutionDiff;
  durationMs?: number;
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
