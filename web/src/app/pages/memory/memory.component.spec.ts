import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { MemoryComponent } from './memory.component';
import { TaskService } from '../../services/task.service';
import type { MemoryItem } from '../../models/task.model';

function makeItem(overrides: Partial<MemoryItem>): MemoryItem {
  const now = new Date().toISOString();
  return {
    id: 'm1',
    type: 'candidate_lesson',
    scope: '/repo/a',
    content: 'Use keyset pagination for large result sets.',
    technology: ['postgresql'],
    taskType: 'database',
    validationStatus: 'candidate',
    provenance: { taskId: 'task-1', agent: 'database', artifact: 'reconciliation.json', decision: 'Use keyset pagination.' },
    confidence: 0.85,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('MemoryComponent', () => {
  let taskServiceSpy: jest.Mocked<Pick<TaskService, 'listMemory' | 'approveMemory' | 'rejectMemory' | 'editMemory'>>;

  beforeEach(async () => {
    taskServiceSpy = {
      listMemory: jest.fn().mockReturnValue(
        of({
          items: [
            makeItem({ id: 'candidate-1', validationStatus: 'candidate' }),
            makeItem({ id: 'validated-1', validationStatus: 'validated', type: 'validated_lesson' }),
            makeItem({ id: 'rejected-1', validationStatus: 'rejected' }),
          ],
        })
      ),
      approveMemory: jest.fn().mockReturnValue(of({ item: makeItem({ id: 'candidate-1', validationStatus: 'validated' }) })),
      rejectMemory: jest.fn().mockReturnValue(of({ item: makeItem({ id: 'candidate-1', validationStatus: 'rejected' }) })),
      editMemory: jest.fn().mockReturnValue(of({ item: makeItem({ id: 'candidate-1', content: 'Edited.' }) })),
    };

    await TestBed.configureTestingModule({
      imports: [MemoryComponent],
      providers: [provideRouter([]), { provide: TaskService, useValue: taskServiceSpy }],
    }).compileComponents();
  });

  it('renders overview counts and sections from retrieved memory', () => {
    const fixture = TestBed.createComponent(MemoryComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Validated Memory');
    expect(text).toContain('Candidate Lessons');
    expect(text).toContain('Use keyset pagination');
  });

  it('approve() calls the service and refreshes the list', () => {
    const fixture = TestBed.createComponent(MemoryComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    component.approve(makeItem({ id: 'candidate-1' }));

    expect(taskServiceSpy.approveMemory).toHaveBeenCalledWith('candidate-1', 'developer');
    expect(taskServiceSpy.listMemory).toHaveBeenCalledTimes(2);
  });

  it('reject() calls the service and refreshes the list', () => {
    const fixture = TestBed.createComponent(MemoryComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    component.reject(makeItem({ id: 'candidate-1' }));

    expect(taskServiceSpy.rejectMemory).toHaveBeenCalledWith('candidate-1');
  });
});
