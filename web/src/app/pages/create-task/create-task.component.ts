import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { map, switchMap } from 'rxjs';
import { TaskService } from '../../services/task.service';

@Component({
    selector: 'app-create-task',
    imports: [CommonModule, ReactiveFormsModule],
    templateUrl: './create-task.component.html',
    styleUrl: './create-task.component.css',
})
export class CreateTaskComponent {
  private readonly fb = inject(FormBuilder);

  readonly submitting = signal(false);
  readonly error = signal('');

  form = this.fb.group({
    title: [''],
    requirement: ['', [Validators.required, Validators.maxLength(8000)]],
    repository: ['', [Validators.required]],
    preferredTechnology: [''],
    preferredDatabase: [''],
    constraints: [''],
    autonomousMode: [false],
  });

  constructor(
    private readonly taskService: TaskService,
    private readonly router: Router
  ) {}

  submit(): void {
    if (this.form.invalid || this.submitting()) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.error.set('');
    const value = this.form.getRawValue();

    this.taskService
      .createTask({
        title: value.title || undefined,
        requirement: value.requirement!,
        repository: value.repository!,
        preferredTechnology: value.preferredTechnology || undefined,
        preferredDatabase: value.preferredDatabase || undefined,
        constraints: value.constraints || undefined,
        autonomyLevel: value.autonomousMode ? 'autonomous' : 'advisory',
      })
      .pipe(switchMap(({ task }) => this.taskService.startTask(task.id).pipe(map(() => task))))
      .subscribe({
        next: (task) => this.router.navigate(['/tasks', task.id]),
        error: (err) => {
          this.submitting.set(false);
          this.error.set(err?.error?.error?.message ?? 'Could not create the task. Check the repository path and try again.');
        },
      });
  }
}
