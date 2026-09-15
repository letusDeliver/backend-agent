import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { EventType, TaskEvent } from "../types/index.js";
import { ArtifactStore } from "../artifacts/artifactStore.js";

/**
 * In-memory pub/sub for live SSE subscribers, backed by the persisted
 * events.log.jsonl artifact so task history can be reconstructed after a
 * server restart or by a client that connects late (Project Memory §124).
 */
export class TaskEventBus {
  private readonly emitter = new EventEmitter();
  private readonly artifacts: ArtifactStore;

  constructor(artifacts: ArtifactStore) {
    this.emitter.setMaxListeners(100);
    this.artifacts = artifacts;
  }

  async publish(taskId: string, type: EventType, message: string, data?: Record<string, unknown>): Promise<TaskEvent> {
    const event: TaskEvent = {
      id: randomUUID(),
      taskId,
      type,
      message,
      data,
      createdAt: new Date().toISOString(),
    };
    await this.artifacts.appendEvent(event);
    this.emitter.emit(taskId, event);
    return event;
  }

  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    this.emitter.on(taskId, listener);
    return () => this.emitter.off(taskId, listener);
  }

  history(taskId: string): Promise<TaskEvent[]> {
    return this.artifacts.readEvents(taskId);
  }
}
