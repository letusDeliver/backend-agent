import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { TaskService } from '../../services/task.service';
import {
  AGENT_LABELS,
  AgentType,
  AttemptSummary,
  ContextPack,
  ExecutionReport,
  FinalHandoff,
  ImplementationPlan,
  Reconciliation,
  ReconciliationConflict,
  ReviewReport,
  SpecialistReport,
  Task,
  TaskEvent,
} from '../../models/task.model';

/**
 * 'stopped' (Phase 34) replaces the old 'blocked' state name — it now marks
 * the stage a task stopped at for `blocked`, `failed`, *and* `cancelled`
 * tasks alike (previously only `blocked`/`failed` were handled, and even
 * then incorrectly — see `stageState()`), so a name scoped to one status
 * would be misleading.
 */
type StageState = 'done' | 'active' | 'pending' | 'stopped';

interface StageDef {
  key: string;
  label: string;
}

const STAGE_SEQUENCE: StageDef[] = [
  { key: 'created', label: 'Task created' },
  { key: 'inspecting', label: 'Repository inspected' },
  { key: 'routing', label: 'Specialists selected' },
  { key: 'analyzing', label: 'Specialists analyzing' },
  { key: 'reconciling', label: 'Reconciliation' },
  { key: 'planning', label: 'Implementation plan' },
  { key: 'implementing', label: 'Implementation' },
  { key: 'reviewing', label: 'Review' },
  { key: 'completed', label: 'Final handoff' },
];

const ALL_AGENTS: AgentType[] = ['python-backend', 'node-backend', 'database'];

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'blocked', 'cancelled']);

/**
 * Phase 40: every timing figure on this page is derived purely from
 * `TaskEvent.createdAt` timestamps already produced by the backend (or, for
 * specialists, from `SpecialistReport.createdAt`) — no new backend field,
 * no new event. Some stage-start/complete event pairs can recur within one
 * task (IMPLEMENTATION_STARTED/COMPLETED across corrective review passes or
 * backlog subtasks, REVIEW_STARTED/COMPLETED across review attempts), so
 * this sums every paired occurrence rather than assuming exactly one.
 */
function sumPairedDurationsMs(events: TaskEvent[], startType: string, completeType: string): number | null {
  let total = 0;
  let startedAt: number | null = null;
  let sawAnyPair = false;
  for (const e of events) {
    const t = new Date(e.createdAt).getTime();
    if (e.type === startType) {
      startedAt = t;
    } else if (e.type === completeType && startedAt !== null) {
      total += t - startedAt;
      startedAt = null;
      sawAnyPair = true;
    }
  }
  return sawAnyPair ? total : null;
}

function timestampOf(events: TaskEvent[], type: string): number | null {
  const found = events.find((e) => e.type === type);
  return found ? new Date(found.createdAt).getTime() : null;
}

/** Human-readable duration ("340ms", "2.1s", "1m 05s") for a small timing badge. */
function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

/**
 * Statuses Retry is offered for (Phase 31). Deliberately the same set as
 * `TaskOrchestrator.RETRYABLE_STATUSES` on the server — kept as a separate
 * constant from `TERMINAL_STATUSES` since Retry and Cancel are different
 * affordances for different statuses (a terminal task can be retried; a
 * non-terminal one can be cancelled — the two sets happen to be related but
 * are not the same thing conceptually).
 */
const RETRYABLE_STATUSES = new Set(['failed', 'blocked', 'cancelled']);

/**
 * Statuses Workspace Cleanup is offered for (Phase 32). Deliberately
 * excludes 'blocked' — Phase 30's conflict-resolution resume path reuses
 * the exact same worktree, so cleanup must never be offered there, unlike
 * Retry which is offered for 'blocked' too. Kept as its own constant
 * rather than reusing RETRYABLE_STATUSES for that reason. Mirrors
 * `TaskOrchestrator.WORKSPACE_CLEANUP_ELIGIBLE_STATUSES` on the server.
 */
const WORKSPACE_CLEANUP_ELIGIBLE_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Statuses the new Outcome summary (Phase 34) is shown for — every terminal status except the already-well-covered `completed`. */
const NON_SUCCESS_STATUSES = new Set(['failed', 'blocked', 'cancelled']);

