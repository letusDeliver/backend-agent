import type { Task } from "../types/index.js";

/**
 * Storage boundary for task records. Deliberately narrow so a future
 * PostgreSQL-backed implementation (the durable store the project memory
 * ultimately intends, AD-009) can be dropped in without touching the
 * orchestrator. No Postgres instance is configured in this environment, so
 * the MVP uses a lightweight JSON-file store instead of introducing
 * infrastructure the MVP doesn't need.
 */
export interface TaskStore {
  create(task: Task): Promise<Task>;
  update(task: Task): Promise<Task>;
  get(id: string): Promise<Task | null>;
  list(): Promise<Task[]>;
}
