import { randomUUID } from "node:crypto";
import type { DetectedStack, Reconciliation, Task } from "../types/index.js";
import type { MemoryItem } from "./types.js";

const MIN_DECISION_CONFIDENCE = 0.6;

/**
 * Heuristic secrets/PII filter (Phase 29 brief section 20). This runs before
 * a candidate lesson is ever persisted — a match means the whole candidate
 * is skipped, not redacted, since a partially-redacted "lesson" is still
 * untrustworthy provenance.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /-----BEGIN CERTIFICATE-----/i,
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /\b(api[_-]?key|secret|password|passwd|token|authorization)\s*[:=]\s*['"]?[A-Za-z0-9_\-.]{6,}/i,
];

export function containsSensitiveContent(text: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(text));
}

function stackTechnology(detectedStack: DetectedStack): string[] {
  return [detectedStack.language, detectedStack.framework, detectedStack.database].filter(
    (v): v is string => Boolean(v) && v !== "unknown"
  );
}

/**
 * Derives candidate (not automatically trusted) lessons from a completed
 * task's own reconciliation decisions — data the system already produced,
 * so no new decision-capture mechanism is needed. Only ever called for
 * status: "completed" tasks (Phase 29 brief section 14) — never
 * blocked/failed, and never auto-promoted to validated memory.
 */
export function generateCandidateLessons(task: Task, reconciliation: Reconciliation | null, detectedStack: DetectedStack): MemoryItem[] {
  if (!reconciliation) return [];
  const technology = stackTechnology(detectedStack);
  const now = new Date().toISOString();

  const lessons: MemoryItem[] = [];
  for (const decision of reconciliation.decisions) {
    if (decision.confidence < MIN_DECISION_CONFIDENCE) continue;

    const content = `${decision.decision} — ${decision.rationale}`.trim();
    if (containsSensitiveContent(content) || containsSensitiveContent(decision.evidence)) continue;

    lessons.push({
      id: randomUUID(),
      type: "candidate_lesson",
      scope: task.repository,
      content,
      technology,
      taskType: decision.owner,
      validationStatus: "candidate",
      provenance: {
        taskId: task.id,
        agent: decision.owner,
        artifact: "reconciliation.json",
        decision: decision.decision,
      },
      confidence: decision.confidence,
      createdAt: now,
      updatedAt: now,
    });
  }
  return lessons;
}