/** Natural-language "stopped during ___" phrasing per stage key, for the Outcome summary (Phase 34). Deliberately separate from STAGE_SEQUENCE's timeline labels, which are completion-oriented ("Reconciliation", "Implementation") rather than "during ___"-shaped. */
const STAGE_STOPPED_DESCRIPTIONS: Record<string, string> = {
  created: 'before starting',
  inspecting: 'repository inspection',
  routing: 'specialist routing',
  analyzing: 'specialist analysis',
  reconciling: 'reconciliation',
  planning: 'planning',
  implementing: 'implementation',
  reviewing: 'review',
  completed: 'handoff',
};

@Component({
    selector: 'app-task-detail',
    imports: [CommonModule, RouterLink],
    templateUrl: './task-detail.component.html',
    styleUrl: './task-detail.component.css',
})
export class TaskDetailComponent implements OnInit, OnDestroy {
  readonly allAgents = ALL_AGENTS;
  readonly agentLabels = AGENT_LABELS;
  readonly stages = STAGE_SEQUENCE;

  readonly task = signal<Task | null>(null);
  readonly events = signal<TaskEvent[]>([]);
  readonly specialistReports = signal<SpecialistReport[]>([]);
  readonly memoryPack = signal<ContextPack | null>(null);
  readonly reconciliation = signal<Reconciliation | null>(null);
  readonly plan = signal<ImplementationPlan | null>(null);
  readonly executionReport = signal<ExecutionReport | null>(null);
  readonly reviews = signal<ReviewReport[]>([]);
  readonly handoff = signal<FinalHandoff | null>(null);
  readonly handoffMarkdown = signal<string | null>(null);
  readonly loading = signal(true);
  readonly notFound = signal(false);
  readonly showActivityLog = signal(false);
  readonly cancelling = signal(false);
  readonly resolvingConflictId = signal<string | null>(null);
  readonly conflictDraft = signal<Record<string, string>>({});

  readonly retrying = signal(false);
  readonly attempts = signal<number[]>([]);
  readonly attemptSummaries = signal<AttemptSummary[]>([]);
  readonly selectedAttempt = signal<number | null>(null);
  readonly attemptAgents = signal<SpecialistReport[]>([]);
  readonly attemptReconciliation = signal<Reconciliation | null>(null);
  readonly attemptPlan = signal<ImplementationPlan | null>(null);
  readonly attemptExecutionReport = signal<ExecutionReport | null>(null);
  readonly attemptReviews = signal<ReviewReport[]>([]);
  readonly attemptHandoff = signal<FinalHandoff | null>(null);

  readonly cleaningUp = signal(false);
  readonly confirmingCleanup = signal(false);

  readonly isTerminal = computed(() => {
    const task = this.task();
    return !task || TERMINAL_STATUSES.has(task.status);
  });

  readonly canRetry = computed(() => {
    const task = this.task();
    return !!task && RETRYABLE_STATUSES.has(task.status);
  });

  readonly canCleanupWorkspace = computed(() => {
    const task = this.task();
    if (!task || task.executionMode !== 'real') return false;
    const workspace = task.executionWorkspace;
    if (!workspace || workspace.status !== 'ready') return false;
    if (workspace.cleanupStatus === 'cleaned') return false;
    return WORKSPACE_CLEANUP_ELIGIBLE_STATUSES.has(task.status);
  });

  readonly blockingFindingsCount = computed(
    () => this.reviews().flatMap((r) => r.findings.filter((f) => f.severity === 'blocking')).length
  );
  readonly warningFindingsCount = computed(
    () => this.reviews().flatMap((r) => r.findings.filter((f) => f.severity === 'warning')).length
  );

  /**
   * Outcome summary (Phase 34) — shown only for the three non-success
   * terminal statuses. `completed` already has a rich Final Handoff
   * section; a live/in-progress task has its own timeline/panels.
   */
  readonly isNonSuccessTerminal = computed(() => {
    const task = this.task();
    return !!task && NON_SUCCESS_STATUSES.has(task.status);
  });

  readonly hasUnresolvedMaterialConflict = computed(() =>
    (this.reconciliation()?.conflicts ?? []).some((c) => c.materiality === 'material' && !c.resolution)
  );

