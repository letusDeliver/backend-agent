import { ChangeDetectionStrategy, Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { TaskService } from '../../services/task.service';
import {
  AGENT_LABELS,
  AgentType,
  ExecutionReport,
  FinalHandoff,
  ImplementationPlan,
  Reconciliation,
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

@Component({
    selector: 'app-task-detail',
    imports: [CommonModule, RouterLink],
    templateUrl: './task-detail.component.html',
    styleUrl: './task-detail.component.css',
    changeDetection: ChangeDetectionStrategy.Default
})
export class TaskDetailComponent implements OnInit, OnDestroy {
  readonly allAgents = ALL_AGENTS;
  readonly agentLabels = AGENT_LABELS;

  task: Task | null = null;
  events: TaskEvent[] = [];
  specialistReports: SpecialistReport[] = [];
  reconciliation: Reconciliation | null = null;
  plan: ImplementationPlan | null = null;
  executionReport: ExecutionReport | null = null;
  reviews: ReviewReport[] = [];
  handoff: FinalHandoff | null = null;
  handoffMarkdown: string | null = null;
  loading = true;
  notFound = false;
  showActivityLog = false;

  private readonly destroyed$ = new Subject<void>();
  private taskId = '';

  constructor(
    private readonly route: ActivatedRoute,
    private readonly taskService: TaskService
  ) {}

  ngOnInit(): void {
    this.taskId = this.route.snapshot.paramMap.get('id') ?? '';
    if (!this.taskId) {
      this.notFound = true;
      this.loading = false;
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
        this.task = task;
        this.loading = false;
        this.refreshPanelsFor(task);
      },
      error: () => {
        this.notFound = true;
        this.loading = false;
      },
    });
  }

  private onEvent(event: TaskEvent): void {
    this.events = [...this.events, event];
    this.loadTask();
  }

  private refreshPanelsFor(task: Task): void {
    if (task.status === 'created' || task.status === 'inspecting') return;

    this.taskService.getAgents(task.id).subscribe(({ reports }) => (this.specialistReports = reports));

    if (['reconciling', 'planning', 'implementing', 'reviewing', 'completed', 'blocked'].includes(task.status)) {
      this.taskService.getReconciliation(task.id).subscribe(({ reconciliation }) => (this.reconciliation = reconciliation));
    }
    if (['planning', 'implementing', 'reviewing', 'completed', 'blocked'].includes(task.status)) {
      this.taskService.getImplementationPlan(task.id).subscribe(({ plan }) => (this.plan = plan));
    }
    if (['implementing', 'reviewing', 'completed', 'blocked'].includes(task.status)) {
      this.taskService.getExecutionReport(task.id).subscribe(({ report }) => (this.executionReport = report));
    }
    if (['reviewing', 'completed', 'blocked'].includes(task.status)) {
      this.taskService.getReviews(task.id).subscribe(({ reviews }) => (this.reviews = reviews));
    }
    if (task.status === 'completed') {
      this.taskService.getHandoff(task.id).subscribe(({ handoff, markdown }) => {
        this.handoff = handoff;
        this.handoffMarkdown = markdown;
      });
    }
  }

  stageState(stage: StageDef): StageState {
    if (!this.task) return 'pending';
    const sequenceIndex = STAGE_SEQUENCE.findIndex((s) => s.key === stage.key);
    const currentIndex = STAGE_SEQUENCE.findIndex((s) => s.key === this.task!.status);

    if (this.task.status === 'failed' || this.task.status === 'blocked') {
      const reachedIndex = STAGE_SEQUENCE.findIndex((s) => s.key === this.task!.currentStage);
      if (sequenceIndex < reachedIndex) return 'done';
      if (sequenceIndex === reachedIndex) return 'blocked';
      return 'pending';
    }

    if (sequenceIndex < currentIndex) return 'done';
    if (sequenceIndex === currentIndex) return this.task.status === 'completed' ? 'done' : 'active';
    return 'pending';
  }

  get stages(): StageDef[] {
    return STAGE_SEQUENCE;
  }

  specialistFor(agent: AgentType): SpecialistReport | undefined {
    return this.specialistReports.find((r) => r.agent === agent);
  }

  reviewFor(agent: AgentType): ReviewReport | undefined {
    return this.reviews.find((r) => r.agent === agent);
  }

  ownerLabel(owner: AgentType | 'orchestrator'): string {
    return owner === 'orchestrator' ? 'Orchestrator' : AGENT_LABELS[owner];
  }

  isFileChanged(path: string): boolean {
    return this.executionReport?.changedFiles.includes(path) ?? false;
  }

  get blockingFindingsCount(): number {
    return this.reviews.flatMap((r) => r.findings.filter((f) => f.severity === 'blocking')).length;
  }

  get warningFindingsCount(): number {
    return this.reviews.flatMap((r) => r.findings.filter((f) => f.severity === 'warning')).length;
  }

  toggleActivityLog(): void {
    this.showActivityLog = !this.showActivityLog;
  }
}
