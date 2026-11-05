import type { NextFunction, Request, Response, Router } from "express";
import { adoConfigOf, cleanAdoConfig, hasAdoToken, lastSync, syncBacklog, syncRunning, testAdo } from "../ado.js";
import { getProject, patchProject } from "../store.js";
import { fetchAdoItems, importBacklog, mappingFor, type AdoImportFilter } from "../adoimport.js";
import { cleanMapping, computeMapping, defaultMapping } from "../adomapping.js";
import { cleanWorkRule } from "../ownership.js";
import { isRunning } from "../orchestrator.js";

/** The import filter from a request: an area path, an iteration path and tags, all optional. */
function cleanFilter(input: unknown): AdoImportFilter {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const path = (v: unknown) => String(v ?? "").trim().replace(/\//g, "\\").slice(0, 400) || undefined;
  const tags = Array.isArray(o.tags) ? [...new Set(o.tags.map((t) => String(t ?? "").trim()).filter(Boolean))].slice(0, 20) : [];
  return { areaPath: path(o.areaPath), iterationPath: path(o.iterationPath), ...(tags.length ? { tags } : {}) };
}

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

  /** What an import would bring, read from Azure DevOps without saving anything: counts by type, state and assignee. */
  api.post(
    "/projects/:pid/ado/import/preview",
    wrap(async (req, res) => {
      const p = getProject(String(req.params.pid));
      if (!p) return res.status(404).json({ error: "Project not found" });
      try {
        const cfg = cleanAdoConfig(req.body?.config ?? p.settings.ado);
        if (!cfg) return res.status(400).json({ error: "Enter the organization URL and the Azure DevOps project first" });
        // The saved mapping, or the one worked out from the project's process now: shown so it can be checked first.
        const mapping = req.body?.mapping ? cleanMapping(req.body.mapping, await mappingFor(p.id, cfg)) : await mappingFor(p.id, cfg);
        const items = await fetchAdoItems(cfg, cleanFilter(req.body?.filter), mapping);
        const count = (key: (i: (typeof items)[number]) => string) => items.reduce<Record<string, number>>((m, i) => ((m[key(i)] = (m[key(i)] ?? 0) + 1), m), {});
        res.json({ total: items.length, byType: count((i) => i.type), byState: count((i) => i.adoState), byAssignee: count((i) => i.assignee ?? ""), byIteration: count((i) => i.iteration ?? ""), mapping, mappingSaved: !!p.settings.adoMapping });
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  /** Imports (or re-imports) the backlog from Azure DevOps. Optionally sets AgentStudio's rule at the same time. */
  api.post(
    "/projects/:pid/ado/import",
    wrap(async (req, res) => {
      const p = getProject(String(req.params.pid));
      if (!p) return res.status(404).json({ error: "Project not found" });
      if (isRunning(p.id)) return res.status(409).json({ error: "The project is running — pause it before importing." });
      try {
        const cfg = cleanAdoConfig(req.body?.config ?? p.settings.ado);
        if (!cfg) return res.status(400).json({ error: "Enter the organization URL and the Azure DevOps project first" });
        if (req.body?.rule !== undefined) patchProject(p.id, { settings: { ...p.settings, workRule: cleanWorkRule(req.body.rule) } });
        const mapping = req.body?.mapping ? cleanMapping(req.body.mapping, await mappingFor(p.id, cfg)) : undefined;
        res.json(await importBacklog(p.id, cfg, cleanFilter(req.body?.filter ?? p.settings.adoImport), mapping));
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  /** Save a corrected mapping (fields, types, what each state means, where write-back moves stories). */
  api.put("/projects/:pid/ado/mapping", (req, res) => {
    const p = getProject(String(req.params.pid));
    if (!p) return res.status(404).json({ error: "Project not found" });
    try {
      const mapping = cleanMapping(req.body?.mapping, p.settings.adoMapping ?? defaultMapping());
      patchProject(p.id, { settings: { ...p.settings, adoMapping: mapping } });
      res.json(mapping);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Work the mapping out again from the project's process (after the board's states or fields changed). */
  api.post(
    "/projects/:pid/ado/mapping/refresh",
    wrap(async (req, res) => {
      const p = getProject(String(req.params.pid));
      if (!p) return res.status(404).json({ error: "Project not found" });
      try {
        const cfg = cleanAdoConfig(req.body?.config ?? p.settings.ado);
        if (!cfg) return res.status(400).json({ error: "Enter the organization URL and the Azure DevOps project first" });
        const mapping = await computeMapping(cfg);
        if (p.settings.adoMapping) patchProject(p.id, { settings: { ...p.settings, adoMapping: mapping } });
        res.json(mapping);
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );
}
