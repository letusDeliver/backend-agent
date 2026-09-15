import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MemoryItem, MemoryStore, MemoryType } from "./types.js";

export class JsonFileMemoryStore implements MemoryStore {
  private readonly filePath: string;
  private cache: MemoryItem[] | null = null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "memory.json");
  }

  private async ensureLoaded(): Promise<MemoryItem[]> {
    if (this.cache) return this.cache;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.cache = JSON.parse(raw) as MemoryItem[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = [];
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    await writeFile(this.filePath, JSON.stringify(this.cache ?? [], null, 2), "utf-8");
  }

  async add(item: MemoryItem): Promise<MemoryItem> {
    const items = await this.ensureLoaded();
    items.push(item);
    await this.persist();
    return item;
  }

  async list(type?: MemoryType): Promise<MemoryItem[]> {
    const items = await this.ensureLoaded();
    return type ? items.filter((i) => i.type === type) : items;
  }

  async retrieve(query: string, scope?: string, limit = 5): Promise<MemoryItem[]> {
    const items = await this.ensureLoaded();
    const queryTokens = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
    const scored = items
      .filter((i) => !scope || i.scope === scope || i.scope === "global")
      .map((item) => {
        const contentTokens = new Set(item.content.toLowerCase().split(/\W+/).filter(Boolean));
        let overlap = 0;
        for (const token of queryTokens) if (contentTokens.has(token)) overlap += 1;
        return { item, score: overlap * item.confidence };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.item);
  }
}
