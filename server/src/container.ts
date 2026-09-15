import { config } from "./config.js";
import { JsonFileTaskStore } from "./store/jsonFileTaskStore.js";
import { ArtifactStore } from "./artifacts/artifactStore.js";
import { TaskEventBus } from "./events/eventBus.js";
import { createExecutor, GitWorktreeManager } from "./execution/index.js";
import { TaskOrchestrator } from "./orchestrator/taskOrchestrator.js";
import { JsonFileMemoryStore } from "./memory/jsonFileMemoryStore.js";

export const taskStore = new JsonFileTaskStore(config.dataDir);
export const artifactStore = new ArtifactStore();
export const eventBus = new TaskEventBus(artifactStore);
export const gitWorktrees = new GitWorktreeManager();
export const executor = createExecutor(gitWorktrees);
export const memoryStore = new JsonFileMemoryStore(config.dataDir);
export const orchestrator = new TaskOrchestrator(taskStore, artifactStore, eventBus, executor, gitWorktrees, memoryStore);
