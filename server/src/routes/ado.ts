import type { NextFunction, Request, Response, Router } from "express";
import { adoConfigOf, cleanAdoConfig, hasAdoToken, lastSync, syncBacklog, syncRunning, testAdo } from "../ado.js";
import { getProject } from "../store.js";

const wrap =
  (fn: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

/** Azure DevOps backlog sync. The token comes from .env (AZURE_DEVOPS_PAT) and never appears in any response. */
export function registerAdo(api: Router) {
  /** Is ADO set up for this project, is the token there, and how did the last sync go? */
  api.get("/projects/:pid/ado/status", (req, res) => {
    const p = getProject(String(req.params.pid));
    if (!p) return res.status(404).json({ error: "Project not found" });
    const cfg = adoConfigOf(p);
    res.json({ configured: !!cfg, config: cfg, tokenPresent: hasAdoToken(), running: syncRunning(p.id), lastSync: lastSync(p.id) });
  });

  /** Reads the ADO project (nothing is changed). Tests the config in the body when given (unsaved form), else the saved one. */
  api.post(
    "/projects/:pid/ado/test",
    wrap(async (req, res) => {
      const p = getProject(String(req.params.pid));
      if (!p) return res.status(404).json({ error: "Project not found" });
      let cfg;
      try {
        cfg = req.body?.config !== undefined ? cleanAdoConfig(req.body.config) : cleanAdoConfig(p.settings.ado);
      } catch (e) {
        return res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      if (!cfg) return res.json({ ok: false, error: "Enter the organization URL and the Azure DevOps project first" });
      res.json(await testAdo(cfg));
    }),
  );

  /** Creates or updates every backlog item in Azure DevOps. Per-item failures are in the result, not an error status. */
  api.post(
    "/projects/:pid/ado/sync",
    wrap(async (req, res) => {
      const p = getProject(String(req.params.pid));
      if (!p) return res.status(404).json({ error: "Project not found" });
      if (syncRunning(p.id)) return res.status(409).json({ error: "An Azure DevOps sync is already running for this project" });
      try {
        res.json(await syncBacklog(p));
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );
}
