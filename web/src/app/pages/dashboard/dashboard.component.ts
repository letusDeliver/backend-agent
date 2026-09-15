import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { TaskService, Specialist, Stats } from '../../services/task.service';
import type { Task } from '../../models/task.model';

@Component({
    selector: 'app-dashboard',
    imports: [CommonModule, RouterLink],
    templateUrl: './dashboard.component.html',
    styleUrl: './dashboard.component.css',
})
export class DashboardComponent implements OnInit {
  readonly stats = signal<Stats | null>(null);
  readonly specialists = signal<Specialist[]>([]);
  readonly recentTasks = signal<Task[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');

  constructor(private readonly taskService: TaskService) {}

  ngOnInit(): void {
    forkJoin({
      stats: this.taskService.getStats(),
      specialists: this.taskService.getSpecialists(),
      tasks: this.taskService.listTasks(),
    }).subscribe({
      next: ({ stats, specialists, tasks }) => {
        this.stats.set(stats);
        this.specialists.set(specialists.specialists);
        this.recentTasks.set(tasks.tasks.slice(0, 8));
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Could not reach the orchestrator API.');
        this.loading.set(false);
      },
    });
  }

  statusBadgeClass(status: string): string {
    switch (status) {
      case 'completed':
        return 'badge-green';
      case 'failed':
        return 'badge-red';
      case 'blocked':
        return 'badge-amber';
      default:
        return 'badge-blue';
    }
  }
}
