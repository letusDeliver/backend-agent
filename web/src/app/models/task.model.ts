// Mirrors server/src/types/index.ts — the two are kept in sync by hand since
// this MVP does not introduce a shared-package build step for a two-workspace
// project.

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

/**
 * "advisory" (default) is every existing human-gated blocking behavior,
 * unchanged. "autonomous" is an explicit per-task opt-in that lets the
 * orchestrator decide a direction itself, at the one decision point Phase
 * 36 covers, instead of blocking (Phase 36).
 */
export type AutonomyLevel = "advisory" | "autonomous";

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
 * One requirement/task doc a task pointed at inside the repository,
 * already read at inspection time (Phase 38). `readError` is set instead
 * of real content when the path didn't exist or escaped the repository.
 */
export interface RequirementDocExcerpt {
  path: string;
  content: string;
  truncated: boolean;
  totalChars: number;
  readError?: string;
}

/**
 * The isolated git worktree real execution runs against, for a given task.
 * Never populated in mock mode.
 */
export interface RealExecutionWorkspace {
  workspacePath: string;
  branch: string;
  baseRevision: string;
  status: "ready" | "failed";
  createdAt: string;
  error?: string;
  cleanupStatus?: "ready" | "cleaned" | "cleanup_failed";
  cleanedAt?: string;
  cleanupError?: string;
}

/**
 * An audit record of one LLM-backed decision the orchestrator made on its
 * own, in place of blocking for a developer — only ever present when
 * `Task.autonomyLevel === "autonomous"`. `"routing"` (Phase 36) carries
 * `agents`; `"reconciliation-conflict"` (Phase 37) carries `conflictId`.
 */
export interface AutonomousDecision {
  subject: "routing" | "reconciliation-conflict";
  decision: string;
  agents?: AgentType[];
  conflictId?: string;
  rationale: string;
  confidence: number;
  executionMode: ExecutionMode;
  createdAt: string;
}

/**
 * One step in a decomposed implementation backlog (Phase 39) — only ever
 * present when `Task.decomposeRequirement === true`.
 */
export interface Subtask {
  id: string;
  index: number;
  total: number;
  title: string;
  description: string;
  status: "pending" | "implementing" | "reviewing" | "completed" | "blocked" | "failed";
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
  autonomyLevel?: AutonomyLevel;
  autonomousDecisions?: AutonomousDecision[];
  requirementDocPaths?: string[];
  requirementDocs?: RequirementDocExcerpt[];
  decomposeRequirement?: boolean;
  subtasks?: Subtask[];
  executionWorkspace?: RealExecutionWorkspace;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface TaskCreateInput {
  title?: string;
  requirement: string;
  repository: string;
  preferredTechnology?: string;
  preferredDatabase?: string;
  constraints?: string;
  autonomyLevel?: AutonomyLevel;
  requirementDocPaths?: string[];
  decomposeRequirement?: boolean;
}

/**
 * The furthest pipeline stage an archived attempt's artifacts show it
 * reached (Phase 34) — never a guess at its final status (`failed` vs
 * `blocked` vs `cancelled` is never archived per attempt, only which
 * artifact files exist). `reachedStage` is a `STAGE_SEQUENCE`-compatible
 * key, or `"early"` if not even specialist reports exist yet.
 */
export interface AttemptSummary {
  attempt: number;
  reachedStage: string;
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
  | "TASK_CANCELLED"
  | "TASK_RETRIED"
  | "WORKSPACE_CLEANED"
  | "WORKSPACE_CLEANUP_FAILED"
  | "AUTONOMOUS_DECISION_MADE"
  | "REQUIREMENT_DOCS_READ"
  | "SUBTASKS_DECOMPOSED"
  | "SUBTASK_STARTED"
  | "SUBTASK_COMPLETED"
  | "SUBTASK_BLOCKED";

export interface TaskEvent {
  id: string;
  taskId: string;
  type: EventType;
  message: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

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
  status: "not_required" | "pending" | "analyzing" | "completed" | "failed";
  recommendation: string;
  findings: SpecialistFinding[];
  risks: SpecialistRisk[];
  assumptions: string[];
  confidence: number;
  executionMode: ExecutionMode;
  createdAt: string;
}

export interface ArchitectureDecision {
  decision: string;
  alternatives: string[];
  evidence: string;
  rationale: string;
  confidence: number;
  owner: AgentType | "orchestrator";
}

export type DecisionCategory =
  | "architecture" | "api" | "database" | "data-model" | "transaction"
  | "validation" | "authentication" | "authorization" | "error-handling"
  | "performance" | "testing" | "dependency" | "configuration" | "deployment";

export interface ConflictParticipant {
  agent: AgentType;
  decision: string;
  rationale: string;
  evidence: string;
  confidence: number;
  polarity: "affirmative" | "negative";
  memoryInfluenced: boolean;
  memoryIds: string[];
}

export interface ConflictResolution {
  resolution: string;
  reason: string;
  resolvedBy: string;
  resolvedAt: string;
}

export interface ReconciliationConflict {
  id: string;
  kind: "specialist-disagreement" | "evidence-contradiction";
  category: DecisionCategory;
  subject: string;
  detectedAt: "reconciliation" | "review";
  participants: ConflictParticipant[];
  repositoryEvidence?: string;
  materiality: "material" | "non-material";
  reason: string;
  resolution: ConflictResolution | null;
  createdAt: string;
}

export interface Reconciliation {
  taskId: string;
  status: "AGREED" | "CONFLICT" | "UNKNOWN" | "NEEDS_USER_DECISION";
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
 * Ground-truth `git diff` evidence for a real-mode implementation pass.
 * `patch` (Phase 33) is the actual unified-diff text, bounded to a maximum
 * size — `truncated` says whether it was cut, and `totalPatchChars` is
 * always the full, untruncated length so the UI can show "showing X of Y".
 */
export interface ExecutionDiff {
  baseRevision: string;
  branch: string;
  files: ExecutionDiffFile[];
  summary: string;
  patch: string;
  truncated: boolean;
  totalPatchChars: number;
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
  /** Whether the stored diff's patch content was truncated (Phase 33). */
  diffTruncated?: boolean;
  executionMode: ExecutionMode;
  status: "completed" | "blocked";
  createdAt: string;
}

export type MemoryType = "task_history" | "project_memory" | "global_knowledge" | "candidate_lesson" | "validated_lesson";
export type MemoryValidationStatus = "validated" | "candidate" | "rejected" | "historical";

export interface MemoryProvenance {
  taskId?: string;
  agent?: string;
  artifact?: string;
  decision?: string;
  humanEdited?: boolean;
  approvedAt?: string;
  approvedBy?: string;
  rejectedAt?: string;
}

export interface MemoryItem {
  id: string;
  type: MemoryType;
  scope: string;
  content: string;
  technology: string[];
  taskType?: string;
  validationStatus: MemoryValidationStatus;
  provenance: MemoryProvenance;
  confidence: number;
  supersedes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextPackEntry {
  memoryId: string;
  type: MemoryType;
  validationStatus: MemoryValidationStatus;
  scope: string;
  confidence: number;
  technology: string[];
  summary: string;
  reason: string;
  score: number;
}

export interface ContextPack {
  taskId: string;
  query: { text: string; technology: string[]; scope: string };
  retrievedCount: number;
  includedCount: number;
  excludedCount: number;
  entries: ContextPackEntry[];
  excludedIds: string[];
  conflicts: string[];
  createdAt: string;
}

export const AGENT_LABELS: Record<AgentType, string> = {
  "python-backend": "Python Backend",
  "node-backend": "Node.js Backend",
  database: "Database",
};
