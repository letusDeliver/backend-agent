/**
 * Interfaces and storage boundaries for the future engineering memory layer
 * (Project Memory Phase 25/26, AD-093 → AD-102). The MVP deliberately does
 * NOT build the retrieval/vector infrastructure those phases describe —
 * only the type distinctions and a lightweight, replaceable retrieval
 * implementation, per the explicit instruction not to overbuild memory in
 * the MVP.
 */
export type MemoryType = "global_knowledge" | "project_memory" | "task_history" | "candidate_lesson" | "approved_lesson";

export interface MemoryItem {
  id: string;
  type: MemoryType;
  scope: string; // "global" or a repository path
  content: string;
  provenance: string;
  confidence: number;
  supersedes?: string;
  createdAt: string;
}

export interface MemoryStore {
  add(item: MemoryItem): Promise<MemoryItem>;
  list(type?: MemoryType): Promise<MemoryItem[]>;
  /**
   * Lightweight keyword-overlap retrieval. Not semantic/vector search — the
   * seam where a future embeddings-backed implementation can replace this
   * without changing the interface (AD-011's intent, deferred for the MVP).
   */
  retrieve(query: string, scope?: string, limit?: number): Promise<MemoryItem[]>;
}
