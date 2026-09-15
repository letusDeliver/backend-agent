import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  MemoryItem,
  MemoryListFilter,
  MemoryRetrievalMatch,
  MemoryRetrievalQuery,
  MemoryStore,
  MemoryUpdatePatch,
} from "./types.js";

const GLOBAL_SCOPE = "global";

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

  async get(id: string): Promise<MemoryItem | null> {
    const items = await this.ensureLoaded();
    return items.find((i) => i.id === id) ?? null;
  }

  async list(filter?: MemoryListFilter): Promise<MemoryItem[]> {
    const items = await this.ensureLoaded();
    return items.filter((i) => {
      if (filter?.type && i.type !== filter.type) return false;
      if (filter?.validationStatus && i.validationStatus !== filter.validationStatus) return false;
      if (filter?.scope && i.scope !== filter.scope) return false;
      return true;
    });
  }

  async update(id: string, patch: MemoryUpdatePatch): Promise<MemoryItem> {
    const items = await this.ensureLoaded();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) throw new Error(`Memory item ${id} not found.`);
    // Replace rather than mutate in place: a caller may be holding an
    // earlier snapshot (e.g. the return value of add()) that must stay an
    // immutable point-in-time record, not silently change underneath it.
    const updated: MemoryItem = { ...items[idx], ...patch, updatedAt: new Date().toISOString() };
    items[idx] = updated;
    await this.persist();
    return updated;
  }

  /**
   * Simple, replaceable relevance scoring: technology-tag overlap weighs
   * most, then keyword overlap against content, then scope/taskType bonuses,
   * all scaled by the item's own confidence. Hard-filters to
   * validationStatus === "validated" first — this is the trust boundary,
   * not merely a scoring input (Phase 29 brief section 10).
   */
  async retrieve(query: MemoryRetrievalQuery): Promise<MemoryRetrievalMatch[]> {
    const items = await this.ensureLoaded();
    const queryTech = new Set(query.technology.map((t) => t.toLowerCase()));
    const queryTokens = new Set(query.text.toLowerCase().split(/\W+/).filter(Boolean));

    const scored: MemoryRetrievalMatch[] = [];
    for (const item of items) {
      if (item.validationStatus !== "validated") continue;
      if (item.scope !== query.scope && item.scope !== GLOBAL_SCOPE) continue;

      const matchedOn: string[] = [];
      let contentScore = 0;

      const itemTech = item.technology.map((t) => t.toLowerCase());
      const techOverlap = itemTech.filter((t) => queryTech.has(t));
      if (techOverlap.length > 0) {
        contentScore += techOverlap.length * 3;
        matchedOn.push(...techOverlap.map((t) => `technology:${t}`));
      }

      const contentTokens = new Set(item.content.toLowerCase().split(/\W+/).filter(Boolean));
      let keywordOverlap = 0;
      for (const token of queryTokens) {
        if (contentTokens.has(token)) {
          keywordOverlap += 1;
          matchedOn.push(`keyword:${token}`);
        }
      }
      contentScore += keywordOverlap;

      // Scope/taskType are tie-breakers among already-relevant items, not
      // qualifiers on their own — an item with zero technology/keyword
      // overlap should never surface merely for sharing a repository.
      if (contentScore === 0) continue;

      let score = contentScore;
      if (item.scope === query.scope) {
        score += 2;
        matchedOn.push("scope:project");
      } else if (item.scope === GLOBAL_SCOPE) {
        score += 1;
        matchedOn.push("scope:global");
      }

      if (query.taskType && item.taskType === query.taskType) {
        score += 2;
        matchedOn.push(`taskType:${query.taskType}`);
      }

      score *= item.confidence;

      if (score > 0) scored.push({ item, score, matchedOn });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, query.limit ?? 5);
  }
}
