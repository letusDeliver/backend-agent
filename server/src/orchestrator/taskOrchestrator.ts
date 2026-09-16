import { config } from "../config.js";
import type { TaskStore } from "../store/taskStore.js";
import { ArtifactStore } from "../artifacts/artifactStore.js";
import { TaskEventBus } from "../events/eventBus.js";
import type { ClaudeCodeExecutor } from "../execution/ClaudeCodeExecutor.js";
import { GitWorktreeManager } from "../execution/gitWorktree.js";
import { loadSpecialistContract, AGENT_LABELS } from "../agents/specialistContracts.js";
import { inspectRepository } from "./repositoryInspector.js";
import { routeTask } from "./routingEngine.js";
import { reconcile, hasUnresolvedMaterialConflict, detectReviewConflicts, describeUnresolvedQuestion, recomputeStatus } from "./reconciliation.js";
import { buildImplementationPlan } from "./implementationPlan.js";
import { buildContextPack, memoryForAgent, type ContextPack } from "../memory/contextPack.js";
import { generateCandidateLessons } from "../memory/candidateLessons.js";
import type { MemoryStore } from "../memory/types.js";
import type {
  AgentType,
  ExecutionReport,
  FinalHandoff,
  ImplementationPlan,
  Reconciliation,
  ReconciliationConflict,
  ReviewReport,
  SpecialistReport,
  Task,
} from "../types/index.js";

export class TaskNotFoundError extends Error {}
export class RetryNotAllowedError extends Error {}

/**
 * Statuses `TaskOrchestrator.retry()` accepts a task from (Phase 31
 * proposal §8/§18) — every other status, including every in-flight one,
 * is rejected so a retry can never race a still-running attempt.
 */
export const RETRYABLE_STATUSES = new Set<Task["status"]>(["failed", "blocked", "cancelled"]);

/**
 * Coordinates the full pipeline described in orchestrator/ORCHESTRATOR.md:
 * inspect -> route -> [prepare isolated workspace, real mode only] ->
 * analyze -> reconcile -> plan -> implement -> review -> handoff. Owns
 * workflow-state transitions (ORCHESTRATOR.md responsibility #1-10);
 * specialists and the executor contribute bounded artifacts.
 */
export class TaskOrchestrator {
  constructor(
    private readonly taskStore: TaskStore,
    private readonly artifacts: ArtifactStore,
    private readonly events: TaskEventBus,
    private readonly executor: ClaudeCodeExecutor,
    private readonly worktrees: GitWorktreeManager,
    private readonly memory: MemoryStore
  ) {}

  async run(taskId: string): Promise<void> {
    let task = await this.taskStore.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    try {
      if (await this.isCancelled(taskId)) return;

      task = await this.inspect(task);
      const routing = routeTask(task, task.detectedStack!);

      task = await this.setStage(task, "routing", "routing");
      await this.events.publish(task.id, "AGENT_SELECTED", `Routing decision: ${routing.scenario}`, {
        agents: routing.agents,
        rationale: routing.rationale,
        needsEscalation: routing.needsEscalation,
      });

      if (routing.agents.length === 0) {
        await this.block(task, "No specialist could be confidently selected. Repository inspection was inconclusive and the requirement does not name a backend technology.");
        return;
      }

      task.selectedAgents = routing.agents;
      task = await this.persist(task);

      if (await this.isCancelled(taskId)) return;

      if (this.executor.mode === "real") {
        task = await this.prepareRealExecutionWorkspace(task);
        if (task.executionWorkspace?.status === "failed") {
          await this.block(
            task,
            `Real execution requires an isolated workspace, but preparation failed: ${task.executionWorkspace.error}`
          );
          return;
        }
      }

      if (await this.isCancelled(taskId)) return;

      const contextPack = await this.retrieveMemory(task, routing.agents);

      if (await this.isCancelled(taskId)) return;

      const reports = await this.analyze(task, routing.agents, contextPack);

      if (await this.isCancelled(taskId)) return;

      task = await this.setStage(task, "reconciling", "reconciling");
      await this.events.publish(task.id, "RECONCILIATION_STARTED", "Reconciling specialist recommendations.");
      const reconciliation = reconcile(task.id, reports, routing, task.detectedStack, contextPack);
      await this.artifacts.writeReconciliation(reconciliation);
      await this.events.publish(task.id, "RECONCILIATION_COMPLETED", `Reconciliation status: ${reconciliation.status}`, {
        status: reconciliation.status,
        confidencePercent: reconciliation.confidencePercent,
        conflicts: reconciliation.conflicts.length,
      });

      if (reconciliation.status === "NEEDS_USER_DECISION" || reconciliation.status === "UNKNOWN") {
        await this.block(
          task,
          reconciliation.status === "NEEDS_USER_DECISION"
            ? "Reconciliation requires a developer decision (cross-stack or otherwise high-impact scope)."
            : "Reconciliation could not reach sufficient confidence from specialist analysis."
        );
        return;
      }

      if (hasUnresolvedMaterialConflict(reconciliation)) {
        const count = reconciliation.conflicts.filter((c) => c.materiality === "material" && !c.resolution).length;
        await this.block(
          task,
          `Reconciliation found ${count} unresolved material engineering conflict(s) that require developer resolution before implementation can proceed. See reconciliation.conflicts.`
        );
        return;
      }

      if (await this.isCancelled(taskId)) return;

      await this.continueAfterReconciliation(task, reconciliation);
    } catch (err) {
      await this.handleRunFailure(taskId, err);
    }
  }

