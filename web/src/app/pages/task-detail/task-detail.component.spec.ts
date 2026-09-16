import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { NEVER, Observable, of } from 'rxjs';
import { TaskDetailComponent } from './task-detail.component';
import { TaskService } from '../../services/task.service';
import type { Reconciliation, Task } from '../../models/task.model';

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
      taskService.listAttempts.mockReturnValue(of({ attempts: [1] }));
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
});
