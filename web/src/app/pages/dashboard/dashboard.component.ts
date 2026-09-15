import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
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
    changeDetection: ChangeDetectionStrategy.Default
})
export class DashboardComponent implements OnInit {
  stats: Stats | null = null;
  specialists: Specialist[] = [];
  recentTasks: Task[] = [];
  loading = true;
  error = '';

  constructor(private readonly taskService: TaskService) {}

  ngOnInit(): void {
    forkJoin({
      stats: this.taskService.getStats(),
      specialists: this.taskService.getSpecialists(),
      tasks: this.taskService.listTasks(),
    }).subscribe({
      next: ({ stats, specialists, tasks }) => {
        this.stats = stats;
        this.specialists = specialists.specialists;
        this.recentTasks = tasks.tasks.slice(0, 8);
        this.loading = false;
      },
      error: () => {
        this.error = 'Could not reach the orchestrator API.';
        this.loading = false;
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