  private async handleRunFailure(taskId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await this.taskStore.get(taskId);
    if (failed && failed.status !== "cancelled") {
      failed.status = "failed";
      failed.error = message;
      failed.updatedAt = new Date().toISOString();
      await this.persist(failed);
      await this.events.publish(taskId, "TASK_FAILED", `Task failed: ${message}`);
    }
  }

  /**
   * Shared tail (planning -> implementing -> review -> handoff) between the
   * normal pipeline and conflict-resolution continuation (Phase 30 —
   * PHASE_30_IMPLEMENTATION_PLAN.md section 11). `reconciliation` is already
   * persisted and free of unresolved material conflicts by the time this
   * runs — callers are responsible for that gate.
   */
  private async continueAfterReconciliation(task: Task, reconciliation: Reconciliation): Promise<void> {
    const agents = task.selectedAgents;

    if (await this.isCancelled(task.id)) return;

    task = await this.setStage(task, "planning", "planning");
    const plan = buildImplementationPlan(task, task.detectedStack!, reconciliation, agents);
    await this.artifacts.writeImplementationPlan(plan);
    await this.events.publish(task.id, "IMPLEMENTATION_PLAN_CREATED", `Implementation plan created (${plan.files.length} files).`, {
      files: plan.files,
    });

    if (await this.isCancelled(task.id)) return;

    task = await this.setStage(task, "implementing", "implementing");
    const executionReport = await this.implement(task, plan);

    if (await this.isCancelled(task.id)) return;

    const { finalReviews, blocked, blockReason } = await this.reviewLoop(task, plan, agents, executionReport);
    if (blocked) {
      await this.block(task, blockReason ?? "Review loop exceeded the maximum retry count with unresolved blocking findings.");
      return;
    }

    if (await this.isCancelled(task.id)) return;

    await this.handoff(task, plan, executionReport, finalReviews, agents);
  }

  /**
   * Entry point for `POST /tasks/:id/reconciliation/conflicts/:conflictId/resolve`
   * once no unresolved material conflict remains. Narrowly scoped to the
   * conflict gate this milestone introduces — not a general blocked/failed
   * task resume mechanism (plan section 11 scope note). No-ops safely if the
   * task isn't in a resumable state; callers only invoke this after
   * confirming the gate is clear, so this is a defensive re-check, not the
   * primary guard.
   */
  async resumeAfterConflictResolution(taskId: string): Promise<void> {
    let task = await this.taskStore.get(taskId);
    if (!task || task.status !== "blocked") return;

    const reconciliation = await this.artifacts.readReconciliation(taskId);
    if (!reconciliation || hasUnresolvedMaterialConflict(reconciliation)) return;

    try {
      task = await this.setStage(task, "reconciling", "reconciling");
      await this.events.publish(task.id, "RECONCILIATION_COMPLETED", "All material conflicts resolved; resuming orchestration.", {
        status: reconciliation.status,
        conflicts: reconciliation.conflicts.length,
      });
      await this.continueAfterReconciliation(task, reconciliation);
    } catch (err) {
      await this.handleRunFailure(taskId, err);
    }
  }