  /**
   * A single deterministic sentence built only from persisted status +
   * currentStage — never an inferred root cause (Phase 34 §14). The
   * detailed reason (`task.error`) is already shown in the error banner
   * above this section, so this sentence adds the one fact that banner
   * doesn't carry: which stage the task actually stopped at.
   */
  readonly outcomeWhatHappened = computed(() => {
    const task = this.task();
    if (!task) return '';
    const stageDescription = STAGE_STOPPED_DESCRIPTIONS[task.currentStage] ?? task.currentStage;
    switch (task.status) {
      case 'failed':
        return `Task failed during ${stageDescription}.`;
      case 'cancelled':
        return `Task was cancelled during ${stageDescription}.`;
      case 'blocked':
        return `Task is blocked at ${stageDescription}.`;
      default:
        return '';
    }
  });

  /** Which already-fetched panels actually have data for this task — computed, never assumed. */
  readonly outcomeAvailablePanels = computed(() => {
    const panels: string[] = [];
    if (this.specialistReports().length) panels.push(`Specialist reports (${this.specialistReports().length})`);
    if (this.reconciliation()) panels.push('Reconciliation');
    if (this.plan()) panels.push('Implementation plan');
    if (this.executionReport()) panels.push('Execution report' + (this.executionReport()?.diff ? ' & diff' : ''));
    if (this.reviews().length) panels.push(`Reviews (${this.reviews().length})`);
    return panels;
  });

  /**
   * Next-action bullets (Phase 34) — every entry here mirrors an action
   * that's already offered elsewhere on this page (Retry button, conflict
   * resolve form, Cleanup Workspace button); this list never invents a new
   * affordance, it only tells the developer such a button already exists
   * below (§16 — reuse existing eligibility logic, don't duplicate it).
   */
  readonly outcomeNextActions = computed(() => {
    const actions: string[] = [];
    if (this.task()?.status === 'blocked' && this.hasUnresolvedMaterialConflict()) {
      actions.push('Resolve the conflict below to let this task resume.');
    }
    if (this.canRetry()) {
      actions.push('Retry — restarts from repository inspection, picking up any fix you made.');
    }
    if (this.canCleanupWorkspace()) {
      actions.push('Clean up the isolated workspace below once you no longer need it.');
    }
    return actions;
  });

  private readonly destroyed$ = new Subject<void>();
  private taskId = '';

  constructor(
    private readonly route: ActivatedRoute,
    private readonly taskService: TaskService
  ) {}

  ngOnInit(): void {
    this.taskId = this.route.snapshot.paramMap.get('id') ?? '';
    if (!this.taskId) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    this.loadTask();
    this.taskService
      .watchEvents(this.taskId)
      .pipe(takeUntil(this.destroyed$))
      .subscribe((event) => this.onEvent(event));
  }

  ngOnDestroy(): void {
    this.destroyed$.next();
    this.destroyed$.complete();
  }

  private loadTask(): void {
    this.taskService.getTask(this.taskId).subscribe({
      next: ({ task }) => {
        this.task.set(task);
        this.loading.set(false);
        this.refreshPanelsFor(task);
      },
      error: () => {
        this.notFound.set(true);
        this.loading.set(false);
      },
    });
    this.taskService.listAttempts(this.taskId).subscribe(({ attempts, attemptSummaries }) => {
      this.attempts.set(attempts);
      this.attemptSummaries.set(attemptSummaries ?? []);
    });
  }

  private onEvent(event: TaskEvent): void {
    this.events.update((events) => [...events, event]);
    this.loadTask();
  }

  /** Index of `stageKey` within `STAGE_SEQUENCE`, or -1 if not a real pipeline stage. */
  private stageIndex(stageKey: string): number {
    return STAGE_SEQUENCE.findIndex((s) => s.key === stageKey);
  }

  /** How many backlog steps (Phase 39) have completed so far, for the section heading. */
  subtasksCompletedCount(): number {
    return this.task()?.subtasks?.filter((s) => s.status === 'completed').length ?? 0;
  }

