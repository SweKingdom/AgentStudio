import "./settings.js"; // loads .env first
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./db.js";
import { api } from "./api.js";
import { authMiddleware } from "./auth.js";
import { seedAgents } from "./agents/store.js";
import { autoResumeTick, recoverInterrupted } from "./orchestrator.js";
import { ensureRepo } from "./git.js";
import { listProjects } from "./store.js";

/** Builds the Express app (API + built web app). Kept separate from `listen` so tests can mount it on a random port. */
export function createApp() {
  seedAgents();
  recoverInterrupted();
  // Every project's workspace is a git repository — initialise any created before repositories existed.
  for (const p of listProjects()) void ensureRepo(p).catch((e) => console.error(`git init ${p.key}:`, e instanceof Error ? e.message : e));
  // Resume on its own after a rate limit, an API overload, or when a spend-limit period resets.
  setInterval(autoResumeTick, 30_000).unref();
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  // Optional sign-in: a no-op until the first admin exists (see auth.ts).
  app.use("/api", authMiddleware);
  app.use("/api", api);
  app.use("/api", (err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });
  const webDist = path.join(ROOT_DIR, "web", "dist");
  if (fs.existsSync(webDist)) {
    // No folder redirects: /guide is a page of the app, even though its screenshots live in dist/guide/.
    app.use(express.static(webDist, { redirect: false }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }
  return app;
}