  /**
   * Entry point for `POST /tasks/:id/retry` (Phase 31). Restarts a
   * `failed`/`blocked`/`cancelled` task from repository inspection — not a
   * resume of the failed stage (proposal §9). Archives the current
   * attempt's artifacts before resetting any task state; if archiving
   * throws, this rejects without having touched `task.status`/`attempt`,
   * so the task is untouched and safe to retry again (proposal §7).
   *
   * The full pipeline (`run()`) is fired without being awaited here, so
   * callers that await `retry()` only wait for the fast archive+reset step,
   * not the whole run — matching `/start`'s existing fire-and-forget shape.
   */
  async retry(taskId: string): Promise<void> {
    const task = await this.taskStore.get(taskId);
    if (!task) throw new TaskNotFoundError(`Task ${taskId} not found`);
    if (!RETRYABLE_STATUSES.has(task.status)) {
      throw new RetryNotAllowedError(`Task cannot be retried from status "${task.status}".`);
    }

    await this.artifacts.archiveAttempt(task.id, task.attempt);

    const previousAttempt = task.attempt;
    task.attempt = previousAttempt + 1;
    task.status = "created";
    task.currentStage = "created";
    task.error = undefined;
    task.executionWorkspace = undefined;
    task.selectedAgents = [];
    task.reviewRetryCount = 0;
    const retried = await this.persist(task);

    await this.events.publish(
      taskId,
      "TASK_RETRIED",
      `Retry started — attempt ${retried.attempt} (previous attempt ${previousAttempt} archived).`,
      { attempt: retried.attempt, previousAttempt }
    );

    void this.run(taskId);
  }

  /**
   * Merges freshly-detected review-stage conflicts into the task's
   * persisted reconciliation record (plan section 10) rather than starting
   * a parallel workflow — the same artifact, resolution API and resume path
   * used for reconciliation-stage conflicts cover this case too.
   */
  private async appendReconciliationConflicts(taskId: string, newConflicts: ReconciliationConflict[]): Promise<void> {
    const reconciliation = await this.artifacts.readReconciliation(taskId);
    if (!reconciliation) return;
    reconciliation.conflicts.push(...newConflicts);
    reconciliation.unresolvedQuestions.push(...newConflicts.map((c) => describeUnresolvedQuestion(c)));
    reconciliation.status = recomputeStatus(reconciliation);
    await this.artifacts.writeReconciliation(reconciliation);
  }

  /**
   * Reads the persisted status directly rather than trusting the in-memory
   * `task` variable — cancellation is requested via a concurrent HTTP call
   * (`POST /tasks/:id/cancel`) that writes straight to the store, so only a
   * fresh read can see it.
   */
  private async isCancelled(taskId: string): Promise<boolean> {
    const current = await this.taskStore.get(taskId);
    return current?.status === "cancelled";
  }

  private async persist(task: Task): Promise<Task> {
    task.updatedAt = new Date().toISOString();
    await this.taskStore.update(task);
    await this.artifacts.writeTask(task);
    return task;
  }

  private async setStage(task: Task, stage: string, status: Task["status"]): Promise<Task> {
    task.currentStage = stage;
    task.status = status;
    return this.persist(task);
  }

  private async block(task: Task, reason: string): Promise<void> {
    task.status = "blocked";
    task.currentStage = "blocked";
    task.error = reason;
    await this.persist(task);
    await this.events.publish(task.id, "TASK_BLOCKED", reason);
  }

  private async inspect(task: Task): Promise<Task> {
    task = await this.setStage(task, "inspecting", "inspecting");
    await this.events.publish(task.id, "REPOSITORY_INSPECTION_STARTED", `Inspecting repository at ${task.repository}`);
    const detectedStack = await inspectRepository(task.repository);
    task.detectedStack = detectedStack;
    task = await this.persist(task);
    await this.events.publish(task.id, "REPOSITORY_INSPECTION_COMPLETED", `Stack detected: ${describeStack(detectedStack)}`, {
      detectedStack,
    });
    return task;
  }