  subtaskBadgeColor(status: string): string {
    switch (status) {
      case 'completed':
        return 'green';
      case 'blocked':
      case 'failed':
        return 'red';
      case 'implementing':
      case 'reviewing':
        return 'blue';
      default:
        return 'neutral';
    }
  }

  /**
   * Gates each artifact fetch on how far the task's own `currentStage`
   * actually got — not on `task.status` (Phase 34 fix). Before this fix,
   * `blocked` was hardcoded into every conditional (regardless of whether
   * that artifact could possibly exist yet) while `failed`/`cancelled` were
   * hardcoded out of all of them (even when the artifact genuinely existed
   * on disk) — an inconsistency with no basis in what data actually exists.
   * Since `currentStage` is now always a real, trustworthy stage name for
   * every status (see `TaskOrchestrator.block()`/the cancel route), a
   * single stage-index comparison replaces all four hand-picked status
   * lists and is correct for every status, live or terminal, uniformly.
   * Fetching slightly "optimistically" (e.g. right as a live task enters a
   * stage, just before that stage's artifact is written) is safe — every
   * consumer already renders `null`/empty results gracefully.
   */
  private refreshPanelsFor(task: Task): void {
    const reachedIndex = this.stageIndex(task.currentStage);
    if (reachedIndex <= this.stageIndex('inspecting')) return;

    this.taskService.getAgents(task.id).subscribe(({ reports }) => this.specialistReports.set(reports));
    this.taskService.getTaskMemory(task.id).subscribe(({ contextPack }) => this.memoryPack.set(contextPack));

    const atOrPast = (stageKey: string) => reachedIndex >= this.stageIndex(stageKey);

    if (atOrPast('reconciling')) {
      this.taskService.getReconciliation(task.id).subscribe(({ reconciliation }) => this.reconciliation.set(reconciliation));
    }
    if (atOrPast('planning')) {
      this.taskService.getImplementationPlan(task.id).subscribe(({ plan }) => this.plan.set(plan));
    }
    if (atOrPast('implementing')) {
      this.taskService.getExecutionReport(task.id).subscribe(({ report }) => this.executionReport.set(report));
    }
    if (atOrPast('reviewing')) {
      this.taskService.getReviews(task.id).subscribe(({ reviews }) => this.reviews.set(reviews));
    }
    // Handoff stays gated on status, not stage: reaching/passing the
    // "reviewing" stage doesn't imply success — only task.status ===
    // 'completed' means a handoff was actually generated (never for
    // failed/blocked tasks, even ones that got all the way through review).
    if (task.status === 'completed') {
      this.taskService.getHandoff(task.id).subscribe(({ handoff, markdown }) => {
        this.handoff.set(handoff);
        this.handoffMarkdown.set(markdown);
      });
    }
  }

  /**
   * Always keyed off `task.currentStage`, which is now trustworthy for
   * every status (Phase 34 fix). Previously this branched on `task.status`
   * for failed/blocked using `currentStage`, but `currentStage` held the
   * synthetic string "blocked" for blocked tasks (never a real stage), so
   * `reachedIndex` was always -1 and every stage silently rendered
   * 'pending' — the dedicated "stopped here" marker was unreachable.
   */
  stageState(stage: StageDef): StageState {
    const task = this.task();
    if (!task) return 'pending';
    const sequenceIndex = this.stageIndex(stage.key);
    const reachedIndex = this.stageIndex(task.currentStage);

    if (sequenceIndex < reachedIndex) return 'done';
    if (sequenceIndex > reachedIndex) return 'pending';

    switch (task.status) {
      case 'completed':
        return 'done';
      case 'blocked':
      case 'failed':
      case 'cancelled':
        return 'stopped';
      default:
        return 'active';
    }
  }

  specialistFor(agent: AgentType): SpecialistReport | undefined {
    return this.specialistReports().find((r) => r.agent === agent);
  }

  /**
   * Phase 41: filters the same generic `events` signal every other panel
   * on this page already reads — live streaming needed no new transport,
   * since SSE already refetches on every event; this just recognizes one
   * more event type and renders it as a scrolling log instead of adding a
   * new subscription or polling mechanism.
   */
  implementationProgressEvents(): TaskEvent[] {
    return this.events().filter((e) => e.type === 'IMPLEMENTATION_PROGRESS');
  }

