import { createApp } from "./app.js";
import { effectiveMode } from "./settings.js";

const port = Number(process.env.PORT) || 4100;
createApp().listen(port, "127.0.0.1", () => {
  console.log(`\n  AgentStudio API on http://localhost:${port}  ·  mode: ${effectiveMode()}\n`);
});