  /**
   * Real-mode-only step: creates an isolated git worktree/branch for this
   * task and records it on `task.executionWorkspace` before any specialist
   * or implementation call runs. Mock mode never calls this.
   */
  private async prepareRealExecutionWorkspace(task: Task): Promise<Task> {
    try {
      const info = await this.worktrees.prepare(task.repository, task.id, config.tasksDir);
      task.executionWorkspace = {
        workspacePath: info.workspacePath,
        branch: info.branch,
        baseRevision: info.baseRevision,
        status: "ready",
        createdAt: new Date().toISOString(),
      };
      task = await this.persist(task);
      await this.events.publish(task.id, "WORKSPACE_PREPARED", `Isolated workspace ready on branch ${info.branch}.`, {
        branch: info.branch,
        baseRevision: info.baseRevision,
        workspacePath: info.workspacePath,
      });
      return task;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      task.executionWorkspace = {
        workspacePath: "",
        branch: "",
        baseRevision: "",
        status: "failed",
        createdAt: new Date().toISOString(),
        error: message,
      };
      task = await this.persist(task);
      await this.events.publish(task.id, "WORKSPACE_PREPARATION_FAILED", `Could not prepare an isolated workspace: ${message}`);
      return task;
    }
  }

  /**
   * ORCHESTRATOR.md responsibility #3 ("Retrieve relevant memory/context"),
   * unimplemented until Phase 29. Runs after routing (task scope is known)
   * and before specialist analysis. Only validated memory can ever come
   * back from buildContextPack -> memoryStore.retrieve(); repository
   * evidence conflicts are flagged, never silently overridden.
   */
  private async retrieveMemory(task: Task, agents: AgentType[]): Promise<ContextPack> {
    const pack = await buildContextPack(task, task.detectedStack!, this.memory);
    await this.artifacts.writeMemoryRetrieval(pack);
    await this.events.publish(
      task.id,
      "MEMORY_RETRIEVED",
      `Retrieved ${pack.retrievedCount} memory item(s), included ${pack.includedCount}.`,
      {
        retrievedCount: pack.retrievedCount,
        includedCount: pack.includedCount,
        excludedCount: pack.excludedCount,
        conflicts: pack.conflicts,
        agentsToReceiveContext: agents,
      }
    );
    return pack;
  }

  private async analyze(task: Task, agents: AgentType[], contextPack: ContextPack): Promise<SpecialistReport[]> {
    task = await this.setStage(task, "analyzing", "analyzing");
    await this.events.publish(task.id, "AGENT_ANALYSIS_STARTED", `Specialists analyzing: ${agents.map((a) => AGENT_LABELS[a]).join(", ")}`);

    const reports = await Promise.all(
      agents.map(async (agent) => {
        const contract = await loadSpecialistContract(agent);
        const report = await this.executor.analyze({
          agent,
          task,
          detectedStack: task.detectedStack!,
          specialistContract: contract,
          question: buildAnalysisQuestion(agent, task),
          memoryContext: memoryForAgent(agent, contextPack),
        });
        await this.artifacts.writeSpecialistReport(report);
        return report;
      })
    );

    await this.events.publish(task.id, "AGENT_ANALYSIS_COMPLETED", "All specialist analyses completed.", {
      reports: reports.map((r) => ({ agent: r.agent, status: r.status, confidence: r.confidence })),
    });
    return reports;
  }

  private async implement(task: Task, plan: ImplementationPlan): Promise<ExecutionReport> {
    await this.events.publish(task.id, "IMPLEMENTATION_STARTED", `Implementation started (${task.executionMode.toUpperCase()} execution).`);
    const report = await this.executor.implement({ task, plan, detectedStack: task.detectedStack! });
    const tests = await this.executor.runTests({ task, detectedStack: task.detectedStack! });
    report.tests = tests;
    if (tests.some((t) => t.status === "failed")) report.status = "failed";
    await this.artifacts.writeExecutionReport(report);
    await this.events.publish(task.id, "IMPLEMENTATION_COMPLETED", `Implementation ${report.status} — ${report.changedFiles.length} file(s) changed.`, {
      status: report.status,
      changedFiles: report.changedFiles,
      tests,
      diff: report.diff,
    });
    return report;
  }