  progressIcon(event: TaskEvent): string {
    const tool = (event.data as { tool?: string } | undefined)?.tool;
    switch (tool) {
      case 'Write':
        return '📝';
      case 'Edit':
        return '✏️';
      case 'Bash':
        return '▶';
      case 'Read':
        return '👁';
      default:
        return tool ? '🔧' : '💬';
    }
  }

  /**
   * Phase 40: how long a completed/active stage actually took, derived
   * entirely from existing event timestamps — no backend change. Returns
   * `null` when the stage hasn't started, or has no defined timing pair
   * (`created`/`completed` are markers, not timed spans).
   */
  stageDurationLabel(stageKey: string): string | null {
    const events = this.events();
    if (events.length === 0) return null;
    let ms: number | null = null;

    switch (stageKey) {
      case 'inspecting':
        ms = sumPairedDurationsMs(events, 'REPOSITORY_INSPECTION_STARTED', 'REPOSITORY_INSPECTION_COMPLETED');
        break;
      case 'routing': {
        const start = timestampOf(events, 'REPOSITORY_INSPECTION_COMPLETED');
        const end = timestampOf(events, 'AGENT_SELECTED');
        ms = start !== null && end !== null ? end - start : null;
        break;
      }
      case 'analyzing':
        ms = sumPairedDurationsMs(events, 'AGENT_ANALYSIS_STARTED', 'AGENT_ANALYSIS_COMPLETED');
        break;
      case 'reconciling':
        ms = sumPairedDurationsMs(events, 'RECONCILIATION_STARTED', 'RECONCILIATION_COMPLETED');
        break;
      case 'planning': {
        const start = timestampOf(events, 'RECONCILIATION_COMPLETED');
        const end = timestampOf(events, 'IMPLEMENTATION_PLAN_CREATED');
        ms = start !== null && end !== null ? end - start : null;
        break;
      }
      case 'implementing':
        ms = sumPairedDurationsMs(events, 'IMPLEMENTATION_STARTED', 'IMPLEMENTATION_COMPLETED');
        break;
      case 'reviewing':
        ms = sumPairedDurationsMs(events, 'REVIEW_STARTED', 'REVIEW_COMPLETED');
        break;
      default:
        return null;
    }

    return ms !== null && ms >= 0 ? formatDurationMs(ms) : null;
  }

  /** How long a specialist's own analysis took, from the shared analysis-started event to that agent's own report timestamp. */
  specialistDurationLabel(agent: AgentType): string | null {
    const report = this.specialistFor(agent);
    if (!report) return null;
    const started = timestampOf(this.events(), 'AGENT_ANALYSIS_STARTED');
    if (started === null) return null;
    const ms = new Date(report.createdAt).getTime() - started;
    return ms >= 0 ? formatDurationMs(ms) : null;
  }

  /** Wall-clock time elapsed so far, from task creation to the latest known event — updates as new events arrive. */
  totalElapsedLabel(): string | null {
    const task = this.task();
    const events = this.events();
    if (!task) return null;
    const start = new Date(task.createdAt).getTime();
    const latest = events.length > 0 ? new Date(events[events.length - 1].createdAt).getTime() : new Date(task.updatedAt).getTime();
    const ms = latest - start;
    return ms >= 0 ? formatDurationMs(ms) : null;
  }

  reviewFor(agent: AgentType): ReviewReport | undefined {
    return this.reviews().find((r) => r.agent === agent);
  }

  ownerLabel(owner: AgentType | 'orchestrator'): string {
    return owner === 'orchestrator' ? 'Orchestrator' : AGENT_LABELS[owner];
  }

  isFileChanged(path: string): boolean {
    return this.executionReport()?.changedFiles.includes(path) ?? false;
  }

  toggleActivityLog(): void {
    this.showActivityLog.update((v) => !v);
  }

  cancelTask(): void {
    if (this.cancelling() || this.isTerminal()) return;
    this.cancelling.set(true);
    this.taskService.cancelTask(this.taskId).subscribe({
      next: ({ task }) => {
        this.task.set(task);
        this.cancelling.set(false);
      },
      error: () => this.cancelling.set(false),
    });
  }

