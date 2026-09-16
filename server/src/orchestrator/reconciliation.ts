import { randomUUID } from "node:crypto";
import type {
  AgentType,
  ArchitectureDecision,
  ConflictParticipant,
  DetectedStack,
  Reconciliation,
  ReconciliationConflict,
  ReviewReport,
  SpecialistReport,
} from "../types/index.js";
import type { RoutingResult } from "./routingEngine.js";
import { KNOWN_DATABASES, memoryForAgent, type ContextPack } from "../memory/contextPack.js";
import { AGENT_LABELS } from "../agents/specialistContracts.js";
import {
  classifyDecisionText,
  extractDecision,
  groupBySubject,
  materialityOf,
  type ExtractedDecision,
} from "./decisionExtraction.js";

/**
 * Implements the orchestrator's synthesis step (ORCHESTRATOR.md "Reconcile
 * specialist outputs" + Project Memory §176 AGREED/CONFLICT/UNKNOWN/
 * NEEDS_USER_DECISION model), extended in Phase 30 with real conflict
 * detection (PHASE_30_IMPLEMENTATION_PLAN.md). The orchestrator does not
 * silently resolve material conflicts (ORCHESTRATOR.md "Do Not").
 */
export function reconcile(
  taskId: string,
  reports: SpecialistReport[],
  routing: RoutingResult,
  detectedStack: DetectedStack | null,
  contextPack: ContextPack | null
): Reconciliation {
  const decisions: ArchitectureDecision[] = reports
    .filter((r) => r.status === "completed")
    .map((r) => ({
      decision: r.recommendation,
      alternatives: [],
      evidence: r.findings.map((f) => f.evidence).join("; ") || "No direct repository evidence captured.",
      rationale: r.findings.map((f) => f.summary).join("; ") || r.recommendation,
      confidence: r.confidence,
      owner: r.agent,
    }));

  const risks = reports.flatMap((r) => r.risks);
  const anyFailed = reports.some((r) => r.status === "failed");

  const conflicts: ReconciliationConflict[] = [];
  const agreements: string[] = [];

  // Conflict detection only runs once there is real specialist output to
  // compare — an escalated/failed reconciliation has nothing trustworthy to
  // reconcile in the first place.
  if (!anyFailed && !routing.needsEscalation && reports.length > 0) {
    const extracted = reports
      .map((r) => extractDecision(r, contextPack ? memoryForAgent(r.agent, contextPack) : []))
      .filter((d): d is ExtractedDecision => d !== null);

    for (const group of groupBySubject(extracted)) {
      if (group.length < 2) continue;
      const polarities = new Set(group.map((d) => d.polarity));
      if (polarities.size > 1) {
        conflicts.push(buildSpecialistConflict(group, "reconciliation"));
      } else {
        agreements.push(describeAgreement(group));
      }
    }

    if (detectedStack?.database) {
      // Checked against every decision, not just category === "database" —
      // a recommendation can name the wrong database technology while
      // primarily being a transaction/data-model/etc. decision (plan
      // section 6/8: evidence conflicts are a fact about a specific
      // mentioned technology, independent of the decision's category).
      for (const decision of extracted) {
        const conflict = buildEvidenceConflict(decision, detectedStack.database);
        if (conflict) conflicts.push(conflict);
      }
    }
  }

  const unresolvedQuestions: string[] = [];

  let status: Reconciliation["status"];
  if (routing.needsEscalation) {
    status = "NEEDS_USER_DECISION";
    unresolvedQuestions.push(...routing.rationale.filter((r) => r.toLowerCase().includes("cross-stack") || r.toLowerCase().includes("ambiguous")));
  } else if (anyFailed) {
    status = "UNKNOWN";
    unresolvedQuestions.push("One or more specialist analyses failed to produce evidence; confidence is insufficient to proceed automatically.");
  } else if (reports.length === 0) {
    status = "UNKNOWN";
  } else if (conflicts.some((c) => !c.resolution)) {
    status = "CONFLICT";
  } else {
    status = "AGREED";
  }

  for (const conflict of conflicts) {
    if (!conflict.resolution) unresolvedQuestions.push(describeUnresolvedQuestion(conflict));
  }

  const confidencePercent =
    decisions.length > 0 ? Math.round((decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length) * 100) : 0;

  return {
    taskId,
    status,
    decisions,
    agreements,
    conflicts,
    unresolvedQuestions,
    risks,
    confidencePercent,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Whether any *material* conflict in a reconciliation remains unresolved —
 * the sole implementation-blocking gate (plan section 10). Non-material or
 * already-resolved conflicts never block.
 */
export function hasUnresolvedMaterialConflict(reconciliation: Pick<Reconciliation, "conflicts">): boolean {
  return reconciliation.conflicts.some((c) => c.materiality === "material" && !c.resolution);
}

/**
 * Recomputes `status` for an already-built reconciliation after a conflict
 * resolution is persisted — a pure re-derivation over the existing
 * `conflicts` array (which now carries the resolution), not a re-run of
 * detection. Mirrors the same precedence `reconcile()` uses.
 */
export function recomputeStatus(reconciliation: Reconciliation): Reconciliation["status"] {
  if (reconciliation.status === "NEEDS_USER_DECISION" || reconciliation.status === "UNKNOWN") {
    return reconciliation.status;
  }
  return reconciliation.conflicts.some((c) => !c.resolution) ? "CONFLICT" : "AGREED";
}

/**
 * Applies the same detection engine to a review attempt's blocking findings
 * (plan section 10 — review-stage conflicts). Findings from fewer than two
 * agents can't disagree, so this only ever returns conflicts when 2+ agents
 * produced blocking findings in the same attempt.
 */
export function detectReviewConflicts(reviews: ReviewReport[]): ReconciliationConflict[] {
  const items: { agent: AgentType; decision: ExtractedDecision }[] = [];
  for (const review of reviews) {
    for (const finding of review.findings) {
      if (finding.severity !== "blocking") continue;
      const text = `${finding.summary} ${finding.recommendation}`;
      const { category, polarity, significantTerms } = classifyDecisionText(text);
      items.push({
        agent: review.agent,
        decision: {
          agent: review.agent,
          category,
          polarity,
          text: finding.summary,
          rationale: finding.recommendation,
          evidence: finding.location ?? "No specific location reported.",
          confidence: 1,
          significantTerms,
          memoryInfluenced: false,
          memoryIds: [],
        },
      });
    }
  }
  if (items.length < 2) return [];

  const conflicts: ReconciliationConflict[] = [];
  for (const group of groupBySubject(items.map((i) => i.decision))) {
    if (group.length < 2) continue;
    const distinctAgents = new Set(group.map((d) => d.agent));
    if (distinctAgents.size < 2) continue;
    const polarities = new Set(group.map((d) => d.polarity));
    if (polarities.size > 1) conflicts.push(buildSpecialistConflict(group, "review"));
  }
  return conflicts;
}

function buildSpecialistConflict(group: ExtractedDecision[], detectedAt: "reconciliation" | "review"): ReconciliationConflict {
  const category = group[0].category;
  const labels = group.map((d) => AGENT_LABELS[d.agent]);
  const stances = group.map((d) => `${AGENT_LABELS[d.agent]} is ${d.polarity}`).join(", ");
  const sharedTerms = [...group[0].significantTerms].filter((term) => group.every((d) => d.significantTerms.has(term)));
  const subject = sharedTerms.length > 0 ? `${category} (${sharedTerms.slice(0, 3).join(", ")})` : category;
  const participants: ConflictParticipant[] = group.map((d) => ({
    agent: d.agent,
    decision: d.text,
    rationale: d.rationale,
    evidence: d.evidence,
    confidence: d.confidence,
    polarity: d.polarity,
    memoryInfluenced: d.memoryInfluenced,
    memoryIds: d.memoryIds,
  }));

  return {
    id: randomUUID(),
    kind: "specialist-disagreement",
    category,
    subject,
    detectedAt,
    participants,
    materiality: materialityOf(category),
    reason: `${labels.join(" and ")} both address "${category}" for this task, but state opposite positions (${stances}).`,
    resolution: null,
    createdAt: new Date().toISOString(),
  };
}

function normalizeDbName(name: string): string {
  const n = name.toLowerCase();
  if (n === "postgres" || n === "postgresql") return "postgresql";
  if (n === "mongo" || n === "mongodb") return "mongodb";
  return n;
}

function mentionedDatabase(text: string): string | null {
  const lower = text.toLowerCase();
  for (const db of KNOWN_DATABASES) {
    if (lower.includes(db)) return db;
  }
  return null;
}

/**
 * "Recommendation names X, repository evidence shows Y" — never rewrites the
 * agent's recommendation (plan section 6/8), only records the contradiction.
 * Always material: acting on a database name the repository doesn't
 * actually use is the kind of mistake that is expensive to discover late.
 */
function buildEvidenceConflict(decision: ExtractedDecision, actualDatabase: string): ReconciliationConflict | null {
  const mentioned = mentionedDatabase(`${decision.text} ${decision.rationale} ${decision.evidence}`);
  if (!mentioned) return null;
  if (normalizeDbName(mentioned) === normalizeDbName(actualDatabase)) return null;

  return {
    id: randomUUID(),
    kind: "evidence-contradiction",
    category: "database",
    subject: "database technology",
    detectedAt: "reconciliation",
    participants: [
      {
        agent: decision.agent,
        decision: decision.text,
        rationale: decision.rationale,
        evidence: decision.evidence,
        confidence: decision.confidence,
        polarity: decision.polarity,
        memoryInfluenced: decision.memoryInfluenced,
        memoryIds: decision.memoryIds,
      },
    ],
    repositoryEvidence: `Repository evidence indicates ${actualDatabase}.`,
    materiality: "material",
    reason: `${AGENT_LABELS[decision.agent]}'s recommendation names ${mentioned} but repository evidence shows ${actualDatabase}.`,
    resolution: null,
    createdAt: new Date().toISOString(),
  };
}

function describeAgreement(group: ExtractedDecision[]): string {
  const labels = group.map((d) => AGENT_LABELS[d.agent]).join(" and ");
  return `${labels} agree on ${group[0].category}: ${group[0].text}`;
}

export function describeUnresolvedQuestion(conflict: ReconciliationConflict): string {
  if (conflict.kind === "evidence-contradiction") {
    return `Confirm or correct ${AGENT_LABELS[conflict.participants[0].agent]}'s ${conflict.category} recommendation against repository evidence before implementation.`;
  }
  const labels = conflict.participants.map((p) => AGENT_LABELS[p.agent]).join(" and ");
  return `Resolve ${conflict.category} disagreement between ${labels} before implementation.`;
}
