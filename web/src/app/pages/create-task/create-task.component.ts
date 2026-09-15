import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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
    changeDetection: ChangeDetectionStrategy.Default
})
export class CreateTaskComponent {
  private readonly fb = inject(FormBuilder);

  submitting = false;
  error = '';

  form = this.fb.group({
    title: [''],
    requirement: ['', [Validators.required, Validators.maxLength(8000)]],
    repository: ['', [Validators.required]],
    preferredTechnology: [''],
    preferredDatabase: [''],
    constraints: [''],
  });

  constructor(
    private readonly taskService: TaskService,
    private readonly router: Router
  ) {}

  submit(): void {
    if (this.form.invalid || this.submitting) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting = true;
    this.error = '';
    const value = this.form.getRawValue();

    this.taskService
      .createTask({
        title: value.title || undefined,
        requirement: value.requirement!,
        repository: value.repository!,
        preferredTechnology: value.preferredTechnology || undefined,
        preferredDatabase: value.preferredDatabase || undefined,
        constraints: value.constraints || undefined,
      })
      .pipe(switchMap(({ task }) => this.taskService.startTask(task.id).pipe(map(() => task))))
      .subscribe({
        next: (task) => this.router.navigate(['/tasks', task.id]),
        error: (err) => {
          this.submitting = false;
          this.error = err?.error?.error?.message ?? 'Could not create the task. Check the repository path and try again.';
        },
      });
  }
}
