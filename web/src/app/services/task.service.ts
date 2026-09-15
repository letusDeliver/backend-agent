import { Injectable } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { Observable } from "rxjs";
import type {
  ExecutionReport,
  FinalHandoff,
  ImplementationPlan,
  Reconciliation,
  ReviewReport,
  SpecialistReport,
  Task,
  TaskCreateInput,
  TaskEvent,
} from "../models/task.model";

export interface Specialist {
  agent: string;
  label: string;
  status: string;
}

export interface Stats {
  active: number;
  completed: number;
  failed: number;
  blocked: number;
  total: number;
}

@Injectable({ providedIn: "root" })
export class TaskService {
  private readonly baseUrl = "/api";

  constructor(private readonly http: HttpClient) {}

  createTask(input: TaskCreateInput): Observable<{ task: Task }> {
    return this.http.post<{ task: Task }>(`${this.baseUrl}/tasks`, input);
  }

  startTask(id: string): Observable<{ task: Task }> {
    return this.http.post<{ task: Task }>(`${this.baseUrl}/tasks/${id}/start`, {});
  }

  cancelTask(id: string): Observable<{ task: Task }> {
    return this.http.post<{ task: Task }>(`${this.baseUrl}/tasks/${id}/cancel`, {});
  }

  listTasks(): Observable<{ tasks: Task[] }> {
    return this.http.get<{ tasks: Task[] }>(`${this.baseUrl}/tasks`);
  }

  getTask(id: string): Observable<{ task: Task }> {
    return this.http.get<{ task: Task }>(`${this.baseUrl}/tasks/${id}`);
  }

  getAgents(id: string): Observable<{ selectedAgents: string[]; reports: SpecialistReport[] }> {
    return this.http.get<{ selectedAgents: string[]; reports: SpecialistReport[] }>(`${this.baseUrl}/tasks/${id}/agents`);
  }

  getReconciliation(id: string): Observable<{ reconciliation: Reconciliation | null }> {
    return this.http.get<{ reconciliation: Reconciliation | null }>(`${this.baseUrl}/tasks/${id}/reconciliation`);
  }

  getImplementationPlan(id: string): Observable<{ plan: ImplementationPlan | null }> {
    return this.http.get<{ plan: ImplementationPlan | null }>(`${this.baseUrl}/tasks/${id}/implementation-plan`);
  }

  getExecutionReport(id: string): Observable<{ report: ExecutionReport | null }> {
    return this.http.get<{ report: ExecutionReport | null }>(`${this.baseUrl}/tasks/${id}/execution-report`);
  }

  getReviews(id: string): Observable<{ reviews: ReviewReport[] }> {
    return this.http.get<{ reviews: ReviewReport[] }>(`${this.baseUrl}/tasks/${id}/reviews`);
  }

  getHandoff(id: string): Observable<{ handoff: FinalHandoff | null; markdown: string | null }> {
    return this.http.get<{ handoff: FinalHandoff | null; markdown: string | null }>(`${this.baseUrl}/tasks/${id}/handoff`);
  }

  getStats(): Observable<Stats> {
    return this.http.get<Stats>(`${this.baseUrl}/stats`);
  }

  getSpecialists(): Observable<{ specialists: Specialist[] }> {
    return this.http.get<{ specialists: Specialist[] }>(`${this.baseUrl}/specialists`);
  }

  /**
   * Live task event stream via Server-Sent Events. Wrapped as an Observable
   * so components can subscribe/unsubscribe the same way as any other
   * reactive source. This app is zoneless: consuming components write
   * received events into signals, and a signal write is itself what
   * schedules change detection — no NgZone re-entry is needed here.
   */
  watchEvents(id: string): Observable<TaskEvent> {
    return new Observable<TaskEvent>((subscriber) => {
      const source = new EventSource(`${this.baseUrl}/tasks/${id}/events`);
      const handler = (message: MessageEvent<string>) => {
        try {
          subscriber.next(JSON.parse(message.data) as TaskEvent);
        } catch {
          // Ignore malformed frames rather than tearing down the stream.
        }
      };
      // Named events are dispatched per EventType; a generic listener covers
      // every type without re-registering per event name.
      source.onmessage = handler;
      const allEventTypes: string[] = [
        "TASK_CREATED",
        "REPOSITORY_INSPECTION_STARTED",
        "REPOSITORY_INSPECTION_COMPLETED",
        "AGENT_SELECTED",
        "WORKSPACE_PREPARED",
        "WORKSPACE_PREPARATION_FAILED",
        "AGENT_ANALYSIS_STARTED",
        "AGENT_ANALYSIS_COMPLETED",
        "RECONCILIATION_STARTED",
        "RECONCILIATION_COMPLETED",
        "IMPLEMENTATION_PLAN_CREATED",
        "IMPLEMENTATION_STARTED",
        "IMPLEMENTATION_COMPLETED",
        "REVIEW_STARTED",
        "REVIEW_COMPLETED",
        "REVIEW_BLOCKING_ISSUE_FOUND",
        "TASK_COMPLETED",
        "TASK_FAILED",
        "TASK_BLOCKED",
        "TASK_CANCELLED",
      ];
      for (const type of allEventTypes) {
        source.addEventListener(type, handler as EventListener);
      }
      source.onerror = () => {
        // EventSource retries automatically; surface nothing fatal here.
      };
      return () => source.close();
    });
  }
}
