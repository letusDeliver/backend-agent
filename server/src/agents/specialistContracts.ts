import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { AgentType } from "../types/index.js";

/**
 * Loads the repository-local specialist contracts
 * (claude-code-platform-architecture-v0.1/agents/<agent>/CLAUDE.md) rather than
 * duplicating their contents inside the orchestrator, per
 * orchestrator/ORCHESTRATOR.md's explicit "Do Not" rule and
 * README.md's "Do not copy their full instructions into the orchestrator."
 */
const contractCache = new Map<AgentType, string>();

export async function loadSpecialistContract(agent: AgentType): Promise<string> {
  const cached = contractCache.get(agent);
  if (cached) return cached;
  const contractPath = path.join(config.agentsDir, agent, "CLAUDE.md");
  const contract = await readFile(contractPath, "utf-8");
  contractCache.set(agent, contract);
  return contract;
}

export const AGENT_LABELS: Record<AgentType, string> = {
  "python-backend": "Python Backend Agent",
  "node-backend": "Node.js Backend Agent",
  database: "Database Agent",
};
