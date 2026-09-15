import { Router } from "express";
import { AGENT_LABELS } from "../agents/specialistContracts.js";
import type { AgentType } from "../types/index.js";

export const specialistsRouter = Router();

const ALL_AGENTS: AgentType[] = ["python-backend", "node-backend", "database"];

specialistsRouter.get("/specialists", (_req, res) => {
  res.json({
    specialists: ALL_AGENTS.map((agent) => ({ agent, label: AGENT_LABELS[agent], status: "available" })),
  });
});
