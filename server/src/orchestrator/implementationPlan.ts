import { slugifyTaskTitle } from "../utils/paths.js";
import type { AgentType, DetectedStack, ImplementationPlan, ImplementationPlanFile, Reconciliation, Task } from "../types/index.js";

/**
 * Builds the unified implementation plan the orchestrator hands to Claude
 * Code (AD-082 — Claude Code executes a reconciled plan rather than
 * independently inventing cross-specialist architecture). File paths are a
 * best-effort convention guess from the detected framework; the real
 * ClaudeCodeExecutor is expected to follow actual repository conventions
 * when it implements, not treat this list as literal.
 */
export function buildImplementationPlan(task: Task, detectedStack: DetectedStack, reconciliation: Reconciliation, agents: AgentType[]): ImplementationPlan {
  const slug = slugifyTaskTitle(task.title) || "feature";
  const files: ImplementationPlanFile[] = [];

  if (agents.includes("python-backend")) {
    if (detectedStack.framework === "FastAPI") {
      files.push(
        { path: `app/${slug}/router.py`, description: "API route handlers." },
        { path: `app/${slug}/service.py`, description: "Business logic / service layer." },
        { path: `app/${slug}/schema.py`, description: "Request/response validation models." },
        { path: `tests/${slug}/test_${slug}.py`, description: "Focused test coverage for the new behavior." }
      );
    } else {
      files.push(
        { path: `app/${slug}.py`, description: "Implementation module." },
        { path: `tests/test_${slug}.py`, description: "Focused test coverage for the new behavior." }
      );
    }
  }

  if (agents.includes("node-backend")) {
    files.push(
      { path: `src/routes/${slug}.ts`, description: "API route handlers." },
      { path: `src/services/${slug}.ts`, description: "Business logic / service layer." },
      { path: `tests/${slug}.test.ts`, description: "Focused test coverage for the new behavior." }
    );
  }

  if (agents.includes("database")) {
    files.push({ path: `migrations/${Date.now()}_${slug}.sql`, description: "Schema/index changes for the new behavior." });
  }

  return {
    taskId: task.id,
    summary: reconciliation.decisions.map((d) => d.decision).join(" ") || task.requirement,
    files,
    validationCommands: [detectedStack.testCommand, detectedStack.lintCommand, detectedStack.typecheckCommand].filter(
      (c): c is string => Boolean(c)
    ),
    createdAt: new Date().toISOString(),
  };
}