  private async reviewLoop(
    task: Task,
    plan: ImplementationPlan,
    agents: AgentType[],
    executionReport: ExecutionReport
  ): Promise<{ finalReviews: ReviewReport[]; blocked: boolean; blockReason?: string }> {
    task = await this.setStage(task, "reviewing", "reviewing");

    for (let attempt = 1; attempt <= config.maxReviewRetries + 1; attempt += 1) {
      if (await this.isCancelled(task.id)) return { finalReviews: [], blocked: false };

      await this.events.publish(task.id, "REVIEW_STARTED", `Review attempt ${attempt} started.`, { attempt });

      const reviews = await Promise.all(
        agents.map(async (agent) => {
          const contract = await loadSpecialistContract(agent);
          const review = await this.executor.review({ agent, task, specialistContract: contract, plan, executionReport, attempt });
          await this.artifacts.writeReviewReport(review);
          return review;
        })
      );

      const blockingFindings = reviews.flatMap((r) => r.findings.filter((f) => f.severity === "blocking"));
      await this.events.publish(task.id, "REVIEW_COMPLETED", `Review attempt ${attempt} completed: ${blockingFindings.length} blocking finding(s).`, {
        attempt,
        reviews: reviews.map((r) => ({ agent: r.agent, status: r.status })),
        blockingCount: blockingFindings.length,
      });

      if (blockingFindings.length === 0) {
        task.reviewRetryCount = attempt - 1;
        await this.persist(task);
        return { finalReviews: reviews, blocked: false };
      }

      // A corrective pass can't satisfy two specialists demanding opposite
      // fixes — surface it as a reconciliation conflict and stop looping
      // rather than churning through retries that can never converge
      // (plan section 10/13).
      const reviewConflicts = detectReviewConflicts(reviews);
      if (reviewConflicts.length > 0) {
        await this.appendReconciliationConflicts(task.id, reviewConflicts);
        task.reviewRetryCount = attempt;
        await this.persist(task);
        return {
          finalReviews: reviews,
          blocked: true,
          blockReason: `${reviewConflicts.length} conflicting specialist review finding(s) require developer resolution (see reconciliation.conflicts) before a corrective implementation pass can proceed.`,
        };
      }

      await this.events.publish(task.id, "REVIEW_BLOCKING_ISSUE_FOUND", `${blockingFindings.length} blocking finding(s) returned the task to implementation.`, {
        findings: blockingFindings,
      });

      if (attempt > config.maxReviewRetries) {
        task.reviewRetryCount = attempt;
        await this.persist(task);
        return { finalReviews: reviews, blocked: true };
      }

      task = await this.setStage(task, "implementing", "implementing");
      await this.events.publish(task.id, "IMPLEMENTATION_STARTED", `Corrective implementation pass (attempt ${attempt + 1}).`);
      executionReport = await this.executor.implement({ task, plan, detectedStack: task.detectedStack! });
      const tests = await this.executor.runTests({ task, detectedStack: task.detectedStack! });
      executionReport.tests = tests;
      await this.artifacts.writeExecutionReport(executionReport);
      await this.events.publish(task.id, "IMPLEMENTATION_COMPLETED", `Corrective implementation ${executionReport.status}.`, {
        status: executionReport.status,
        changedFiles: executionReport.changedFiles,
      });
      task = await this.setStage(task, "reviewing", "reviewing");
    }

    return { finalReviews: [], blocked: true };
  }

  private async handoff(
    task: Task,
    plan: ImplementationPlan,
    executionReport: ExecutionReport,
    reviews: ReviewReport[],
    agents: AgentType[]
  ): Promise<Task> {
    const reconciliation = await this.artifacts.readReconciliation(task.id);
    const testsPassed = executionReport.tests.reduce((sum, t) => sum + t.passed, 0);
    const testsFailed = executionReport.tests.reduce((sum, t) => sum + t.failed, 0);
    const reviewsPassed = reviews.filter((r) => r.status === "PASS").length;
    const reviewsFailed = reviews.filter((r) => r.status === "FAIL").length;
    const warnings = reviews.flatMap((r) => r.findings.filter((f) => f.severity === "warning")).length;

    const handoff: FinalHandoff = {
      taskId: task.id,
      summary: plan.summary,
      agentsUsed: agents,
      filesChanged: executionReport.changedFiles.length,
      testsPassed,
      testsFailed,
      reviewsPassed,
      reviewsFailed,
      architectureDecisions: reconciliation?.decisions.length ?? 0,
      warnings,
      executionMode: task.executionMode,
      status: "completed",
      createdAt: new Date().toISOString(),
    };

    const markdown = renderHandoffMarkdown(task, plan, executionReport, reviews, handoff);
    await this.artifacts.writeFinalHandoff(handoff, markdown);

    task.status = "completed";
    task.currentStage = "completed";
    task = await this.persist(task);
    await this.events.publish(task.id, "TASK_COMPLETED", "Task completed. Final handoff generated.", { handoff });

    await this.generateCandidateLessons(task, reconciliation);
    return task;
  }

