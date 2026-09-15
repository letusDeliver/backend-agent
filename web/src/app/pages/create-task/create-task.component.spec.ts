import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { CreateTaskComponent } from './create-task.component';
import { TaskService } from '../../services/task.service';
import type { Task } from '../../models/task.model';

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: 'new-task-1',
    title: 'New task',
    requirement: 'Add an endpoint.',
    repository: '/tmp/repo',
    status: 'created',
    detectedStack: null,
    selectedAgents: [],
    currentStage: 'created',
    executionMode: 'mock',
    reviewRetryCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('CreateTaskComponent', () => {
  let taskServiceSpy: jest.Mocked<Pick<TaskService, 'createTask' | 'startTask'>>;
  let router: { navigate: jest.Mock };

  beforeEach(async () => {
    taskServiceSpy = {
      createTask: jest.fn().mockReturnValue(of({ task: makeTask() })),
      startTask: jest.fn().mockReturnValue(of({ task: makeTask({ status: 'inspecting' }) })),
    };
    router = { navigate: jest.fn() };

    await TestBed.configureTestingModule({
      imports: [CreateTaskComponent],
      providers: [
        { provide: TaskService, useValue: taskServiceSpy },
        { provide: Router, useValue: router },
      ],
    }).compileComponents();
  });

  it('does not submit when the form is invalid', () => {
    const fixture = TestBed.createComponent(CreateTaskComponent);
    fixture.componentInstance.submit();
    expect(taskServiceSpy.createTask).not.toHaveBeenCalled();
  });

  it('creates then starts the task and navigates to the task detail page', () => {
    const fixture = TestBed.createComponent(CreateTaskComponent);
    const component = fixture.componentInstance;
    component.form.setValue({
      title: '',
      requirement: 'Add an order creation API with PostgreSQL persistence.',
      repository: '/Users/dev/projects/orders-service',
      preferredTechnology: '',
      preferredDatabase: '',
      constraints: '',
    });

    component.submit();

    expect(taskServiceSpy.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ requirement: 'Add an order creation API with PostgreSQL persistence.' })
    );
    expect(taskServiceSpy.startTask).toHaveBeenCalledWith('new-task-1');
    expect(router.navigate).toHaveBeenCalledWith(['/tasks', 'new-task-1']);
  });

  it('surfaces a validation error from the API instead of navigating', () => {
    taskServiceSpy.createTask.mockReturnValue(
      throwError(() => ({ error: { error: { message: 'Repository path does not exist.' } } }))
    );
    const fixture = TestBed.createComponent(CreateTaskComponent);
    const component = fixture.componentInstance;
    component.form.setValue({
      title: '',
      requirement: 'Add an endpoint.',
      repository: '/does/not/exist',
      preferredTechnology: '',
      preferredDatabase: '',
      constraints: '',
    });

    component.submit();

    expect(component.error).toBe('Repository path does not exist.');
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
