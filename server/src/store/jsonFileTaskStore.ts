import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Task } from "../types/index.js";
import type { TaskStore } from "./taskStore.js";

/**
 * Single JSON file acting as the task index. Fine for an MVP's single-user,
 * single-process local workload; every write is serialized behind an
 * in-process queue to avoid read-modify-write races between concurrent
 * requests.
 */
export class JsonFileTaskStore implements TaskStore {
  private readonly filePath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private cache: Map<string, Task> | null = null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "tasks-index.json");
  }

  private async ensureLoaded(): Promise<Map<string, Task>> {
    if (this.cache) return this.cache;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const list = JSON.parse(raw) as Task[];
      this.cache = new Map(list.map((t) => [t.id, t]));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = new Map();
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    const cache = await this.ensureLoaded();
    const list = Array.from(cache.values());
    await writeFile(this.filePath, JSON.stringify(list, null, 2), "utf-8");
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(op, op);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  async create(task: Task): Promise<Task> {
    return this.enqueue(async () => {
      const cache = await this.ensureLoaded();
      cache.set(task.id, task);
      await this.persist();
      return task;
    });
  }

  async update(task: Task): Promise<Task> {
    return this.enqueue(async () => {
      const cache = await this.ensureLoaded();
      cache.set(task.id, task);
      await this.persist();
      return task;
    });
  }

  async get(id: string): Promise<Task | null> {
    const cache = await this.ensureLoaded();
    return cache.get(id) ?? null;
  }

  async list(): Promise<Task[]> {
    const cache = await this.ensureLoaded();
    return Array.from(cache.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