  conflictDraftFor(conflictId: string): string {
    return this.conflictDraft()[conflictId] ?? '';
  }

  setConflictDraft(conflictId: string, value: string): void {
    this.conflictDraft.update((draft) => ({ ...draft, [conflictId]: value }));
  }

  resolveConflict(conflict: ReconciliationConflict): void {
    const resolution = this.conflictDraftFor(conflict.id).trim();
    if (!resolution || this.resolvingConflictId()) return;
    this.resolvingConflictId.set(conflict.id);
    this.taskService.resolveConflict(this.taskId, conflict.id, { resolution }).subscribe({
      next: ({ reconciliation }) => {
        this.reconciliation.set(reconciliation);
        this.resolvingConflictId.set(null);
        this.loadTask();
      },
      error: () => this.resolvingConflictId.set(null),
    });
  }

  retryTask(): void {
    if (this.retrying() || !this.canRetry()) return;
    this.retrying.set(true);
    this.taskService.retryTask(this.taskId).subscribe({
      next: ({ task }) => {
        this.task.set(task);
        this.retrying.set(false);
        this.selectedAttempt.set(null);
        this.loadTask();
      },
      error: () => this.retrying.set(false),
    });
  }

  requestCleanupWorkspace(): void {
    if (this.cleaningUp() || !this.canCleanupWorkspace()) return;
    this.confirmingCleanup.set(true);
  }

  cancelCleanupConfirmation(): void {
    this.confirmingCleanup.set(false);
  }

  confirmCleanupWorkspace(): void {
    if (this.cleaningUp() || !this.canCleanupWorkspace()) return;
    this.cleaningUp.set(true);
    this.confirmingCleanup.set(false);
    this.taskService.cleanupWorkspace(this.taskId).subscribe({
      next: ({ task }) => {
        this.task.set(task);
        this.cleaningUp.set(false);
      },
      error: () => {
        this.cleaningUp.set(false);
        // A failed cleanup is recorded server-side on
        // executionWorkspace.cleanupStatus/cleanupError — reload to show it.
        this.loadTask();
      },
    });
  }

  /**
   * A one-line outcome for an archived attempt, shown without requiring
   * expansion (Phase 34 §17). Derived only from `reachedStage` — which
   * artifact files exist for that attempt — never a guessed terminal
   * status, since `failed`/`blocked`/`cancelled` are never archived
   * per-attempt (only `task.json`'s live copy has that, and it's
   * overwritten on every retry).
   */
  attemptOutcomeLabel(attempt: number): string {
    const summary = this.attemptSummaries().find((s) => s.attempt === attempt);
    if (!summary) return '';
    if (summary.reachedStage === 'completed') return 'Completed';
    if (summary.reachedStage === 'early') return 'Stopped early';
    const description = STAGE_STOPPED_DESCRIPTIONS[summary.reachedStage] ?? summary.reachedStage;
    return `Stopped during ${description}`;
  }

  toggleAttemptView(attempt: number): void {
    if (this.selectedAttempt() === attempt) {
      this.selectedAttempt.set(null);
      return;
    }
    this.selectedAttempt.set(attempt);
    this.attemptAgents.set([]);
    this.attemptReconciliation.set(null);
    this.attemptPlan.set(null);
    this.attemptExecutionReport.set(null);
    this.attemptReviews.set([]);
    this.attemptHandoff.set(null);

    this.taskService.getAttemptAgents(this.taskId, attempt).subscribe(({ reports }) => this.attemptAgents.set(reports));
    this.taskService.getAttemptReconciliation(this.taskId, attempt).subscribe(({ reconciliation }) => this.attemptReconciliation.set(reconciliation));
    this.taskService.getAttemptImplementationPlan(this.taskId, attempt).subscribe(({ plan }) => this.attemptPlan.set(plan));
    this.taskService.getAttemptExecutionReport(this.taskId, attempt).subscribe(({ report }) => this.attemptExecutionReport.set(report));
    this.taskService.getAttemptReviews(this.taskId, attempt).subscribe(({ reviews }) => this.attemptReviews.set(reviews));
    this.taskService.getAttemptHandoff(this.taskId, attempt).subscribe(({ handoff }) => this.attemptHandoff.set(handoff));
  }
}
