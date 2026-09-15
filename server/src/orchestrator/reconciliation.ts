import type { ArchitectureDecision, Reconciliation, SpecialistReport } from "../types/index.js";
import type { RoutingResult } from "./routingEngine.js";

/**
 * Implements the orchestrator's synthesis step (ORCHESTRATOR.md "Reconcile
 * specialist outputs" + Project Memory §176 AGREED/CONFLICT/UNKNOWN/
 * NEEDS_USER_DECISION model). The orchestrator does not silently resolve
 * material conflicts (ORCHESTRATOR.md "Do Not").
 */
export function reconcile(taskId: string, reports: SpecialistReport[], routing: RoutingResult): Reconciliation {
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
  const conflicts: string[] = [];

  let status: Reconciliation["status"];
  if (routing.needsEscalation) {
    status = "NEEDS_USER_DECISION";
    conflicts.push(...routing.rationale.filter((r) => r.toLowerCase().includes("cross-stack") || r.toLowerCase().includes("ambiguous")));
  } else if (anyFailed) {
    status = "UNKNOWN";
    conflicts.push("One or more specialist analyses failed to produce evidence; confidence is insufficient to proceed automatically.");
  } else if (reports.length === 0) {
    status = "UNKNOWN";
  } else {
    status = "AGREED";
  }

  const confidencePercent =
    decisions.length > 0 ? Math.round((decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length) * 100) : 0;

  return {
    taskId,
    status,
    decisions,
    risks,
    conflicts,
    confidencePercent,
    createdAt: new Date().toISOString(),
  };
}
