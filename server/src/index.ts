import { createApp } from "./app.js";
import { config } from "./config.js";
import { artifactStore, eventBus, taskStore } from "./container.js";
import { recoverOrphanedTasks } from "./startup/recoverOrphanedTasks.js";

async function main() {
  const recovered = await recoverOrphanedTasks(taskStore, artifactStore, eventBus);
  if (recovered > 0) {
    // eslint-disable-next-line no-console
    console.log(`Startup recovery: ${recovered} orphaned task(s) marked failed. Retry them via POST /tasks/:id/retry.`);
  }

  const app = createApp();

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Backend Engineering Agent Platform orchestrator API listening on http://localhost:${config.port}`);
    // eslint-disable-next-line no-console
    console.log(`Claude Code execution mode: ${config.executionMode.toUpperCase()}`);
  });
}

main();
