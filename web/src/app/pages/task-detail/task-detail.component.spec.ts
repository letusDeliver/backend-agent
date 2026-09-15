import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { NEVER, of } from 'rxjs';
import { TaskDetailComponent } from './task-detail.component';
import { TaskService } from '../../services/task.service';
import type { Task } from '../../models/task.model';

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
  } as unknown as jest.Mocked<TaskService>;
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
});
