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
      autonomousMode: false,
      requirementDocPaths: '',
      decomposeRequirement: false,
    });

    component.submit();

    expect(taskServiceSpy.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ requirement: 'Add an order creation API with PostgreSQL persistence.', autonomyLevel: 'advisory' })
    );
    expect(taskServiceSpy.startTask).toHaveBeenCalledWith('new-task-1');
    expect(router.navigate).toHaveBeenCalledWith(['/tasks', 'new-task-1']);
  });

  it('sends autonomyLevel "autonomous" when the autonomous-mode checkbox is checked', () => {
    const fixture = TestBed.createComponent(CreateTaskComponent);
    const component = fixture.componentInstance;
    component.form.setValue({
      title: '',
      requirement: 'Build whatever makes sense here.',
      repository: '/Users/dev/projects/empty-service',
      preferredTechnology: '',
      preferredDatabase: '',
      constraints: '',
      autonomousMode: true,
      requirementDocPaths: '',
      decomposeRequirement: false,
    });

    component.submit();

    expect(taskServiceSpy.createTask).toHaveBeenCalledWith(expect.objectContaining({ autonomyLevel: 'autonomous' }));
  });

  it('parses requirementDocPaths from newline/comma-separated text into an array', () => {
    const fixture = TestBed.createComponent(CreateTaskComponent);
    const component = fixture.componentInstance;
    component.form.setValue({
      title: '',
      requirement: 'Add an endpoint.',
      repository: '/Users/dev/projects/orders-service',
      preferredTechnology: '',
      preferredDatabase: '',
      constraints: '',
      autonomousMode: false,
      requirementDocPaths: 'docs/requirements.md, docs/login-flow.md\ndocs/tasks.md',
      decomposeRequirement: false,
    });

    component.submit();

    expect(taskServiceSpy.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ requirementDocPaths: ['docs/requirements.md', 'docs/login-flow.md', 'docs/tasks.md'] })
    );
  });

  it('sends decomposeRequirement: true when the backlog checkbox is checked', () => {
    const fixture = TestBed.createComponent(CreateTaskComponent);
    const component = fixture.componentInstance;
    component.form.setValue({
      title: '',
      requirement: 'Build a whole school management backend.',
      repository: '/Users/dev/projects/school-service',
      preferredTechnology: '',
      preferredDatabase: '',
      constraints: '',
      autonomousMode: false,
      requirementDocPaths: '',
      decomposeRequirement: true,
    });

    component.submit();

    expect(taskServiceSpy.createTask).toHaveBeenCalledWith(expect.objectContaining({ decomposeRequirement: true }));
  });

  it('omits requirementDocPaths when the field is left blank', () => {
    const fixture = TestBed.createComponent(CreateTaskComponent);
    const component = fixture.componentInstance;
    component.form.setValue({
      title: '',
      requirement: 'Add an endpoint.',
      repository: '/Users/dev/projects/orders-service',
      preferredTechnology: '',
      preferredDatabase: '',
      constraints: '',
      autonomousMode: false,
      requirementDocPaths: '',
      decomposeRequirement: false,
    });

    component.submit();

    expect(taskServiceSpy.createTask).toHaveBeenCalledWith(expect.objectContaining({ requirementDocPaths: undefined }));
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
      autonomousMode: false,
      requirementDocPaths: '',
      decomposeRequirement: false,
    });

    component.submit();

    expect(component.error()).toBe('Repository path does not exist.');
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
