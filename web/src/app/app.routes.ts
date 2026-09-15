import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: 'dashboard',
    loadComponent: () => import('./pages/dashboard/dashboard.component').then((m) => m.DashboardComponent),
  },
  {
    path: 'tasks/new',
    loadComponent: () => import('./pages/create-task/create-task.component').then((m) => m.CreateTaskComponent),
  },
  {
    path: 'tasks/:id',
    loadComponent: () => import('./pages/task-detail/task-detail.component').then((m) => m.TaskDetailComponent),
  },
  {
    path: 'memory',
    loadComponent: () => import('./pages/memory/memory.component').then((m) => m.MemoryComponent),
  },
  { path: '**', redirectTo: 'dashboard' },
];
