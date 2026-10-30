import type { Response, Router } from "express";
import { createTemplate, deleteTemplate, getTemplate, listTemplates, resolveTemplate, templateFromProject, updateTemplate } from "../templates.js";
import { getProject } from "../store.js";

const bad = (res: Response, e: unknown, status = 400) => res.status(/not found/i.test(String((e as Error)?.message)) ? 404 : status).json({ error: e instanceof Error ? e.message : String(e) });

/** Routers already holding these routes (tests mount them before the coordinator's registration exists). */
const done = new WeakSet<Router>();

/** Agent-network templates: built-in and custom project setups (team roles, run settings, environment slots). */
export function registerTemplates(api: Router) {
  if (done.has(api)) return;
  done.add(api);

  api.get("/templates", (_req, res) => res.json(listTemplates()));

  api.get("/templates/:id", (req, res) => {
    const t = getTemplate(String(req.params.id));
    if (!t) return res.status(404).json({ error: "Template not found" });
    res.json(t);
  });

  /** What a new project from this template pre-selects: agents by role, settings and environment slots to map. */
  api.get("/templates/:id/resolve", (req, res) => {
    try {
      res.json(resolveTemplate(String(req.params.id)));
    } catch (e) {
      bad(res, e);
    }
  });

  api.post("/templates", (req, res) => {
    try {
      res.json(createTemplate(req.body ?? {}));
    } catch (e) {
      bad(res, e);
    }
  });

  api.put("/templates/:id", (req, res) => {
    try {
      res.json(updateTemplate(String(req.params.id), req.body ?? {}));
    } catch (e) {
      bad(res, e);
    }
  });

  api.delete("/templates/:id", (req, res) => {
    try {
      deleteTemplate(String(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      bad(res, e);
    }
  });

  /** "Save as template" from a project: its team roles, run settings and environment slots (without orgs). */
  api.post("/projects/:pid/save-template", (req, res) => {
    const p = getProject(String(req.params.pid));
    if (!p) return res.status(404).json({ error: "Project not found" });
    try {
      res.json(templateFromProject(p, { name: req.body?.name, description: req.body?.description }));
    } catch (e) {
      bad(res, e);
    }
  });
}
