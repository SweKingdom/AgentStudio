// A minimal JSON API over the task store: GET and POST /api/tasks.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTask, listTasks, ValidationError } from "./tasks.js";

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createServer() {
  return http.createServer(async (req, res) => {
    if (req.url === "/api/tasks" && req.method === "GET") return send(res, 200, listTasks());
    if (req.url === "/api/tasks" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try {
        return send(res, 201, createTask(JSON.parse(raw || "{}")));
      } catch (e) {
        if (e instanceof ValidationError) return send(res, 400, { error: e.message, field: e.field });
        if (e instanceof SyntaxError) return send(res, 400, { error: "The body must be JSON." });
        throw e;
      }
    }
    send(res, 404, { error: "Not found" });
  });
}

// Started directly (npm start), not imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(`Task tracker on http://localhost:${port}`));
}
