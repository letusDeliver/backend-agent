import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { DashboardComponent } from './dashboard.component';
import { TaskService } from '../../services/task.service';
import type { Task } from '../../models/task.model';

function makeTask(overrides: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: 't1',
    title: 'Sample task',
    requirement: 'Do something',
    repository: '/tmp/repo',
    status: 'completed',
    detectedStack: null,
    selectedAgents: ['node-backend'],
    currentStage: 'completed',
    executionMode: 'mock',
    reviewRetryCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('DashboardComponent', () => {
  let taskServiceSpy: jest.Mocked<Pick<TaskService, 'getStats' | 'getSpecialists' | 'listTasks'>>;

  beforeEach(async () => {
    taskServiceSpy = {
      getStats: jest.fn().mockReturnValue(of({ active: 2, completed: 18, failed: 1, blocked: 0, total: 21 })),
      getSpecialists: jest.fn().mockReturnValue(
        of({
          specialists: [
            { agent: 'python-backend', label: 'Python Backend Agent', status: 'available' },
            { agent: 'node-backend', label: 'Node.js Backend Agent', status: 'available' },
            { agent: 'database', label: 'Database Agent', status: 'available' },
          ],
        })
      ),
      listTasks: jest.fn().mockReturnValue(of({ tasks: [makeTask({ title: 'Order API' })] })),
    };

    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [provideRouter([]), { provide: TaskService, useValue: taskServiceSpy }],
    }).compileComponents();
  });

  it('renders stats, specialists and recent tasks from the API', () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Active Tasks');
    expect(text).toContain('18');
    expect(text).toContain('Python Backend Agent');
    expect(text).toContain('Order API');
  });

  it('shows an empty state when there are no tasks', () => {
    taskServiceSpy.listTasks.mockReturnValue(of({ tasks: [] }));
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('No tasks yet');
  });

  it('shows an error state when the API is unreachable', () => {
    taskServiceSpy.getStats.mockReturnValue(throwError(() => new Error('unreachable')));
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Could not reach the orchestrator API');
  });
});
