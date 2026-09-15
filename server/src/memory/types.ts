/**
 * Interfaces and storage boundaries for the engineering memory layer
 * (Project Memory Phase 25/26, AD-093 -> AD-102). Phase 29 wires this into
 * orchestration for the first time; per the explicit build instruction not
 * to overbuild memory, this stays a lightweight, replaceable
 * keyword+tag retrieval implementation, never a vector/RAG pipeline.
 */
export type MemoryType = "task_history" | "project_memory" | "global_knowledge" | "candidate_lesson" | "validated_lesson";

/**
 * Distinguishes what the orchestrator is allowed to trust. Only "validated"
 * items ever influence specialist analysis (see MemoryStore.retrieve). This
 * is enforced by the store itself, not left to individual callers.
 */
export type MemoryValidationStatus = "validated" | "candidate" | "rejected" | "historical";

export interface MemoryProvenance {
  taskId?: string;
  agent?: string;
  artifact?: string;
  decision?: string;
  humanEdited?: boolean;
  approvedAt?: string;
  approvedBy?: string;
  rejectedAt?: string;
}

export interface MemoryItem {
  id: string;
  type: MemoryType;
  scope: string; // "global" or a repository path
  content: string;
  technology: string[];
  taskType?: string;
  validationStatus: MemoryValidationStatus;
  provenance: MemoryProvenance;
  confidence: number;
  supersedes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRetrievalQuery {
  text: string;
  scope: string;
  technology: string[];
  taskType?: string;
  limit?: number;
}

export interface MemoryRetrievalMatch {
  item: MemoryItem;
  score: number;
  matchedOn: string[];
}

export interface MemoryListFilter {
  type?: MemoryType;
  validationStatus?: MemoryValidationStatus;
  scope?: string;
}

export type MemoryUpdatePatch = Partial<Pick<MemoryItem, "type" | "content" | "technology" | "taskType" | "validationStatus" | "provenance">>;

export interface MemoryStore {
  add(item: MemoryItem): Promise<MemoryItem>;
  get(id: string): Promise<MemoryItem | null>;
  list(filter?: MemoryListFilter): Promise<MemoryItem[]>;
  update(id: string, patch: MemoryUpdatePatch): Promise<MemoryItem>;
  /**
   * Relevance-ranked retrieval, hard-filtered to validationStatus ===
   * "validated" before scoring — a caller cannot accidentally pull an
   * unapproved candidate into specialist context through this path.
   * Not semantic/vector search — the seam a future embeddings-backed
   * implementation can replace without changing the interface.
   */
  retrieve(query: MemoryRetrievalQuery): Promise<MemoryRetrievalMatch[]>;
}
