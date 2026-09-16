import { mkdir, readFile, writeFile, appendFile, rename, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
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

  // Reviews are read back from the events/execution flow rather than
  // globbed here; the orchestrator keeps the latest in-memory and persists
  // every attempt for audit. See TaskOrchestrator. Shared between the live
  // `reviews/` directory and an archived `attempts/<n>/reviews/` one.
  private async readReviewsFrom(reviewsDir: string, agents: AgentType[]): Promise<ReviewReport[]> {
    let files: string[] = [];
    try {
      files = await readdir(reviewsDir);
    } catch {
      return [];
    }
    const latestByAgent = new Map<AgentType, ReviewReport>();
    for (const file of files) {
      const raw = await readFile(path.join(reviewsDir, file), "utf-8");
      const report = JSON.parse(raw) as ReviewReport;
      const existing = latestByAgent.get(report.agent);
      if (!existing || report.attempt > existing.attempt) {
        latestByAgent.set(report.agent, report);
      }
    }
    return agents.map((a) => latestByAgent.get(a)).filter((r): r is ReviewReport => r !== undefined);
  }

  readLatestReviews(taskId: string, agents: AgentType[]): Promise<ReviewReport[]> {
    return this.readReviewsFrom(path.join(this.workspaceRoot(taskId), "reviews"), agents);
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

  /**
   * Moves the current attempt's artifacts (everything except `task.json`
   * and `events.log.jsonl`, which are never attempt-scoped — Phase 31
   * proposal §5-6) into `attempts/<attempt>/`, preserving their relative
   * layout so the `readArchived*` methods below can reuse the same relative
   * paths as their live counterparts.
   *
   * Each entry is moved with a single `rename()`. If one throws partway
   * through, entries already moved stay moved (nothing is lost — they are
   * simply findable under `attempts/<attempt>/` on a retried call) and
   * entries not yet reached stay at the top level; the caller
   * (`TaskOrchestrator.retry()`) must not reset `task.json` unless this
   * resolves without throwing, so a retry after a failed archive is safe to
   * attempt again.
   */
  async archiveAttempt(taskId: string, attempt: number): Promise<void> {
    const root = this.workspaceRoot(taskId);
    const attemptDir = path.join(root, "attempts", String(attempt));
    await mkdir(attemptDir, { recursive: true });

    const entries = [
      "specialist-reports",
      "reconciliation.json",
      "implementation-plan.json",
      "execution-report.json",
      "reviews",
      "context",
      "final-handoff.json",
      "final-handoff.md",
    ];

    for (const entry of entries) {
      const src = path.join(root, entry);
      if (!existsSync(src)) continue;
      const dest = path.join(attemptDir, entry);
      await rename(src, dest);
    }
  }

  /** Attempt numbers with archived artifacts, ascending. */
  async listAttempts(taskId: string): Promise<number[]> {
    const attemptsDir = path.join(this.workspaceRoot(taskId), "attempts");
    let entries: string[];
    try {
      entries = await readdir(attemptsDir);
    } catch {
      return [];
    }
    return entries
      .map((e) => Number(e))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b);
  }

  /**
   * The furthest pipeline stage an archived attempt's artifacts show it
   * reached (Phase 34) — a `STAGE_SEQUENCE`-compatible key
   * (`analyzing`/`reconciling`/`planning`/`implementing`/`reviewing`/
   * `completed`), or `"early"` if not even specialist reports exist yet.
   *
   * Deliberately does **not** attempt to say whether the attempt ended
   * `failed`/`blocked`/`cancelled` — that status is never archived (Phase
   * 31 §5-6: only `task.json`/`events.log.jsonl` are excluded from
   * archiving, and `task.json` is never duplicated per-attempt in the first
   * place), so claiming a specific terminal status here would be inventing
   * a fact the platform doesn't actually have for a past attempt. Which
   * stage was reached, in contrast, is directly provable from which files
   * exist — cheap existence checks only, no JSON parsing needed.
   */
  async describeArchivedAttempt(taskId: string, attempt: number): Promise<string> {
    const attemptDir = path.join(this.workspaceRoot(taskId), "attempts", String(attempt));
    const fileExists = (relative: string) => existsSync(path.join(attemptDir, relative));
    const dirHasFiles = async (relative: string): Promise<boolean> => {
      try {
        return (await readdir(path.join(attemptDir, relative))).length > 0;
      } catch {
        return false;
      }
    };

    if (fileExists("final-handoff.json")) return "completed";
    if (await dirHasFiles("reviews")) return "reviewing";
    if (fileExists("execution-report.json")) return "implementing";
    if (fileExists("implementation-plan.json")) return "planning";
    if (fileExists("reconciliation.json")) return "reconciling";
    if (await dirHasFiles("specialist-reports")) return "analyzing";
    return "early";
  }

  readArchivedSpecialistReports(taskId: string, attempt: number, agents: AgentType[]): Promise<SpecialistReport[]> {
    return Promise.all(
      agents.map((agent) => this.readJson<SpecialistReport>(taskId, `attempts/${attempt}/specialist-reports/specialist-${agent}.json`))
    ).then((reports) => reports.filter((r): r is SpecialistReport => r !== null));
  }

  readArchivedReconciliation(taskId: string, attempt: number): Promise<Reconciliation | null> {
    return this.readJson<Reconciliation>(taskId, `attempts/${attempt}/reconciliation.json`);
  }

  readArchivedImplementationPlan(taskId: string, attempt: number): Promise<ImplementationPlan | null> {
    return this.readJson<ImplementationPlan>(taskId, `attempts/${attempt}/implementation-plan.json`);
  }

  readArchivedExecutionReport(taskId: string, attempt: number): Promise<ExecutionReport | null> {
    return this.readJson<ExecutionReport>(taskId, `attempts/${attempt}/execution-report.json`);
  }

  readArchivedReviews(taskId: string, attempt: number, agents: AgentType[]): Promise<ReviewReport[]> {
    return this.readReviewsFrom(path.join(this.workspaceRoot(taskId), "attempts", String(attempt), "reviews"), agents);
  }

  readArchivedFinalHandoff(taskId: string, attempt: number): Promise<FinalHandoff | null> {
    return this.readJson<FinalHandoff>(taskId, `attempts/${attempt}/final-handoff.json`);
  }

  async readArchivedFinalHandoffMarkdown(taskId: string, attempt: number): Promise<string | null> {
    const root = this.workspaceRoot(taskId);
    try {
      return await readFile(resolveWithinRoot(root, `attempts/${attempt}/final-handoff.md`), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}
