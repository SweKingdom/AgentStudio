import type { Router } from "express";
import { projectAccuracy } from "../accuracy.js";
import { getProject } from "../store.js";

/** Estimate vs actual for a project: GET /projects/:pid/accuracy (`{ available: false, reason }` when there's nothing to compare). */
export function registerAccuracy(api: Router) {
  api.get("/projects/:pid/accuracy", (req, res) => {
    // Resolve by id or key here too, so the route works whichever router param handlers are installed.
    const p = getProject(String(req.params.pid));
    if (!p) return res.status(404).json({ error: "Project not found" });
    res.json(projectAccuracy(p.id));
  });
}
