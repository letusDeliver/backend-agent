import type { AgentType, DetectedStack, Task } from "../types/index.js";
import type { MemoryStore, MemoryType, MemoryValidationStatus } from "./types.js";

export interface ContextPackEntry {
  memoryId: string;
  type: MemoryType;
  validationStatus: MemoryValidationStatus;
  scope: string;
  confidence: number;
  technology: string[];
  summary: string;
  reason: string;
  score: number;
}

export interface ContextPack {
  taskId: string;
  query: { text: string; technology: string[]; scope: string };
  retrievedCount: number;
  includedCount: number;
  excludedCount: number;
  entries: ContextPackEntry[];
  excludedIds: string[];
  conflicts: string[];
  createdAt: string;
}

const MAX_INCLUDED = 3;
const FETCH_LIMIT = 8;
const SUMMARY_LENGTH = 240;

const KNOWN_DATABASES = ["postgresql", "postgres", "mysql", "mongodb", "mongo", "sqlite", "redis"];

function stackTechnology(detectedStack: DetectedStack): string[] {
  return [detectedStack.language, detectedStack.framework, detectedStack.database].filter(
    (v): v is string => Boolean(v) && v !== "unknown"
  );
}

/**
 * A retrieved memory item that names a different database than the current
 * repository's own detected evidence is flagged, never silently trusted —
 * repository evidence always takes precedence (Phase 29 brief section 11).
 */
function detectConflicts(entries: ContextPackEntry[], detectedStack: DetectedStack): string[] {
  if (!detectedStack.database) return [];
  const actual = detectedStack.database.toLowerCase();
  const conflicts: string[] = [];
  for (const entry of entries) {
    const dbTags = entry.technology.map((t) => t.toLowerCase()).filter((t) => KNOWN_DATABASES.includes(t));
    if (dbTags.length > 0 && !dbTags.includes(actual)) {
      conflicts.push(
        `Memory item ${entry.memoryId} suggests ${dbTags.join("/")} but repository evidence shows ${detectedStack.database}. Repository evidence takes precedence.`
      );
    }
  }
  return conflicts;
}

export async function buildContextPack(task: Task, detectedStack: DetectedStack, memoryStore: MemoryStore): Promise<ContextPack> {
  const technology = stackTechnology(detectedStack);
  const text = [task.requirement, task.constraints ?? ""].join(" ").trim();
  const matches = await memoryStore.retrieve({ text, scope: task.repository, technology, limit: FETCH_LIMIT });

  const included = matches.slice(0, MAX_INCLUDED);
  const excluded = matches.slice(MAX_INCLUDED);

  const entries: ContextPackEntry[] = included.map((m) => ({
    memoryId: m.item.id,
    type: m.item.type,
    validationStatus: m.item.validationStatus,
    scope: m.item.scope,
    confidence: m.item.confidence,
    technology: m.item.technology,
    summary: m.item.content.slice(0, SUMMARY_LENGTH),
    reason: m.matchedOn.length > 0 ? m.matchedOn.join(", ") : "relevance score",
    score: m.score,
  }));

  return {
    taskId: task.id,
    query: { text, technology, scope: task.repository },
    retrievedCount: matches.length,
    includedCount: entries.length,
    excludedCount: excluded.length,
    entries,
    excludedIds: excluded.map((m) => m.item.id),
    conflicts: detectConflicts(entries, detectedStack),
    createdAt: new Date().toISOString(),
  };
}

const AGENT_TECH_FAMILIES: Record<AgentType, string[]> = {
  database: KNOWN_DATABASES.concat("database", "sql"),
  "python-backend": ["python", "django", "flask", "fastapi"],
  "node-backend": ["node", "express", "javascript", "typescript"],
};

/**
 * Per-agent filtering: a Postgres-tagged lesson should not reach a
 * Node-only analysis call, and a Python-specific lesson should not reach
 * Node analysis (Phase 29 brief section 13). Entries with no technology
 * tag at all are treated as general/global guidance and reach every agent.
 */
export function memoryForAgent(agent: AgentType, pack: ContextPack): ContextPackEntry[] {
  const family = AGENT_TECH_FAMILIES[agent];
  return pack.entries.filter((entry) => {
    if (entry.technology.length === 0) return true;
    const tech = entry.technology.map((t) => t.toLowerCase());
    return tech.some((t) => family.includes(t));
  });
}
