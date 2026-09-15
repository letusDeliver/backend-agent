import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend Engineering Agent Platform orchestrator API listening on http://localhost:${config.port}`);
  // eslint-disable-next-line no-console
  console.log(`Claude Code execution mode: ${config.executionMode.toUpperCase()}`);
});
