import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { NEVER, Observable, of } from 'rxjs';
import { TaskDetailComponent } from './task-detail.component';
import { TaskService } from '../../services/task.service';
import type { EventType, Reconciliation, Task, TaskEvent } from '../../models/task.model';

function makeTask(overrides: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: 'task-1',
    title: 'Add order creation API',
    requirement: 'Add an order creation API with PostgreSQL persistence.',
    repository: '/tmp/repo',
    status: 'analyzing',
    detectedStack: { language: 'node', packageManager: 'npm', framework: 'Express', database: 'PostgreSQL', testCommand: 'npm test', lintCommand: null, typecheckCommand: null, evidence: [] },
    selectedAgents: ['node-backend', 'database'],
    currentStage: 'analyzing',
    executionMode: 'mock',
    reviewRetryCount: 0,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeTaskService(task: Task): jest.Mocked<TaskService> {
  return {
    getTask: jest.fn().mockReturnValue(of({ task })),
    watchEvents: jest.fn().mockReturnValue(NEVER),
    getAgents: jest.fn().mockReturnValue(of({ selectedAgents: task.selectedAgents, reports: [] })),
    getTaskMemory: jest.fn().mockReturnValue(of({ contextPack: null })),
    getReconciliation: jest.fn().mockReturnValue(of({ reconciliation: null })),
    getImplementationPlan: jest.fn().mockReturnValue(of({ plan: null })),
    getExecutionReport: jest.fn().mockReturnValue(of({ report: null })),
    getReviews: jest.fn().mockReturnValue(of({ reviews: [] })),
    getHandoff: jest.fn().mockReturnValue(of({ handoff: null, markdown: null })),
    resolveConflict: jest.fn().mockReturnValue(NEVER),
    cancelTask: jest.fn().mockReturnValue(NEVER),
    retryTask: jest.fn().mockReturnValue(NEVER),
    listAttempts: jest.fn().mockReturnValue(of({ attempts: [] })),
    getAttemptAgents: jest.fn().mockReturnValue(of({ reports: [] })),
    getAttemptReconciliation: jest.fn().mockReturnValue(of({ reconciliation: null })),
    getAttemptImplementationPlan: jest.fn().mockReturnValue(of({ plan: null })),
    getAttemptExecutionReport: jest.fn().mockReturnValue(of({ report: null })),
    getAttemptReviews: jest.fn().mockReturnValue(of({ reviews: [] })),
    getAttemptHandoff: jest.fn().mockReturnValue(of({ handoff: null, markdown: null })),
    cleanupWorkspace: jest.fn().mockReturnValue(NEVER),
  } as unknown as jest.Mocked<TaskService>;
}

function makeConflictReconciliation(overrides: Partial<Reconciliation> = {}): Reconciliation {
  return {
    taskId: 'task-1',
    status: 'CONFLICT',
    decisions: [],
    agreements: [],
    unresolvedQuestions: ['Resolve transaction disagreement between Node.js Backend and Database Agent before implementation.'],
    risks: [],
    confidencePercent: 80,
    conflicts: [
      {
        id: 'conflict-1',
        kind: 'specialist-disagreement',
        category: 'transaction',
        subject: 'transaction',
        detectedAt: 'reconciliation',
        materiality: 'material',
        reason: 'Node.js Backend and Database Agent both address "transaction" for this task, but state opposite positions.',
        resolution: null,
        createdAt: new Date().toISOString(),
        participants: [
          {
            agent: 'node-backend',
            decision: 'Use a PostgreSQL transaction for order creation.',
            rationale: 'Order creation writes must be atomic.',
            evidence: 'src/routes/orders.ts',
            confidence: 0.9,
            polarity: 'affirmative',
            memoryInfluenced: false,
            memoryIds: [],
          },
          {
            agent: 'database',
            decision: 'Do not use a transaction here; keep this eventually consistent.',
            rationale: 'Order creation now spans two services.',
            evidence: 'schema.sql',
            confidence: 0.9,
            polarity: 'negative',
            memoryInfluenced: false,
            memoryIds: [],
          },
        ],
      },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function configure(task: Task) {
  const taskService = makeTaskService(task);
  TestBed.configureTestingModule({
    imports: [TaskDetailComponent],
    providers: [
      { provide: TaskService, useValue: taskService },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } },
      },
    ],
  });
  return taskService;
}

describe('TaskDetailComponent', () => {
  it('renders a running task with the mock execution banner', () => {
    const task = makeTask({ status: 'analyzing', currentStage: 'analyzing' });
    configure(task);
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Add order creation API');
    expect(text).toContain('MOCK / SIMULATED EXECUTION');
  });

  it('marks earlier stages done and the current stage active', () => {
    const task = makeTask({ status: 'implementing', currentStage: 'implementing' });
    configure(task);
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    expect(component.stageState({ key: 'inspecting', label: '' })).toBe('done');
    expect(component.stageState({ key: 'implementing', label: '' })).toBe('active');
    expect(component.stageState({ key: 'reviewing', label: '' })).toBe('pending');
  });

  it('renders the completed handoff summary', () => {
    const task = makeTask({ status: 'completed', currentStage: 'completed' });
    const taskService = makeTaskService(task);
    taskService.getHandoff.mockReturnValue(
      of({
        handoff: {
          taskId: task.id,
          summary: 'Order creation API implemented.',
          agentsUsed: ['node-backend', 'database'],
          filesChanged: 4,
          testsPassed: 0,
          testsFailed: 0,
          reviewsPassed: 2,
          reviewsFailed: 0,
          architectureDecisions: 2,
          warnings: 1,
          executionMode: 'mock',
          status: 'completed',
          createdAt: new Date().toISOString(),
        },
        markdown: '# Final Handoff',
      })
    );
    TestBed.configureTestingModule({
      imports: [TaskDetailComponent],
      providers: [
        { provide: TaskService, useValue: taskService },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
      ],
    });
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Task Complete');
    expect(text).toContain('Order creation API implemented.');
  });

  it('renders a failed task with its error message', () => {
    const task = makeTask({ status: 'failed', currentStage: 'implementing', error: 'claude CLI exited with code 1' });
    configure(task);
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('claude CLI exited with code 1');
  });

  it('shows a specialist as "Not required" when it was not selected', () => {
    const task = makeTask({ selectedAgents: ['node-backend'] });
    configure(task);
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Not required');
  });

  it('renders an unresolved CONFLICT with both participants, evidence and a resolve control', () => {
    const task = makeTask({ status: 'blocked', currentStage: 'reconciling', error: 'Reconciliation found 1 unresolved material engineering conflict(s).' });
    const taskService = makeTaskService(task);
    taskService.getReconciliation.mockReturnValue(of({ reconciliation: makeConflictReconciliation() }));
    TestBed.configureTestingModule({
      imports: [TaskDetailComponent],
      providers: [
        { provide: TaskService, useValue: taskService },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
      ],
    });
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('CONFLICT');
    expect(text).toContain('requires resolution');
    expect(text).toContain('Use a PostgreSQL transaction for order creation.');
    expect(text).toContain('Do not use a transaction here; keep this eventually consistent.');
    expect(text).toContain('material');

    const resolveButton = fixture.nativeElement.querySelector('.conflict-resolve-form button') as HTMLButtonElement;
    expect(resolveButton).toBeTruthy();
    expect(resolveButton.disabled).toBe(true); // no resolution text entered yet

    const textarea = fixture.nativeElement.querySelector('.conflict-resolve-form textarea') as HTMLTextAreaElement;
    textarea.value = 'Use the transaction; the eventually-consistent design was rejected.';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(resolveButton.disabled).toBe(false);

    resolveButton.click();
    expect(taskService.resolveConflict).toHaveBeenCalledWith('task-1', 'conflict-1', {
      resolution: 'Use the transaction; the eventually-consistent design was rejected.',
    });
  });

  it('renders a resolved conflict without a resolve form', () => {
    const task = makeTask({ status: 'planning', currentStage: 'planning' });
    const taskService = makeTaskService(task);
    const resolved = makeConflictReconciliation({ status: 'AGREED' });
    resolved.conflicts[0].resolution = {
      resolution: 'Use the transaction.',
      reason: 'Confirmed with the team.',
      resolvedBy: 'developer',
      resolvedAt: new Date().toISOString(),
    };
    taskService.getReconciliation.mockReturnValue(of({ reconciliation: resolved }));
    TestBed.configureTestingModule({
      imports: [TaskDetailComponent],
      providers: [
        { provide: TaskService, useValue: taskService },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
      ],
    });
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('resolved');
    expect(text).toContain('developer');
    expect(fixture.nativeElement.querySelector('.conflict-resolve-form')).toBeNull();
  });

  describe('Retry (Phase 31)', () => {
    it.each([
      ['failed', true],
      ['blocked', true],
      ['cancelled', true],
      ['created', false],
      ['inspecting', false],
      ['analyzing', false],
      ['reconciling', false],
      ['planning', false],
      ['implementing', false],
      ['reviewing', false],
      ['completed', false],
    ] as const)('retry visibility for status "%s" is %s', (status, expectVisible) => {
      const task = makeTask({ status, currentStage: status });
      configure(task);
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();
      const retryButton = (fixture.nativeElement as HTMLElement).querySelector('.task-header-actions button.btn-primary');
      if (expectVisible) {
        expect(retryButton).toBeTruthy();
      } else {
        expect(retryButton).toBeNull();
      }
    });

    it('calls TaskService.retryTask when the Retry button is clicked, and disables it while in flight', () => {
      const task = makeTask({ status: 'failed', currentStage: 'implementing', error: 'claude CLI exited with code 1' });
      const taskService = configure(task);
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      const retryButton = fixture.nativeElement.querySelector('.task-header-actions button.btn-primary') as HTMLButtonElement;
      expect(retryButton.disabled).toBe(false);

      retryButton.click();
      expect(taskService.retryTask).toHaveBeenCalledWith('task-1');

      fixture.detectChanges();
      const retryButtonAfter = fixture.nativeElement.querySelector('.task-header-actions button.btn-primary') as HTMLButtonElement;
      expect(retryButtonAfter.disabled).toBe(true);
      expect(retryButtonAfter.textContent).toContain('Retrying');
    });

    it('shows the current attempt number once a task has been retried', () => {
      const task = makeTask({ status: 'analyzing', currentStage: 'analyzing', attempt: 2 });
      configure(task);
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Attempt 2');
    });

    it('renders a Previous Attempts section listing archived attempts, expandable to a read-only view', () => {
      const task = makeTask({ status: 'completed', currentStage: 'completed', attempt: 2 });
      const taskService = makeTaskService(task);
      taskService.listAttempts.mockReturnValue(of({ attempts: [1], attemptSummaries: [{ attempt: 1, reachedStage: 'completed' }] }));
      taskService.getAttemptReconciliation.mockReturnValue(
        of({ reconciliation: { taskId: 'task-1', status: 'AGREED', decisions: [], agreements: [], conflicts: [], unresolvedQuestions: [], risks: [], confidencePercent: 90, createdAt: new Date().toISOString() } })
      );
      taskService.getAttemptExecutionReport.mockReturnValue(
        of({ report: { taskId: 'task-1', executionMode: 'mock', status: 'completed', changedFiles: ['a.ts'], tests: [], commandsExecuted: [], notes: [], createdAt: new Date().toISOString() } })
      );
      TestBed.configureTestingModule({
        imports: [TaskDetailComponent],
        providers: [
          { provide: TaskService, useValue: taskService },
          { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
        ],
      });
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      let text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Previous Attempts');
      expect(text).toContain('Attempt 1');
      // Phase 34: the outcome is visible without expanding the attempt.
      expect(text).toContain('Completed');

      const viewButton = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find((b) =>
        b.textContent?.includes('View artifacts')
      ) as HTMLButtonElement;
      expect(viewButton).toBeTruthy();
      viewButton.click();
      fixture.detectChanges();

      expect(taskService.getAttemptReconciliation).toHaveBeenCalledWith('task-1', 1);
      expect(taskService.getAttemptExecutionReport).toHaveBeenCalledWith('task-1', 1);
      text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Read-only historical view');
      expect(fixture.nativeElement.querySelector('.attempt-detail-card')).toBeTruthy();
    });

    it('shows both Resolve Conflict and Retry for a conflict-blocked task, without implying retry is preferred', () => {
      const task = makeTask({ status: 'blocked', currentStage: 'reconciling', error: 'Reconciliation found 1 unresolved material engineering conflict(s).' });
      const taskService = makeTaskService(task);
      taskService.getReconciliation.mockReturnValue(of({ reconciliation: makeConflictReconciliation() }));
      TestBed.configureTestingModule({
        imports: [TaskDetailComponent],
        providers: [
          { provide: TaskService, useValue: taskService },
          { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
        ],
      });
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      const resolveButton = fixture.nativeElement.querySelector('.conflict-resolve-form button');
      const retryButton = fixture.nativeElement.querySelector('.task-header-actions button.btn-primary');
      expect(resolveButton).toBeTruthy();
      expect(retryButton).toBeTruthy();
    });
  });

  describe('Workspace Cleanup (Phase 32)', () => {
    function cleanupButton(fixture: { nativeElement: HTMLElement }): HTMLButtonElement | null {
      return (
        (Array.from(fixture.nativeElement.querySelectorAll('.workspace-panel button')).find((b) =>
          b.textContent?.includes('Cleanup Workspace')
        ) as HTMLButtonElement | undefined) ?? null
      );
    }

    it.each([
      ['completed', 'real', 'ready', undefined, true],
      ['failed', 'real', 'ready', undefined, true],
      ['cancelled', 'real', 'ready', undefined, true],
      ['blocked', 'real', 'ready', undefined, false],
      ['implementing', 'real', 'ready', undefined, false],
      ['completed', 'mock', undefined, undefined, false],
      ['completed', 'real', 'ready', 'cleaned', false],
      ['completed', 'real', 'failed', undefined, false],
    ] as const)(
      'cleanup visibility for status=%s mode=%s workspaceStatus=%s cleanupStatus=%s is %s',
      (status, executionMode, workspaceStatus, cleanupStatus, expectVisible) => {
        const task = makeTask({
          status,
          currentStage: status,
          executionMode,
          executionWorkspace:
            executionMode === 'real'
              ? {
                  workspacePath: '/tmp/tasks/task-1/workspace',
                  branch: 'agent/task-task-1',
                  baseRevision: 'a'.repeat(40),
                  status: workspaceStatus!,
                  createdAt: new Date().toISOString(),
                  cleanupStatus,
                }
              : undefined,
        });
        configure(task);
        const fixture = TestBed.createComponent(TaskDetailComponent);
        fixture.detectChanges();
        const button = cleanupButton(fixture);
        if (expectVisible) {
          expect(button).toBeTruthy();
        } else {
          expect(button).toBeNull();
        }
      }
    );

    function makeRealTerminalTask(overrides: Partial<Task> = {}): Task {
      return makeTask({
        status: 'completed',
        currentStage: 'completed',
        executionMode: 'real',
        executionWorkspace: {
          workspacePath: '/tmp/tasks/task-1/workspace',
          branch: 'agent/task-task-1',
          baseRevision: 'a'.repeat(40),
          status: 'ready',
          createdAt: new Date().toISOString(),
        },
        ...overrides,
      });
    }

    it('shows a confirmation before calling TaskService.cleanupWorkspace, and does not call it on Cancel', () => {
      const task = makeRealTerminalTask();
      const taskService = configure(task);
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      cleanupButton(fixture)!.click();
      fixture.detectChanges();
      expect(taskService.cleanupWorkspace).not.toHaveBeenCalled();
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('permanently deletes the task branch');

      const cancelBtn = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.cleanup-confirm button')).find((b) =>
        b.textContent?.includes('Cancel')
      ) as HTMLButtonElement;
      cancelBtn.click();
      fixture.detectChanges();
      expect(taskService.cleanupWorkspace).not.toHaveBeenCalled();
      expect(fixture.nativeElement.querySelector('.cleanup-confirm')).toBeNull();
      expect(cleanupButton(fixture)).toBeTruthy();
    });

    it('calls TaskService.cleanupWorkspace on confirm, disables the button while in flight, and renders Cleaned on success', () => {
      const task = makeRealTerminalTask();
      const taskService = makeTaskService(task);
      const cleaned: Task = {
        ...task,
        executionWorkspace: { ...task.executionWorkspace!, cleanupStatus: 'cleaned', cleanedAt: new Date().toISOString() },
      };
      taskService.cleanupWorkspace.mockReturnValue(of({ task: cleaned }));
      TestBed.configureTestingModule({
        imports: [TaskDetailComponent],
        providers: [
          { provide: TaskService, useValue: taskService },
          { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
        ],
      });
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      cleanupButton(fixture)!.click();
      fixture.detectChanges();
      const confirmBtn = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.cleanup-confirm button')).find((b) =>
        b.textContent?.includes('Confirm Cleanup')
      ) as HTMLButtonElement;
      confirmBtn.click();
      expect(taskService.cleanupWorkspace).toHaveBeenCalledWith('task-1');

      fixture.detectChanges();
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Cleaned');
      expect(cleanupButton(fixture)).toBeNull();
    });

    it('reloads the task to show a cleanup failure without crashing', () => {
      const task = makeRealTerminalTask();
      const taskService = makeTaskService(task);
      const failed: Task = {
        ...task,
        executionWorkspace: { ...task.executionWorkspace!, cleanupStatus: 'cleanup_failed', cleanupError: 'git worktree remove failed: locked' },
      };
      taskService.cleanupWorkspace.mockReturnValue(new Observable((subscriber) => subscriber.error(new Error('cleanup failed'))));
      taskService.getTask.mockReturnValueOnce(of({ task })).mockReturnValue(of({ task: failed }));
      TestBed.configureTestingModule({
        imports: [TaskDetailComponent],
        providers: [
          { provide: TaskService, useValue: taskService },
          { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
        ],
      });
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      cleanupButton(fixture)!.click();
      fixture.detectChanges();
      const confirmBtn = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.cleanup-confirm button')).find((b) =>
        b.textContent?.includes('Confirm Cleanup')
      ) as HTMLButtonElement;
      confirmBtn.click();
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Cleanup failed');
      expect(text).toContain('git worktree remove failed: locked');
    });
  });

  describe('Implementation Diff (Phase 33)', () => {
    function makeExecutionReport(overrides: Partial<import('../../models/task.model').ExecutionReport> = {}) {
      return {
        taskId: 'task-1',
        executionMode: 'real' as const,
        status: 'completed' as const,
        changedFiles: ['src/routes/orders.ts'],
        tests: [],
        commandsExecuted: [],
        notes: [],
        createdAt: new Date().toISOString(),
        ...overrides,
      };
    }

    function completedRealTask(): Task {
      return makeTask({ status: 'completed', currentStage: 'completed', executionMode: 'real' });
    }

    function diffPatchPre(fixture: { nativeElement: HTMLElement }): HTMLElement | null {
      return fixture.nativeElement.querySelector('.diff-patch pre');
    }

    it('renders per-file stats and the patch inside a collapsed details block', () => {
      const task = completedRealTask();
      const taskService = makeTaskService(task);
      taskService.getExecutionReport.mockReturnValue(
        of({
          report: makeExecutionReport({
            diff: {
              baseRevision: 'a'.repeat(40),
              branch: 'agent/task-task-1',
              files: [{ path: 'src/routes/orders.ts', additions: 12, deletions: 3 }],
              summary: '1 file changed, 12 insertions(+), 3 deletions(-)',
              patch: 'diff --git a/src/routes/orders.ts b/src/routes/orders.ts\n+added line',
              truncated: false,
              totalPatchChars: 68,
            },
          }),
        })
      );
      TestBed.configureTestingModule({
        imports: [TaskDetailComponent],
        providers: [
          { provide: TaskService, useValue: taskService },
          { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
        ],
      });
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('src/routes/orders.ts');
      expect(text).toContain('+12 / -3');
      expect(text).not.toContain('Diff truncated');

      const pre = diffPatchPre(fixture);
      expect(pre).toBeTruthy();
      expect(pre!.textContent).toContain('+added line');
      const details = fixture.nativeElement.querySelector('.diff-patch') as HTMLDetailsElement;
      expect(details.open).toBe(false);
    });

    it('shows an explicit truncation notice and labels the patch as truncated', () => {
      const task = completedRealTask();
      const taskService = makeTaskService(task);
      taskService.getExecutionReport.mockReturnValue(
        of({
          report: makeExecutionReport({
            diff: {
              baseRevision: 'a'.repeat(40),
              branch: 'agent/task-task-1',
              files: [{ path: 'big-file.ts', additions: 5000, deletions: 0 }],
              summary: '1 file changed, 5000 insertions(+), 0 deletions(-)',
              patch: 'diff --git a/big-file.ts b/big-file.ts\n+truncated content\n\n--- diff truncated ---\n',
              truncated: true,
              totalPatchChars: 500000,
            },
          }),
        })
      );
      TestBed.configureTestingModule({
        imports: [TaskDetailComponent],
        providers: [
          { provide: TaskService, useValue: taskService },
          { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
        ],
      });
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Diff truncated');
      expect(text).toContain('View patch (truncated)');
    });

    it('shows "no changes" state distinctly when the diff exists but has no files', () => {
      const task = completedRealTask();
      const taskService = makeTaskService(task);
      taskService.getExecutionReport.mockReturnValue(
        of({
          report: makeExecutionReport({
            diff: {
              baseRevision: 'a'.repeat(40),
              branch: 'agent/task-task-1',
              files: [],
              summary: 'No changes.',
              patch: '',
              truncated: false,
              totalPatchChars: 0,
            },
          }),
        })
      );
      TestBed.configureTestingModule({
        imports: [TaskDetailComponent],
        providers: [
          { provide: TaskService, useValue: taskService },
          { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
        ],
      });
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('the execution pass made no changes');
      expect(diffPatchPre(fixture)).toBeNull();
    });

    it('shows the mock-mode explanation, not a generic error, when running in mock mode with no diff', () => {
      const task = makeTask({ status: 'completed', currentStage: 'completed', executionMode: 'mock' });
      const taskService = makeTaskService(task);
      taskService.getExecutionReport.mockReturnValue(of({ report: makeExecutionReport({ executionMode: 'mock', diff: undefined }) }));
      TestBed.configureTestingModule({
        imports: [TaskDetailComponent],
        providers: [
          { provide: TaskService, useValue: taskService },
          { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
        ],
      });
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('MOCK / SIMULATED EXECUTION');
      expect(text).toContain('no ground-truth diff is produced in mock mode');
      expect(diffPatchPre(fixture)).toBeNull();
    });

    it('shows a generic unavailable message for a real-mode report with no diff (e.g. a failed execution)', () => {
      const task = completedRealTask();
      const taskService = makeTaskService(task);
      taskService.getExecutionReport.mockReturnValue(
        of({ report: makeExecutionReport({ status: 'failed', diff: undefined, notes: ['Real execution failed: claude CLI exited with code 1'] }) })
      );
      TestBed.configureTestingModule({
        imports: [TaskDetailComponent],
        providers: [
          { provide: TaskService, useValue: taskService },
          { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
        ],
      });
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('No implementation diff available.');
      expect(text).not.toContain('no ground-truth diff is produced in mock mode');
      expect(diffPatchPre(fixture)).toBeNull();
    });
  });

  describe('Non-Success Task Visibility (Phase 34)', () => {
    it.each([
      ['failed', 'reviewing', true, true, true, true],
      ['cancelled', 'implementing', true, true, true, false],
      ['cancelled', 'reconciling', true, false, false, false],
      ['failed', 'routing', false, false, false, false],
      ['blocked', 'reconciling', true, false, false, false],
    ] as const)(
      'status=%s currentStage=%s fetches reconciliation=%s plan=%s executionReport=%s reviews=%s',
      (status, currentStage, expectReconciliation, expectPlan, expectExecutionReport, expectReviews) => {
        const task = makeTask({ status, currentStage });
        const taskService = configure(task);
        const fixture = TestBed.createComponent(TaskDetailComponent);
        fixture.detectChanges();

        expect(taskService.getReconciliation.mock.calls.length > 0).toBe(expectReconciliation);
        expect(taskService.getImplementationPlan.mock.calls.length > 0).toBe(expectPlan);
        expect(taskService.getExecutionReport.mock.calls.length > 0).toBe(expectExecutionReport);
        expect(taskService.getReviews.mock.calls.length > 0).toBe(expectReviews);
        // Handoff is never fetched for a non-completed task, regardless of stage reached.
        expect(taskService.getHandoff).not.toHaveBeenCalled();
      }
    );

    it('renders reconciliation, plan, execution report and reviews for a failed task that reached review — previously withheld entirely', () => {
      const task = makeTask({ status: 'failed', currentStage: 'reviewing', error: 'claude CLI exited with code 1' });
      const taskService = makeTaskService(task);
      taskService.getReconciliation.mockReturnValue(
        of({ reconciliation: { taskId: 'task-1', status: 'AGREED', decisions: [], agreements: [], conflicts: [], unresolvedQuestions: [], risks: [], confidencePercent: 90, createdAt: new Date().toISOString() } })
      );
      taskService.getImplementationPlan.mockReturnValue(
        of({ plan: { taskId: 'task-1', summary: 'Add the endpoint.', files: [{ path: 'a.ts', description: 'route' }], validationCommands: [], createdAt: new Date().toISOString() } })
      );
      taskService.getExecutionReport.mockReturnValue(
        of({ report: { taskId: 'task-1', executionMode: 'mock', status: 'failed', changedFiles: ['a.ts'], tests: [], commandsExecuted: [], notes: ['boom'], createdAt: new Date().toISOString() } })
      );
      taskService.getReviews.mockReturnValue(
        of({ reviews: [{ agent: 'node-backend', taskId: 'task-1', status: 'FAIL', findings: [{ summary: 'blocking issue', severity: 'blocking', recommendation: 'fix it' }], executionMode: 'mock', createdAt: new Date().toISOString(), attempt: 3 }] })
      );
      TestBed.configureTestingModule({
        imports: [TaskDetailComponent],
        providers: [
          { provide: TaskService, useValue: taskService },
          { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
        ],
      });
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Add the endpoint.');
      expect(text).toContain('blocking issue');
    });

    it('shows a truthful Outcome summary for a failed task, without inventing a root cause', () => {
      const task = makeTask({ status: 'failed', currentStage: 'implementing', error: 'claude CLI exited with code 1' });
      configure(task);
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Outcome');
      expect(text).toContain('Task failed during implementation.');
    });

    it('shows an Outcome summary for a cancelled task even though task.error is empty', () => {
      const task = makeTask({ status: 'cancelled', currentStage: 'reviewing' });
      configure(task);
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Task was cancelled during review.');
    });

    it('does not show an Outcome summary for a completed task', () => {
      const completed = makeTask({ status: 'completed', currentStage: 'completed' });
      configure(completed);
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.outcome-card')).toBeNull();
    });

    it('does not show an Outcome summary for a live, non-terminal task', () => {
      const live = makeTask({ status: 'implementing', currentStage: 'implementing' });
      configure(live);
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.outcome-card')).toBeNull();
    });

    it('lists Resolve/Retry/Cleanup as next actions only when each is actually eligible', () => {
      const task = makeTask({
        status: 'blocked',
        currentStage: 'reconciling',
        error: 'Reconciliation found 1 unresolved material engineering conflict(s).',
      });
      const taskService = makeTaskService(task);
      taskService.getReconciliation.mockReturnValue(
        of({
          reconciliation: makeConflictReconciliation(),
        })
      );
      TestBed.configureTestingModule({
        imports: [TaskDetailComponent],
        providers: [
          { provide: TaskService, useValue: taskService },
          { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: task.id }) } } },
        ],
      });
      const fixture = TestBed.createComponent(TaskDetailComponent);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Resolve the conflict below');
      expect(text).toContain('Retry');
      // Cleanup is never offered for a blocked task (Phase 32 invariant) —
      // the Outcome summary must not claim it's available.
      expect(text).not.toContain('Clean up the isolated workspace');
    });

    it.each([
      ['blocked', 'reconciling'],
      ['failed', 'implementing'],
      ['cancelled', 'reviewing'],
    ] as const)(
      "status=%s currentStage=%s: stages before are 'done', the stop point is 'stopped', later stages are 'pending'",
      (status, currentStage) => {
        const task = makeTask({ status, currentStage });
        configure(task);
        const fixture = TestBed.createComponent(TaskDetailComponent);
        fixture.detectChanges();
        const component = fixture.componentInstance;

        const stopIndex = component.stages.findIndex((s) => s.key === currentStage);
        component.stages.forEach((stage, i) => {
          const state = component.stageState(stage);
          if (i < stopIndex) expect(state).toBe('done');
          else if (i === stopIndex) expect(state).toBe('stopped');
          else expect(state).toBe('pending');
        });
      }
    );
  });
});

/** A minimal, timestamp-only TaskEvent for the Phase 40 timing tests below. */
function makeEvent(type: EventType, createdAt: string): TaskEvent {
  return { id: `${type}-${createdAt}`, taskId: 'task-1', type, message: '', createdAt };
}

describe('TaskDetailComponent — stage/specialist timing (Phase 40)', () => {
  it('computes a stage duration purely from its start/complete event timestamps', () => {
    const task = makeTask({ status: 'analyzing', currentStage: 'analyzing' });
    configure(task);
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    component.events.set([
      makeEvent('REPOSITORY_INSPECTION_STARTED', '2026-01-01T00:00:00.000Z'),
      makeEvent('REPOSITORY_INSPECTION_COMPLETED', '2026-01-01T00:00:02.500Z'),
    ]);

    expect(component.stageDurationLabel('inspecting')).toBe('2.5s');
  });

  it('sums every occurrence of a recurring start/complete pair (e.g. corrective implementation passes)', () => {
    const task = makeTask({ status: 'reviewing', currentStage: 'reviewing' });
    configure(task);
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    component.events.set([
      makeEvent('IMPLEMENTATION_STARTED', '2026-01-01T00:00:00.000Z'),
      makeEvent('IMPLEMENTATION_COMPLETED', '2026-01-01T00:00:01.000Z'), // 1s
      makeEvent('REVIEW_STARTED', '2026-01-01T00:00:01.000Z'),
      makeEvent('REVIEW_COMPLETED', '2026-01-01T00:00:01.500Z'),
      makeEvent('IMPLEMENTATION_STARTED', '2026-01-01T00:00:02.000Z'),
      makeEvent('IMPLEMENTATION_COMPLETED', '2026-01-01T00:00:03.500Z'), // 1.5s more -> 2.5s total
    ]);

    expect(component.stageDurationLabel('implementing')).toBe('2.5s');
  });

  it('returns null for a stage with no timing signal yet, rather than a misleading 0', () => {
    const task = makeTask({ status: 'created', currentStage: 'created' });
    configure(task);
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    component.events.set([]);
    expect(component.stageDurationLabel('implementing')).toBeNull();
  });

  it("computes a specialist's own analysis duration from AGENT_ANALYSIS_STARTED to that agent's report timestamp", () => {
    const task = makeTask({ status: 'analyzing', currentStage: 'analyzing' });
    configure(task);
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    component.events.set([makeEvent('AGENT_ANALYSIS_STARTED', '2026-01-01T00:00:00.000Z')]);
    component.specialistReports.set([
      {
        agent: 'node-backend',
        taskId: 'task-1',
        status: 'completed',
        recommendation: 'r',
        findings: [],
        risks: [],
        assumptions: [],
        confidence: 0.9,
        executionMode: 'mock',
        createdAt: '2026-01-01T00:00:03.200Z',
      },
    ]);

    expect(component.specialistDurationLabel('node-backend')).toBe('3.2s');
    expect(component.specialistDurationLabel('database')).toBeNull();
  });

  it('formats sub-second durations in milliseconds and multi-minute durations as "Xm YYs"', () => {
    const task = makeTask({ status: 'analyzing', currentStage: 'analyzing' });
    configure(task);
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    component.events.set([
      makeEvent('REPOSITORY_INSPECTION_STARTED', '2026-01-01T00:00:00.000Z'),
      makeEvent('REPOSITORY_INSPECTION_COMPLETED', '2026-01-01T00:00:00.340Z'),
    ]);
    expect(component.stageDurationLabel('inspecting')).toBe('340ms');

    component.events.set([
      makeEvent('AGENT_ANALYSIS_STARTED', '2026-01-01T00:00:00.000Z'),
      makeEvent('AGENT_ANALYSIS_COMPLETED', '2026-01-01T00:01:05.000Z'),
    ]);
    expect(component.stageDurationLabel('analyzing')).toBe('1m 05s');
  });

  it('shows wall-clock time elapsed since task creation, based on the latest known event', () => {
    const task = makeTask({
      status: 'analyzing',
      currentStage: 'analyzing',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    configure(task);
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    component.events.set([makeEvent('AGENT_ANALYSIS_STARTED', '2026-01-01T00:00:04.000Z')]);
    expect(component.totalElapsedLabel()).toBe('4.0s');
  });
});

describe('TaskDetailComponent — live implementation progress (Phase 41)', () => {
  it('filters IMPLEMENTATION_PROGRESS events out of the generic event stream, in order', () => {
    const task = makeTask({ status: 'implementing', currentStage: 'implementing' });
    configure(task);
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    const progressA: TaskEvent = { id: 'p1', taskId: 'task-1', type: 'IMPLEMENTATION_PROGRESS', message: 'Write: src/routes/health.ts', createdAt: '2026-01-01T00:00:01.000Z', data: { kind: 'tool_use', tool: 'Write', detail: 'src/routes/health.ts' } };
    const progressB: TaskEvent = { id: 'p2', taskId: 'task-1', type: 'IMPLEMENTATION_PROGRESS', message: 'Bash: npm test', createdAt: '2026-01-01T00:00:02.000Z', data: { kind: 'tool_use', tool: 'Bash', detail: 'npm test' } };
    component.events.set([makeEvent('IMPLEMENTATION_STARTED', '2026-01-01T00:00:00.000Z'), progressA, progressB]);

    expect(component.implementationProgressEvents()).toEqual([progressA, progressB]);
  });

  it('picks a distinct icon per tool, and a generic one for plain text progress', () => {
    const task = makeTask({ status: 'implementing', currentStage: 'implementing' });
    configure(task);
    const fixture = TestBed.createComponent(TaskDetailComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    const withTool = (tool: string): TaskEvent => ({ id: tool, taskId: 'task-1', type: 'IMPLEMENTATION_PROGRESS', message: '', createdAt: '2026-01-01T00:00:00.000Z', data: { tool } });

    expect(component.progressIcon(withTool('Write'))).toBe('📝');
    expect(component.progressIcon(withTool('Edit'))).toBe('✏️');
    expect(component.progressIcon(withTool('Bash'))).toBe('▶');
    expect(component.progressIcon({ id: 't', taskId: 'task-1', type: 'IMPLEMENTATION_PROGRESS', message: '', createdAt: '2026-01-01T00:00:00.000Z' })).toBe('💬');
  });
});
