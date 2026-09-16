import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { TaskService } from '../../services/task.service';
import {
  AGENT_LABELS,
  AgentType,
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

type StageState = 'done' | 'active' | 'pending' | 'blocked';

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
 * Statuses Retry is offered for (Phase 31). Deliberately the same set as
 * `TaskOrchestrator.RETRYABLE_STATUSES` on the server — kept as a separate
 * constant from `TERMINAL_STATUSES` since Retry and Cancel are different
 * affordances for different statuses (a terminal task can be retried; a
 * non-terminal one can be cancelled — the two sets happen to be related but
 * are not the same thing conceptually).
 */
const RETRYABLE_STATUSES = new Set(['failed', 'blocked', 'cancelled']);

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
  readonly selectedAttempt = signal<number | null>(null);
  readonly attemptAgents = signal<SpecialistReport[]>([]);
  readonly attemptReconciliation = signal<Reconciliation | null>(null);
  readonly attemptPlan = signal<ImplementationPlan | null>(null);
  readonly attemptExecutionReport = signal<ExecutionReport | null>(null);
  readonly attemptReviews = signal<ReviewReport[]>([]);
  readonly attemptHandoff = signal<FinalHandoff | null>(null);

  readonly isTerminal = computed(() => {
    const task = this.task();
    return !task || TERMINAL_STATUSES.has(task.status);
  });

  readonly canRetry = computed(() => {
    const task = this.task();
    return !!task && RETRYABLE_STATUSES.has(task.status);
  });

  readonly blockingFindingsCount = computed(
    () => this.reviews().flatMap((r) => r.findings.filter((f) => f.severity === 'blocking')).length
  );
  readonly warningFindingsCount = computed(
    () => this.reviews().flatMap((r) => r.findings.filter((f) => f.severity === 'warning')).length
  );

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
    this.taskService.listAttempts(this.taskId).subscribe(({ attempts }) => this.attempts.set(attempts));
  }

  private onEvent(event: TaskEvent): void {
    this.events.update((events) => [...events, event]);
    this.loadTask();
  }

  private refreshPanelsFor(task: Task): void {
    if (task.status === 'created' || task.status === 'inspecting') return;

    this.taskService.getAgents(task.id).subscribe(({ reports }) => this.specialistReports.set(reports));
    this.taskService.getTaskMemory(task.id).subscribe(({ contextPack }) => this.memoryPack.set(contextPack));

    if (['reconciling', 'planning', 'implementing', 'reviewing', 'completed', 'blocked'].includes(task.status)) {
      this.taskService.getReconciliation(task.id).subscribe(({ reconciliation }) => this.reconciliation.set(reconciliation));
    }
    if (['planning', 'implementing', 'reviewing', 'completed', 'blocked'].includes(task.status)) {
      this.taskService.getImplementationPlan(task.id).subscribe(({ plan }) => this.plan.set(plan));
    }
    if (['implementing', 'reviewing', 'completed', 'blocked'].includes(task.status)) {
      this.taskService.getExecutionReport(task.id).subscribe(({ report }) => this.executionReport.set(report));
    }
    if (['reviewing', 'completed', 'blocked'].includes(task.status)) {
      this.taskService.getReviews(task.id).subscribe(({ reviews }) => this.reviews.set(reviews));
    }
    if (task.status === 'completed') {
      this.taskService.getHandoff(task.id).subscribe(({ handoff, markdown }) => {
        this.handoff.set(handoff);
        this.handoffMarkdown.set(markdown);
      });
    }
  }

  stageState(stage: StageDef): StageState {
    const task = this.task();
    if (!task) return 'pending';
    const sequenceIndex = STAGE_SEQUENCE.findIndex((s) => s.key === stage.key);
    const currentIndex = STAGE_SEQUENCE.findIndex((s) => s.key === task.status);

    if (task.status === 'failed' || task.status === 'blocked') {
      const reachedIndex = STAGE_SEQUENCE.findIndex((s) => s.key === task.currentStage);
      if (sequenceIndex < reachedIndex) return 'done';
      if (sequenceIndex === reachedIndex) return 'blocked';
      return 'pending';
    }

    if (sequenceIndex < currentIndex) return 'done';
    if (sequenceIndex === currentIndex) return task.status === 'completed' ? 'done' : 'active';
    return 'pending';
  }

  specialistFor(agent: AgentType): SpecialistReport | undefined {
    return this.specialistReports().find((r) => r.agent === agent);
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
