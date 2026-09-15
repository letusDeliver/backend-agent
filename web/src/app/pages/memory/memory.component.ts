import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TaskService } from '../../services/task.service';
import { AGENT_LABELS, AgentType, MemoryItem } from '../../models/task.model';

@Component({
  selector: 'app-memory',
  imports: [CommonModule, RouterLink],
  templateUrl: './memory.component.html',
  styleUrl: './memory.component.css',
})
export class MemoryComponent implements OnInit {
  readonly agentLabels = AGENT_LABELS;
  readonly loading = signal(true);
  readonly items = signal<MemoryItem[]>([]);
  readonly editingId = signal<string | null>(null);
  readonly editDraft = signal('');
  readonly busyId = signal<string | null>(null);

  readonly candidates = computed(() => this.items().filter((i) => i.validationStatus === 'candidate'));
  readonly validated = computed(() => this.items().filter((i) => i.validationStatus === 'validated'));
  readonly rejected = computed(() => this.items().filter((i) => i.validationStatus === 'rejected'));

  constructor(private readonly taskService: TaskService) {}

  ngOnInit(): void {
    this.refresh();
  }

  private refresh(): void {
    this.taskService.listMemory().subscribe({
      next: ({ items }) => {
        this.items.set(items);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  taskTypeLabel(taskType: string | undefined): string {
    if (!taskType) return 'General';
    return this.agentLabels[taskType as AgentType] ?? taskType;
  }

  approve(item: MemoryItem): void {
    this.busyId.set(item.id);
    this.taskService.approveMemory(item.id, 'developer').subscribe({
      next: () => {
        this.busyId.set(null);
        this.refresh();
      },
      error: () => this.busyId.set(null),
    });
  }

  reject(item: MemoryItem): void {
    this.busyId.set(item.id);
    this.taskService.rejectMemory(item.id).subscribe({
      next: () => {
        this.busyId.set(null);
        this.refresh();
      },
      error: () => this.busyId.set(null),
    });
  }

  startEdit(item: MemoryItem): void {
    this.editingId.set(item.id);
    this.editDraft.set(item.content);
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.editDraft.set('');
  }

  saveEdit(item: MemoryItem): void {
    const content = this.editDraft().trim();
    if (!content) return;
    this.busyId.set(item.id);
    this.taskService.editMemory(item.id, { content }).subscribe({
      next: () => {
        this.busyId.set(null);
        this.editingId.set(null);
        this.refresh();
      },
      error: () => this.busyId.set(null),
    });
  }
}
