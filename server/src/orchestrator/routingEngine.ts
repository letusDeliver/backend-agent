import type { AgentType, DetectedStack, Task } from "../types/index.js";

export interface RoutingResult {
  agents: AgentType[];
  rationale: string[];
  scenario: string;
  needsEscalation: boolean;
}

const DATABASE_KEYWORDS = [
  "database",
  "postgres",
  "postgresql",
  "mongo",
  "mongodb",
  "redis",
  "schema",
  "migration",
  "index",
  "transaction",
  "persistence",
  "query",
];

const PYTHON_KEYWORDS = ["python", "fastapi", "django", "flask", "pytest", "sqlalchemy"];
const NODE_KEYWORDS = ["node", "node.js", "nodejs", "typescript", "express", "nestjs", "javascript"];
const MIGRATION_KEYWORDS = ["migrat", "port", "rewrite", "cross-stack", "cross stack"];
const API_APPLICATION_KEYWORDS = ["endpoint", "api", "service", "route", "controller", "handler", "application"];

/**
 * Implements the Phase 24 cross-stack routing benchmark matrix
 * (Project Memory §198-203) rather than hard-coding only the example task.
 * Technology alone does not decide specialist selection — engineering
 * responsibility does (AD-090/AD-091): the Database Agent is only added for
 * *material* persistence concerns, and an unresolved/ambiguous backend
 * language after real repository inspection escalates instead of guessing.
 */
export function routeTask(task: Task, detectedStack: DetectedStack): RoutingResult {
  const text = `${task.requirement} ${task.preferredTechnology ?? ""} ${task.preferredDatabase ?? ""} ${task.constraints ?? ""}`.toLowerCase();
  const rationale: string[] = [];

  const mentionsPython = PYTHON_KEYWORDS.some((k) => text.includes(k));
  const mentionsNode = NODE_KEYWORDS.some((k) => text.includes(k));
  const mentionsMigration = MIGRATION_KEYWORDS.some((k) => text.includes(k));
  const mentionsDatabase = DATABASE_KEYWORDS.some((k) => text.includes(k));
  const mentionsApplicationWork = API_APPLICATION_KEYWORDS.some((k) => text.includes(k));

  const backendLanguage: "python" | "node" | "unknown" =
    detectedStack.language !== "unknown" ? detectedStack.language : mentionsPython && !mentionsNode ? "python" : mentionsNode && !mentionsPython ? "node" : "unknown";

  if (backendLanguage === "unknown" && !mentionsDatabase) {
    rationale.push(
      "Repository inspection could not determine a backend language and the requirement does not name one either."
    );
    return {
      agents: [],
      rationale,
      scenario: "Ambiguous stack — repository-first inspection inconclusive",
      needsEscalation: true,
    };
  }

  // Cross-stack migration: both ecosystems are materially implicated.
  const crossStackSignal = (mentionsPython && mentionsNode) || (mentionsMigration && (mentionsPython || mentionsNode) && detectedStack.language !== "unknown" && ((detectedStack.language === "python" && mentionsNode) || (detectedStack.language === "node" && mentionsPython)));
  if (crossStackSignal) {
    rationale.push("Requirement implicates both Python and Node.js ecosystems (cross-stack migration).");
    const agents: AgentType[] = ["python-backend", "node-backend"];
    if (mentionsDatabase || detectedStack.database) {
      agents.push("database");
      rationale.push("Database Agent added: migration work has material persistence implications.");
    }
    return {
      agents,
      rationale,
      scenario: "Cross-stack migration",
      needsEscalation: true, // benchmark marks this scenario "Potential" escalation
    };
  }

  // Database-only: persistence work with no application/API surface implicated.
  if (mentionsDatabase && !mentionsApplicationWork && backendLanguage === "unknown") {
    rationale.push("Requirement is persistence-focused with no application/API surface implicated.");
    return { agents: ["database"], rationale, scenario: "Database-only", needsEscalation: false };
  }

  const agents: AgentType[] = [];
  if (backendLanguage === "python") {
    agents.push("python-backend");
    rationale.push("Backend language resolved to Python from repository evidence/requirement.");
  } else if (backendLanguage === "node") {
    agents.push("node-backend");
    rationale.push("Backend language resolved to Node.js from repository evidence/requirement.");
  }

  // A repository dependency on a database is not, by itself, a material
  // concern (AD-090) — the Database Agent is only added when the
  // requirement text actually implicates persistence/schema/query work.
  const materialDatabaseConcern = mentionsDatabase;
  if (materialDatabaseConcern) {
    agents.push("database");
    rationale.push(
      "Database Agent added: requirement or repository evidence shows a material persistence concern, not merely an incidental dependency."
    );
  } else if (detectedStack.database) {
    rationale.push(
      `Repository uses ${detectedStack.database} but the requirement has no material persistence concern — Database Agent not invoked.`
    );
  }

  if (agents.length === 0) {
    // Pure database-only fallback when a backend language was resolved but
    // the requirement is nonetheless entirely persistence-scoped.
    if (mentionsDatabase) {
      return { agents: ["database"], rationale, scenario: "Database-only", needsEscalation: false };
    }
  }

  return {
    agents,
    rationale,
    scenario: agents.length > 1 ? `${backendLanguage} + ${detectedStack.database ?? "database"}` : `${backendLanguage}-only API`,
    needsEscalation: false,
  };
}
