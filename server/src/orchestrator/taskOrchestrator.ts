import { config } from "../config.js";
import type { TaskStore } from "../store/taskStore.js";
import { ArtifactStore } from "../artifacts/artifactStore.js";
import { TaskEventBus } from "../events/eventBus.js";
import type { ClaudeCodeExecutor } from "../execution/ClaudeCodeExecutor.js";
import { loadSpecialistContract, AGENT_LABELS } from "../agents/specialistContracts.js";
import { inspectRepository } from "./repositoryInspector.js";
import { routeTask } from "./routingEngine.js";
import { reconcile } from "./reconciliation.js";
import { buildImplementationPlan } from "./implementationPlan.js";
import type {
  AgentType,
  ExecutionReport,
  FinalHandoff,
  ImplementationPlan,
  ReviewReport,
  SpecialistReport,
  Task,
} from "../types/index.js";

/**
 * Coordinates the full pipeline described in orchestrator/ORCHESTRATOR.md:
 * inspect -> route -> analyze -> reconcile -> plan -> implement -> review ->
 * handoff. Owns workflow-state transitions (ORCHESTRATOR.md responsibility
 * #1-10); specialists and the executor contribute bounded artifacts.
 */
export class TaskOrchestrator {
  constructor(
    private readonly taskStore: TaskStore,
    private readonly artifacts: ArtifactStore,
    private readonly events: TaskEventBus,
    private readonly executor: ClaudeCodeExecutor
  ) {}

  async run(taskId: string): Promise<void> {
    let task = await this.taskStore.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    try {
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

      const reports = await this.analyze(task, routing.agents);
      task = await this.setStage(task, "reconciling", "reconciling");
      await this.events.publish(task.id, "RECONCILIATION_STARTED", "Reconciling specialist recommendations.");
      const reconciliation = reconcile(task.id, reports, routing);
      await this.artifacts.writeReconciliation(reconciliation);
      await this.events.publish(task.id, "RECONCILIATION_COMPLETED", `Reconciliation status: ${reconciliation.status}`, {
        status: reconciliation.status,
        confidencePercent: reconciliation.confidencePercent,
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

      task = await this.setStage(task, "planning", "planning");
      const plan = buildImplementationPlan(task, task.detectedStack!, reconciliation, routing.agents);
      await this.artifacts.writeImplementationPlan(plan);
      await this.events.publish(task.id, "IMPLEMENTATION_PLAN_CREATED", `Implementation plan created (${plan.files.length} files).`, {
        files: plan.files,
      });

      task = await this.setStage(task, "implementing", "implementing");
      let executionReport = await this.implement(task, plan);

      const { finalReviews, blocked } = await this.reviewLoop(task, plan, routing.agents, executionReport);
      if (blocked) {
        await this.block(task, "Review loop exceeded the maximum retry count with unresolved blocking findings.");
        return;
      }

      task = await this.handoff(task, plan, executionReport, finalReviews, routing.agents);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = await this.taskStore.get(taskId);
      if (failed) {
        failed.status = "failed";
        failed.error = message;
        failed.updatedAt = new Date().toISOString();
        await this.persist(failed);
      }
      await this.events.publish(taskId, "TASK_FAILED", `Task failed: ${message}`);
    }
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

  private async analyze(task: Task, agents: AgentType[]): Promise<SpecialistReport[]> {
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
    });
    return report;
  }

  private async reviewLoop(
    task: Task,
    plan: ImplementationPlan,
    agents: AgentType[],
    executionReport: ExecutionReport
  ): Promise<{ finalReviews: ReviewReport[]; blocked: boolean }> {
    task = await this.setStage(task, "reviewing", "reviewing");

    for (let attempt = 1; attempt <= config.maxReviewRetries + 1; attempt += 1) {
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
    return task;
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
  lines.push("## Summary", "", handoff.summary, "");
  lines.push("## Agents Used", "", ...handoff.agentsUsed.map((a) => `- ${AGENT_LABELS[a]}`), "");
  lines.push("## Files Changed", "", ...(executionReport.changedFiles.length ? executionReport.changedFiles.map((f) => `- ${f}`) : ["(none)"]), "");
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
