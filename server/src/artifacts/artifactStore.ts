import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { resolveWithinRoot } from "../utils/paths.js";
import type {
  AgentType,
  ExecutionReport,
  FinalHandoff,
  ImplementationPlan,
  Reconciliation,
  ReviewReport,
  SpecialistReport,
  Task,
  TaskEvent,
} from "../types/index.js";
import type { ContextPack } from "../memory/contextPack.js";

/**
 * Reads and writes the task workspace exactly as laid out in
 * claude-code-platform-architecture-v0.1/workspaces/TASK-WORKSPACE.md and
 * named per protocols/artifact-contracts.json. This is the durable,
 * inspectable record of a task — the UI reads these same files back through
 * the API rather than a separate parallel representation.
 */
export class ArtifactStore {
  private workspaceRoot(taskId: string): string {
    return path.join(config.tasksDir, taskId);
  }

  async ensureWorkspace(taskId: string): Promise<void> {
    const root = this.workspaceRoot(taskId);
    await mkdir(root, { recursive: true });
    await mkdir(path.join(root, "context"), { recursive: true });
    await mkdir(path.join(root, "specialist-reports"), { recursive: true });
    await mkdir(path.join(root, "reviews"), { recursive: true });
  }

  private async writeJson(taskId: string, relativePath: string, data: unknown): Promise<void> {
    const root = this.workspaceRoot(taskId);
    const target = resolveWithinRoot(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(data, null, 2), "utf-8");
  }

  private async readJson<T>(taskId: string, relativePath: string): Promise<T | null> {
    const root = this.workspaceRoot(taskId);
    const target = resolveWithinRoot(root, relativePath);
    try {
      const raw = await readFile(target, "utf-8");
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  writeTask(task: Task): Promise<void> {
    return this.writeJson(task.id, "task.json", task);
  }

  readTask(taskId: string): Promise<Task | null> {
    return this.readJson<Task>(taskId, "task.json");
  }

  writeSpecialistReport(report: SpecialistReport): Promise<void> {
    return this.writeJson(report.taskId, `specialist-reports/specialist-${report.agent}.json`, report);
  }

  async readSpecialistReports(taskId: string, agents: AgentType[]): Promise<SpecialistReport[]> {
    const reports = await Promise.all(
      agents.map((agent) => this.readJson<SpecialistReport>(taskId, `specialist-reports/specialist-${agent}.json`))
    );
    return reports.filter((r): r is SpecialistReport => r !== null);
  }

  writeReconciliation(reconciliation: Reconciliation): Promise<void> {
    return this.writeJson(reconciliation.taskId, "reconciliation.json", reconciliation);
  }

  readReconciliation(taskId: string): Promise<Reconciliation | null> {
    return this.readJson<Reconciliation>(taskId, "reconciliation.json");
  }

  writeImplementationPlan(plan: ImplementationPlan): Promise<void> {
    return this.writeJson(plan.taskId, "implementation-plan.json", plan);
  }

  readImplementationPlan(taskId: string): Promise<ImplementationPlan | null> {
    return this.readJson<ImplementationPlan>(taskId, "implementation-plan.json");
  }

  writeExecutionReport(report: ExecutionReport): Promise<void> {
    return this.writeJson(report.taskId, "execution-report.json", report);
  }

  readExecutionReport(taskId: string): Promise<ExecutionReport | null> {
    return this.readJson<ExecutionReport>(taskId, "execution-report.json");
  }

  writeReviewReport(report: ReviewReport): Promise<void> {
    return this.writeJson(report.taskId, `reviews/review-${report.agent}-attempt-${report.attempt}.json`, report);
  }

  async readLatestReviews(taskId: string, agents: AgentType[]): Promise<ReviewReport[]> {
    // Reviews are read back from the events/execution flow rather than
    // globbed here; the orchestrator keeps the latest in-memory and persists
    // every attempt for audit. See TaskOrchestrator.
    const root = this.workspaceRoot(taskId);
    const { readdir } = await import("node:fs/promises");
    let files: string[] = [];
    try {
      files = await readdir(path.join(root, "reviews"));
    } catch {
      return [];
    }
    const latestByAgent = new Map<AgentType, ReviewReport>();
    for (const file of files) {
      const raw = await readFile(path.join(root, "reviews", file), "utf-8");
      const report = JSON.parse(raw) as ReviewReport;
      const existing = latestByAgent.get(report.agent);
      if (!existing || report.attempt > existing.attempt) {
        latestByAgent.set(report.agent, report);
      }
    }
    return agents.map((a) => latestByAgent.get(a)).filter((r): r is ReviewReport => r !== undefined);
  }

  async writeFinalHandoff(handoff: FinalHandoff, markdown: string): Promise<void> {
    await this.writeJson(handoff.taskId, "final-handoff.json", handoff);
    const root = this.workspaceRoot(handoff.taskId);
    await writeFile(resolveWithinRoot(root, "final-handoff.md"), markdown, "utf-8");
  }

  async readFinalHandoffMarkdown(taskId: string): Promise<string | null> {
    const root = this.workspaceRoot(taskId);
    try {
      return await readFile(resolveWithinRoot(root, "final-handoff.md"), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  readFinalHandoff(taskId: string): Promise<FinalHandoff | null> {
    return this.readJson<FinalHandoff>(taskId, "final-handoff.json");
  }

  async appendEvent(event: TaskEvent): Promise<void> {
    const root = this.workspaceRoot(event.taskId);
    await mkdir(root, { recursive: true });
    const target = resolveWithinRoot(root, "events.log.jsonl");
    await appendFile(target, JSON.stringify(event) + "\n", "utf-8");
  }

  async readEvents(taskId: string): Promise<TaskEvent[]> {
    const root = this.workspaceRoot(taskId);
    try {
      const raw = await readFile(resolveWithinRoot(root, "events.log.jsonl"), "utf-8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TaskEvent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  writeMemoryRetrieval(pack: ContextPack): Promise<void> {
    return this.writeJson(pack.taskId, "context/memory-retrieval.json", pack);
  }

  readMemoryRetrieval(taskId: string): Promise<ContextPack | null> {
    return this.readJson<ContextPack>(taskId, "context/memory-retrieval.json");
  }

  async writeContextSnapshot(taskId: string, filename: string, content: string): Promise<void> {
    const root = this.workspaceRoot(taskId);
    const target = resolveWithinRoot(root, path.join("context", filename));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf-8");
  }
}
