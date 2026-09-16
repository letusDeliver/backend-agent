import { createApp } from "./app.js";
import { config } from "./config.js";
import { artifactStore, eventBus, executor, taskStore } from "./container.js";
import { recoverOrphanedTasks } from "./startup/recoverOrphanedTasks.js";

/**
 * Found as a real gap during manual real-mode validation: killing this
 * process does not, on its own, terminate `claude` CLI child processes it
 * spawned — orphaned real subprocesses were found still running review
 * calls for tasks nobody could ever read the result of. This does not
 * update any task's persisted status — the existing startup recovery sweep
 * (recoverOrphanedTasks, above) already handles a task left non-terminal
 * by an unclean shutdown; this only stops still-running work from
 * continuing to spend real API calls for no reason. Best-effort, not a
 * hard guarantee: gives in-flight children a moment to receive SIGTERM
 * before this process exits, but does not wait for executor.cancel()'s
 * own SIGKILL escalation (5s) — the process is exiting regardless, so a
 * child that ignores SIGTERM becomes the OS's problem, not this one's.
 */
function gracefulShutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`Received ${signal} — terminating in-flight claude CLI processes before exit.`);
  executor.cancelAllInFlight();
  setTimeout(() => process.exit(0), 500);
}

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

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

main();