  /**
   * Only ever runs for a completed task (Phase 29 brief section 14) — never
   * blocked/failed. Candidates are stored with validationStatus "candidate"
   * and never influence retrieval until a human approves them via the
   * memory API; 0 lessons generated is an expected, valid outcome.
   */
  private async generateCandidateLessons(task: Task, reconciliation: Reconciliation | null): Promise<void> {
    const candidates = generateCandidateLessons(task, reconciliation, task.detectedStack!);
    for (const candidate of candidates) {
      await this.memory.add(candidate);
    }
    await this.events.publish(
      task.id,
      "CANDIDATE_LESSONS_GENERATED",
      `${candidates.length} candidate lesson(s) generated for developer review.`,
      { count: candidates.length, ids: candidates.map((c) => c.id) }
    );
  }
}

function describeStack(stack: Task["detectedStack"]): string {
  if (!stack || stack.language === "unknown") return "Unknown";
  const parts = [stack.language === "python" ? "Python" : "Node.js", stack.framework, stack.database].filter(Boolean);
  return parts.join(" + ");
}

function buildAnalysisQuestion(agent: AgentType, task: Task): string {
  if (agent === "database") {
    return `Given the requirement "${task.requirement}", what schema, index, transaction or migration decisions are needed, and what are the risks?`;
  }
  return `Given the requirement "${task.requirement}", how should this be implemented following the repository's existing architecture, and what are the risks?`;
}

function renderHandoffMarkdown(
  task: Task,
  plan: ImplementationPlan,
  executionReport: ExecutionReport,
  reviews: ReviewReport[],
  handoff: FinalHandoff
): string {
  const lines: string[] = [];
  lines.push(`# Final Handoff — ${task.title}`, "");
  lines.push(`**Task ID:** ${task.id}`);
  lines.push(`**Execution mode:** ${task.executionMode === "real" ? "REAL EXECUTION" : "MOCK / SIMULATED EXECUTION"}`);
  lines.push(`**Status:** ${handoff.status}`, "");
  if (task.executionWorkspace?.status === "ready") {
    lines.push(
      `**Isolated branch:** \`${task.executionWorkspace.branch}\` (base \`${task.executionWorkspace.baseRevision.slice(0, 12)}\`) — not merged automatically; review and merge with your own git tooling.`,
      ""
    );
  }
  lines.push("## Summary", "", handoff.summary, "");
  lines.push("## Agents Used", "", ...handoff.agentsUsed.map((a) => `- ${AGENT_LABELS[a]}`), "");
  lines.push("## Files Changed", "", ...(executionReport.changedFiles.length ? executionReport.changedFiles.map((f) => `- ${f}`) : ["(none)"]), "");
  if (executionReport.diff) {
    lines.push("## Diff", "", executionReport.diff.summary, "");
  }
  lines.push("## Tests", "");
  for (const t of executionReport.tests) {
    lines.push(`- \`${t.command}\`: ${t.status} (${t.passed} passed, ${t.failed} failed)`);
  }
  lines.push("");
  lines.push("## Reviews", "");
  for (const r of reviews) {
    lines.push(`- ${AGENT_LABELS[r.agent]}: ${r.status}`);
  }
  lines.push("");
  lines.push("## Architecture Decisions", "", `${handoff.architectureDecisions} decision(s) recorded in reconciliation.json.`, "");
  lines.push("## Warnings", "", `${handoff.warnings} warning(s).`, "");
  lines.push("## Validation Commands", "", ...(plan.validationCommands.length ? plan.validationCommands.map((c) => `- \`${c}\``) : ["(none detected)"]), "");
  return lines.join("\n");
}
