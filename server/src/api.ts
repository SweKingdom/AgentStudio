import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, all, get, insert, now, parseJson, run, uid } from "./db.js";
import { emit, subscribe } from "./events.js";
import { DEFAULT_MODELS, models } from "./pricing.js";
import { setSetting } from "./db.js";
import { appSettings, claudeBackend, effectiveMode, hasApiKey, saveAppSettings } from "./settings.js";
import { ROLES, PIPELINE_ROLES, PSEUDO_AGENTS, type Role } from "./agents/roles.js";
import { createAgent, defaultAgentFor, deleteAgent, getAgent, listAgents, listVersions, resetAgent, restoreVersion, updateAgent, type Agent } from "./agents/store.js";
import { CATEGORIES, toolCatalog } from "./agents/tools.js";
import { buildSystemPrompt, countPdfTokens } from "./agents/runner.js";
import { deleteCustomKnowledge, listKnowledge, saveCustomKnowledge } from "./knowledge.js";
import { estimateProject } from "./estimate.js";
import { buildPlanFromText, readPdf } from "./agents/simplan.js";
import { approveGate, buildStages, fixBug, humanTransition, isPausing, pauseAll, resumeAll, startItem, startPlan, isRunning, listJobs, pauseProject, pipelineRunning, releaseNow, reportBug, rerunItem, startProject, teamOf, type RerunRole } from "./orchestrator.js";
import { chat, chatHistory } from "./chat.js";
import { autoResumeAllowed, globalPause, spendStatus } from "./pause.js";
import { ensureRepo, gitLog, listBranches, providerOf, repoName, testRemoteUrl, validateRepoUrl, webUrlOf } from "./git.js";
import { runChecks } from "./doctor.js";
import { cleanAdoConfig } from "./ado.js";
import { registerAdo } from "./routes/ado.js";
import { registerAuth } from "./routes/auth.js";
import { registerAccuracy } from "./routes/accuracy.js";
import { codeReviewMode } from "./review.js";
import { CUSTOM_AGENTS_ENABLED } from "./team.js";
import { registerTemplates } from "./routes/templates.js";
import { audit } from "./auth.js";
import { DEFAULT_TEAM, applyImport, cleanChecksOverride, exportTeam, planImport, saveTeamSettings, teamSettings } from "./team.js";
import { checksFor } from "./checks.js";
import { adoImportCsv, backlogCsv, workspaceZip } from "./exports.js";
import {
  createItem,
  getItem,
  getProject,
  listItems,
  listProjects,
  listWorkspaceFiles,
  logActivity,
  openQuestionCount,
  patchItem,
  patchProject,
  postMessage,
  projectDir,
  readWorkspaceFile,
  readWorkspaceBinary,
  worktreeDir,
  uniqueProjectKey,
  type Project,
  type WorkItem,
} from "./store.js";

export const api = Router();

// Projects can be addressed by id or by key (e.g. /projects/SCR); normalise to the id.
api.param("pid", (req, res, next, value: string) => {
  const p = getProject(value);
  if (!p) return res.status(404).json({ error: "Project not found" });
  req.params.pid = p.id;
  next();
});

const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, `${uid("up")}.pdf`),
  }),
  limits: { fileSize: 32 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf")),
});

const wrap =
  (fn: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

const STATES = [
  "New", "Requires additional information", "Ready for Refinement", "Ready for Sprint", "To Do", "In Progress",
  "In Peer Testing", "Ready for UAT", "Release Ready", "Smoke Testing", "Deployed (Done)", "Blocked", "Cancelled",
];

// ---------------------------------------------------------------- meta & settings

api.get("/events", (_req, res) => subscribe(res));

api.get("/meta", (_req, res) => {
  res.json({
    mode: effectiveMode(),
    hasApiKey: hasApiKey(),
    backend: claudeBackend(),
    globalPause: (() => {
      const gp = globalPause();
      return gp ? { ...gp, autoResume: autoResumeAllowed(gp) } : null;
    })(),
    spend: spendStatus(),
    settings: appSettings(),
    models: models(),
    roles: Object.values(ROLES).map(({ prompt: _p, ...r }) => r),
    pipelineRoles: PIPELINE_ROLES,
    tools: toolCatalog(),
    categories: CATEGORIES,
    states: STATES,
    pseudoAgents: Object.values(PSEUDO_AGENTS),
  });
});

api.put("/settings", (req, res) => {
  const body = req.body ?? {};
  if (body.mode !== undefined && body.mode !== "live" && body.mode !== "simulation") return res.status(400).json({ error: "Mode must be live or simulation" });
  if (body.backend !== undefined && !["auto", "api", "subscription"].includes(body.backend)) return res.status(400).json({ error: "Backend must be auto, api or subscription" });
  saveAppSettings(body);
  audit(req, "settings.update", "app", Object.keys(body));
  emit({ type: "project" });
  res.json(appSettings());
});

api.put("/models", (req, res) => {
  setSetting("models", Array.isArray(req.body) && req.body.length ? req.body : DEFAULT_MODELS);
  audit(req, "models.update", "prices");
  res.json(models());
});

// ---------------------------------------------------------------- knowledge

api.get("/knowledge", (_req, res) => res.json(listKnowledge()));
api.post("/knowledge", (req, res) => {
  const { title, summary = "", content = "", id } = req.body ?? {};
  if (!title) return res.status(400).json({ error: "title is required" });
  res.json({ id: saveCustomKnowledge({ id, title, summary, content }) });
});
api.delete("/knowledge/:id", (req, res) => {
  deleteCustomKnowledge(String(req.params.id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- agents

function agentStats() {
  const rows = all<{ agent_id: string; calls: number; cost: number; inp: number; out: number; cr: number; cw: number; ms: number }>(
    `SELECT agent_id, COUNT(*) calls, SUM(cost_usd) cost, SUM(input_tokens) inp, SUM(output_tokens) out,
            SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw, SUM(duration_ms) ms FROM llm_calls GROUP BY agent_id`,
  );
  const runs = all<{ agent_id: string; runs: number; active: number; items: number }>(
    `SELECT agent_id, COUNT(*) runs, SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) active, COUNT(DISTINCT item_id) items
     FROM runs GROUP BY agent_id`,
  );
  const msgs = all<{ id: string; sent: number }>("SELECT from_agent_id id, COUNT(*) sent FROM messages GROUP BY from_agent_id");
  const projects = all<{ agent_id: string; n: number }>("SELECT agent_id, COUNT(DISTINCT project_id) n FROM runs GROUP BY agent_id");
  return (id: string) => {
    const c = rows.find((r) => r.agent_id === id);
    const r = runs.find((x) => x.agent_id === id);
    return {
      calls: c?.calls ?? 0,
      costUsd: c?.cost ?? 0,
      inputTokens: c?.inp ?? 0,
      outputTokens: c?.out ?? 0,
      cacheReadTokens: c?.cr ?? 0,
      cacheWriteTokens: c?.cw ?? 0,
      busyMs: c?.ms ?? 0,
      runs: r?.runs ?? 0,
      active: r?.active ?? 0,
      itemsTouched: r?.items ?? 0,
      messagesSent: msgs.find((m) => m.id === id)?.sent ?? 0,
      projects: projects.find((p) => p.agent_id === id)?.n ?? 0,
    };
  };
}

function agentView(a: Agent, stats = agentStats()) {
  const prompt = buildSystemPrompt(a);
  return { ...a, promptTokens: Math.round(prompt.length / 3.6), stats: stats(a.id) };
}

api.get("/agents", (_req, res) => {
  const stats = agentStats();
  res.json(listAgents().map((a) => agentView(a, stats)));
});

api.get("/agents/:id", (req, res) => {
  const a = getAgent(String(req.params.id));
  if (!a) return res.status(404).json({ error: "Agent not found" });
  const recent = all(
    `SELECT r.*, p.key project_key, w.code item_code FROM runs r LEFT JOIN projects p ON p.id = r.project_id
     LEFT JOIN work_items w ON w.id = r.item_id WHERE r.agent_id = ? ORDER BY r.started_at DESC LIMIT 30`,
    a.id,
  );
  res.json({ ...agentView(a), systemPrompt: buildSystemPrompt(a), recentRuns: recent });
});

api.post("/agents", (req, res) => {
  // Custom agents are turned off for now: the team is the 7 built-in agents (edit, reset, disable — not create).
  if (!CUSTOM_AGENTS_ENABLED) return res.status(403).json({ error: "Creating custom agents is turned off for now. Edit one of the built-in agents instead." });
  const body = req.body ?? {};
  const role: Role = (body.role in ROLES ? body.role : "specialist") as Role;
  const base = body.cloneFrom ? getAgent(body.cloneFrom) : undefined;
  const agent = defaultAgentFor(role, {
    ...(base ? { ...base, id: uid("agt"), is_builtin: false, created_at: now(), updated_at: now(), name: `${base.name} (copy)` } : {}),
    ...pick(body, ["name", "name_story", "title", "description", "system_prompt", "model", "effort", "color", "icon", "knowledge", "custom_knowledge", "tools", "config", "max_turns"]),
  });
  const saved = createAgent(agent);
  emit({ type: "agent", data: saved });
  logActivity({ projectId: null, agentId: saved.id, type: "agent", summary: `Agent ${saved.name} created (${ROLES[saved.role].title})` });
  res.json(agentView(saved));
});

api.put("/agents/:id", (req, res) => {
  const id = String(req.params.id);
  if (!getAgent(id)) return res.status(404).json({ error: "Agent not found" });
  const saved = updateAgent(
    id,
    pick(req.body ?? {}, ["name", "name_story", "title", "description", "system_prompt", "model", "effort", "color", "icon", "knowledge", "custom_knowledge", "tools", "config", "max_turns", "enabled"]),
  )!;
  emit({ type: "agent", data: saved });
  res.json(agentView(saved));
});

api.post("/agents/:id/reset", (req, res) => {
  const saved = resetAgent(String(req.params.id));
  if (!saved) return res.status(404).json({ error: "Agent not found" });
  emit({ type: "agent", data: saved });
  res.json(agentView(saved));
});

api.delete("/agents/:id", (req, res) => {
  const id = String(req.params.id);
  // A built-in agent can't be recreated while custom agents are off — disable or reset it instead.
  if (!CUSTOM_AGENTS_ENABLED && getAgent(id)?.is_builtin) return res.status(403).json({ error: "Built-in agents can't be deleted. Disable it or reset it to its role defaults instead." });
  const inUse = listProjects().filter((p) => p.agent_ids.includes(id) && isRunning(p.id));
  if (inUse.length) return res.status(409).json({ error: `Agent is working on ${inUse.map((p) => p.key).join(", ")}` });
  deleteAgent(id);
  emit({ type: "agent" });
  res.json({ ok: true });
});

function pick<T extends object>(o: T, keys: string[]): Partial<Agent> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if ((o as Record<string, unknown>)[k] !== undefined) out[k] = (o as Record<string, unknown>)[k];
  return out as Partial<Agent>;
}

// ---------------------------------------------------------------- projects

const pdfCache = new Map<string, { text: string; pages: number }>();
/** PDF text + pages, read once per upload (re-estimates happen on every form change). */
async function readPdfCached(file: string) {
  let v = pdfCache.get(file);
  if (!v) {
    try {
      v = await readPdf(file);
    } catch {
      v = { text: "", pages: 0 };
    }
    pdfCache.set(file, v);
    if (pdfCache.size > 50) pdfCache.delete(pdfCache.keys().next().value!);
  }
  return v;
}

function countPages(file: string) {
  const buf = fs.readFileSync(file).toString("latin1");
  const n = (buf.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  return n || null;
}

function projectSummary(p: Project) {
  const items = listItems(p.id);
  const deliverables = items.filter((i) => i.type === "story" || i.type === "task" || i.type === "bug");
  const cost = get<{ c: number; t: number }>("SELECT COALESCE(SUM(cost_usd),0) c, COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens),0) t FROM llm_calls WHERE project_id = ?", p.id)!;
  const openQuestions = get<{ n: number }>("SELECT COUNT(*) n FROM questions WHERE project_id = ? AND (answer IS NULL OR answer = '')", p.id)!.n;
  const activeRuns = all<{ agent_id: string; item_id: string | null; stage: string }>("SELECT agent_id, item_id, stage FROM runs WHERE project_id = ? AND status = 'running'", p.id);
  return {
    ...p,
    running: isRunning(p.id),
    pipelineRunning: pipelineRunning(p.id),
    pausing: isPausing(p.id),
    checks: checksFor(p),
    repoInfo: p.settings.repo?.url
      ? { url: p.settings.repo.url, branch: p.settings.repo.branch || "main", push: p.settings.repo.push === true, provider: providerOf(p.settings.repo.url), name: repoName(p.settings.repo.url), webUrl: webUrlOf(p.settings.repo.url) }
      : null,
    jobs: listJobs(p.id),
    counts: {
      epics: items.filter((i) => i.type === "epic").length,
      features: items.filter((i) => i.type === "feature").length,
      stories: deliverables.length,
      done: deliverables.filter((i) => i.state === "Deployed (Done)").length,
      releaseReady: deliverables.filter((i) => ["Release Ready", "Smoke Testing", "Deployed (Done)"].includes(i.state)).length,
      inProgress: deliverables.filter((i) => ["In Progress", "In Peer Testing", "Ready for UAT"].includes(i.state)).length,
      blocked: deliverables.filter((i) => i.state === "Blocked").length,
      points: deliverables.reduce((n, i) => n + (i.story_points ?? 0), 0),
    },
    costUsd: cost.c,
    tokens: cost.t,
    openQuestions,
    activeRuns,
  };
}

api.get("/projects", (_req, res) => res.json(listProjects().map(projectSummary)));

api.post(
  "/projects/estimate",
  upload.single("pdf"),
  wrap(async (req, res) => {
    const body = req.body ?? {};
    const agentIds: string[] = parseJson(body.agentIds, Array.isArray(body.agentIds) ? body.agentIds : []);
    let uploadId: string | null = body.uploadId || null;
    let pdfName: string | null = body.pdfName || null;
    if (req.file) {
      uploadId = path.basename(req.file.filename, ".pdf");
      pdfName = req.file.originalname;
    }
    const file = uploadId ? path.join(UPLOAD_DIR, `${path.basename(uploadId)}.pdf`) : null;
    const agents = listAgents().filter((a) => agentIds.includes(a.id));
    // The estimate comes from the requirements themselves: the PDF's text (or the description) analysed locally.
    let pages: number | null = null;
    let text = String(body.description ?? "");
    if (file && fs.existsSync(file)) {
      const pdf = await readPdfCached(file);
      pages = pdf.pages || countPages(file);
      text = `${pdf.text}\n\n${text}`.trim();
    }
    if (text.trim().length < 80) {
      return res.json({ uploadId, pdfName, pdfPages: pages, pdfTokens: null, estimate: null, reason: "Add the requirements (PDF or a description of at least a few sentences) to get an estimate." });
    }
    const plan = buildPlanFromText(text, String(body.name ?? "") || "Project");
    const detected = plan
      ? plan.epics.flatMap((e) => e.features.flatMap((f) => f.stories.map((s) => ({ title: s.title, category: s.category, points: s.points, pointsWhy: s.pointsWhy, feature: f.title, epic: e.title }))))
      : [];
    let tokens: number | null = body.pdfTokens ? Number(body.pdfTokens) : null;
    if (!tokens && file && fs.existsSync(file) && effectiveMode() === "live") {
      const reqAgent = agents.find((a) => a.role === "requirements");
      tokens = await countPdfTokens(fs.readFileSync(file).toString("base64"), reqAgent?.model ?? "claude-opus-5-5");
    }
    const parallelism = Number(body.parallelism) || appSettings().defaultParallelism;
    const estimate = estimateProject({
      agents,
      pdfPages: pages,
      pdfTokens: tokens,
      descriptionChars: String(body.description ?? "").length,
      textChars: text.length,
      stories: detected.length ? detected : undefined,
      epics: plan?.epics.length,
      features: plan?.epics.reduce((n, e) => n + e.features.length, 0),
      source: "document",
      parallelism,
      maxRework: Number(body.maxRework ?? appSettings().maxRework),
      codeReview: codeReviewMode(body.codeReview),
    });
    res.json({ uploadId, pdfName, pdfPages: pages, pdfTokens: tokens, estimate });
  }),
);

api.post("/projects", wrap(async (req, res) => {
  const body = req.body ?? {};
  const name = String(body.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Project name is required" });
  const repoCheck = validateRepoUrl(String(body.settings?.repo?.url ?? ""));
  if (!repoCheck.ok) return res.status(400).json({ error: repoCheck.error });
  const branch = String(body.settings?.repo?.branch ?? "main").trim() || "main";
  if (!/^[\w./-]+$/.test(branch)) return res.status(400).json({ error: "Invalid branch name" });
  const agentIds: string[] = Array.isArray(body.agentIds) ? body.agentIds : [];
  if (!agentIds.length) return res.status(400).json({ error: "Select at least one agent" });
  const s = appSettings();
  let checks: ReturnType<typeof cleanChecksOverride>;
  try {
    checks = cleanChecksOverride(body.settings?.checks);
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
  const settings = {
    ...(Object.keys(checks).length ? { checks } : {}),
    gates: body.settings?.gates ?? s.defaultGates,
    parallelism: Number(body.settings?.parallelism ?? s.defaultParallelism),
    budgetUsd: Number(body.settings?.budgetUsd ?? s.defaultBudgetUsd),
    maxRework: Number(body.settings?.maxRework ?? s.maxRework),
    codeReview: codeReviewMode(body.settings?.codeReview),
    repo: { url: repoCheck.url, branch, push: body.settings?.repo?.push === true },
  };
  const id = uid("prj");
  const key = body.key ? String(body.key).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) : uniqueProjectKey(name);
  if (get("SELECT 1 FROM projects WHERE key = ?", key)) return res.status(409).json({ error: `Project key ${key} already exists` });
  const dir = projectDir({ key });
  fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
  let pdfFile: string | null = null;
  if (body.uploadId) {
    const src = path.join(UPLOAD_DIR, `${path.basename(body.uploadId)}.pdf`);
    if (fs.existsSync(src)) {
      pdfFile = path.join(dir, "requirements.pdf");
      fs.renameSync(src, pdfFile);
    }
  }
  const ts = now();
  const stages = buildStages({ agent_ids: agentIds, settings });
  insert("projects", {
    id,
    key,
    name,
    description: String(body.description ?? ""),
    status: "ready",
    stages,
    pdf_file: pdfFile,
    pdf_name: body.pdfName ?? null,
    pdf_pages: body.pdfPages ?? null,
    pdf_tokens: body.pdfTokens ?? null,
    agent_ids: agentIds,
    settings,
    estimate: body.estimate ?? null,
    mode: effectiveMode(),
    created_at: ts,
    updated_at: ts,
  });
  const team = listAgents().filter((a) => agentIds.includes(a.id));
  logActivity({ projectId: id, agentId: "human", type: "project", summary: `Project ${key} created with ${team.map((a) => a.name).join(", ")}` });
  postMessage({ projectId: id, from: "human", to: "orchestrator", kind: "handoff", content: `New project "${name}"${body.pdfName ? ` from ${body.pdfName}` : ""}.` });
  await ensureRepo(getProject(id)!);
  emit({ type: "project", projectId: id });
  if (body.start) startProject(id);
  res.json(projectSummary(getProject(id)!));
}));

api.get("/projects/:pid", (req, res) => {
  const p = getProject(String(req.params.pid));
  if (!p) return res.status(404).json({ error: "Project not found" });
  const team = teamOf(p);
  const items = listItems(p.id).filter((i) => i.type === "story" || i.type === "task");
  const liveEstimate =
    items.length > 0
      ? estimateProject({
          agents: team,
          pdfPages: p.pdf_pages,
          pdfTokens: p.pdf_tokens,
          descriptionChars: p.description.length,
          source: "backlog",
          stories: items.map((i) => ({ title: i.title, category: i.category, points: i.story_points ?? 3 })),
          epics: listItems(p.id).filter((i) => i.type === "epic").length || undefined,
          features: listItems(p.id).filter((i) => i.type === "feature").length || undefined,
          parallelism: p.settings.parallelism,
          maxRework: p.settings.maxRework,
          codeReview: codeReviewMode(p.settings.codeReview),
        })
      : null;
  res.json({ ...projectSummary(p), team: team.map((a) => a.id), liveEstimate });
});

api.patch("/projects/:pid", wrap(async (req, res) => {
  const p = getProject(String(req.params.pid));
  if (!p) return res.status(404).json({ error: "Project not found" });
  const body = req.body ?? {};
  const patch: Partial<Project> = {};
  if (body.settings?.repo !== undefined) {
    const check = validateRepoUrl(String(body.settings.repo?.url ?? ""));
    if (!check.ok) return res.status(400).json({ error: check.error });
    const branch = String(body.settings.repo?.branch ?? "main").trim() || "main";
    if (!/^[\w./-]+$/.test(branch)) return res.status(400).json({ error: "Invalid branch name" });
    body.settings.repo = { url: check.url, branch, push: body.settings.repo?.push === true };
  }
  if (body.name) patch.name = String(body.name);
  if (body.description !== undefined) patch.description = String(body.description);
  if (body.settings?.ado !== undefined) {
    try {
      body.settings.ado = cleanAdoConfig(body.settings.ado);
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (body.settings?.checks !== undefined) {
    try {
      body.settings.checks = cleanChecksOverride(body.settings.checks);
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (body.settings) patch.settings = { ...p.settings, ...body.settings };
  if (Array.isArray(body.agentIds) && !isRunning(p.id)) {
    patch.agent_ids = body.agentIds;
    const fresh = buildStages({ agent_ids: body.agentIds, settings: patch.settings ?? p.settings });
    patch.stages = fresh.map((s) => {
      const old = p.stages.find((o) => o.key === s.key);
      return old && (old.status === "done" || old.status === "awaiting_approval") ? { ...s, status: old.status } : s;
    });
  } else if (body.settings?.gates !== undefined && !isRunning(p.id)) {
    const fresh = buildStages({ agent_ids: p.agent_ids, settings: patch.settings! });
    patch.stages = fresh.map((s) => {
      const old = p.stages.find((o) => o.key === s.key);
      return old && old.status === "done" ? old : s;
    });
  }
  const saved = patchProject(p.id, patch)!;
  if (body.settings?.repo) await ensureRepo(saved);
  res.json(projectSummary(saved));
}));

api.delete("/projects/:pid", (req, res) => {
  const p = getProject(String(req.params.pid));
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (isRunning(p.id)) return res.status(409).json({ error: "Pause the project before deleting it" });
  run("DELETE FROM projects WHERE id = ?", p.id);
  fs.rmSync(projectDir(p), { recursive: true, force: true });
  // Who deleted what and when — deletes can't be undone.
  audit(req, "project.delete", p.key, { name: p.name });
  emit({ type: "project", projectId: p.id });
  res.json({ ok: true });
});

api.post("/projects/:pid/start", (req, res) => {
  const p = getProject(String(req.params.pid));
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (p.status === "awaiting_approval") return res.status(409).json({ error: "Approve the pending gate first" });
  try {
    if (p.mode === "simulation" && effectiveMode() === "live" && req.body?.switchToLive) patchProject(p.id, { mode: "live" });
    startProject(p.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post("/projects/:pid/pause", (req, res) => {
  pauseProject(String(req.params.pid), req.body?.mode === "now" ? "now" : "graceful");
  res.json({ ok: true });
});

api.post("/pause-all", (req, res) => {
  pauseAll({ mode: req.body?.mode === "now" ? "now" : "graceful", kind: "user", reason: "Paused by you.", resumeAt: null });
  res.json({ ok: true, globalPause: globalPause() });
});

api.post("/resume-all", (req, res) => {
  try {
    res.json({ ok: true, ...resumeAll(Boolean(req.body?.force)) });
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post("/projects/:pid/approve", (req, res) => {
  try {
    const before = getProject(String(req.params.pid));
    approveGate(String(req.params.pid));
    audit(req, "gate.approve", before?.key ?? String(req.params.pid), { stage: before?.stage });
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.get("/projects/:pid/pdf", (req, res) => {
  const p = getProject(String(req.params.pid));
  if (!p?.pdf_file || !fs.existsSync(p.pdf_file)) return res.status(404).end();
  res.type("application/pdf").sendFile(p.pdf_file);
});

// ---------------------------------------------------------------- work items

function phaseRows(where: string, ...params: string[]) {
  return all<{ item_id: string; phase: string; agent_id: string; iteration: number; started_at: string; ended_at: string | null; outcome: string | null }>(
    `SELECT item_id, phase, agent_id, iteration, started_at, ended_at, outcome FROM item_phases WHERE ${where} ORDER BY started_at`,
    ...params,
  );
}

api.get("/projects/:pid/items", (req, res) => {
  const p = getProject(String(req.params.pid));
  if (!p) return res.status(404).json({ error: "Project not found" });
  const items = listItems(p.id);
  const costs = all<{ item_id: string; c: number }>("SELECT item_id, SUM(cost_usd) c FROM llm_calls WHERE project_id = ? AND item_id IS NOT NULL GROUP BY item_id", p.id);
  const phases = phaseRows("project_id = ?", p.id);
  const tests = all<{ item_id: string; pass: number; fail: number; blocked: number }>(
    `SELECT item_id, SUM(result='pass') pass, SUM(result='fail') fail, SUM(result='blocked') blocked FROM test_results WHERE project_id = ? GROUP BY item_id`,
    p.id,
  );
  const active = all<{ item_id: string; agent_id: string }>("SELECT item_id, agent_id FROM runs WHERE project_id = ? AND status = 'running' AND item_id IS NOT NULL", p.id);
  const openQ = all<{ item_id: string; n: number }>("SELECT item_id, COUNT(*) n FROM questions WHERE project_id = ? AND item_id IS NOT NULL AND (answer IS NULL OR answer = '') GROUP BY item_id", p.id);
  res.json(
    items.map((it) => ({
      ...it,
      costUsd: costs.find((c) => c.item_id === it.id)?.c ?? 0,
      phases: phases.filter((ph) => ph.item_id === it.id),
      tests: tests.find((t) => t.item_id === it.id) ?? null,
      activeAgent: active.find((a) => a.item_id === it.id)?.agent_id ?? null,
      openQuestions: openQ.find((q) => q.item_id === it.id)?.n ?? 0,
    })),
  );
});

api.post("/projects/:pid/items", (req, res) => {
  const p = getProject(String(req.params.pid));
  if (!p) return res.status(404).json({ error: "Project not found" });
  const b = req.body ?? {};
  if (!b.title || !b.type) return res.status(400).json({ error: "type and title are required" });
  const parent = b.parent_id ? getItem(String(b.parent_id)) : undefined;
  const item = createItem(p.id, {
    type: b.type,
    title: String(b.title).trim(),
    category: b.category ?? parent?.category ?? "development",
    parent_id: parent?.id ?? null,
    state: b.state ?? (b.type === "epic" || b.type === "feature" ? "New" : "Ready for Refinement"),
    user_story: b.user_story ?? "",
    background: b.background ?? "",
    acceptance_criteria: b.acceptance_criteria ?? "",
    story_points: b.story_points ? Number(b.story_points) : null,
    tags: ["Added by product owner"],
    created_by: "human",
  });
  logActivity({ projectId: p.id, agentId: "human", itemId: item.id, type: "item_created", summary: `You created ${item.code} — ${item.title}` });
  res.json(item);
});

api.get("/items/:id", (req, res) => {
  const it = getItem(String(req.params.id));
  if (!it) return res.status(404).json({ error: "Item not found" });
  const parent = it.parent_id ? getItem(it.parent_id) : null;
  const children = listItems(it.project_id).filter((c) => c.parent_id === it.id).map((c) => ({ id: c.id, code: c.code, title: c.title, type: c.type, state: c.state, category: c.category }));
  res.json({
    ...it,
    parent: parent ? { id: parent.id, code: parent.code, title: parent.title, type: parent.type } : null,
    children,
    phases: phaseRows("item_id = ?", it.id),
    tests: all("SELECT * FROM test_results WHERE item_id = ? ORDER BY id", it.id),
    messages: all("SELECT * FROM messages WHERE item_id = ? ORDER BY id", it.id),
    activity: all("SELECT * FROM activity WHERE item_id = ? ORDER BY id DESC LIMIT 200", it.id),
    files: (() => {
      const versioned = all<{ path: string }>(
        `SELECT path, MAX(agent_id) agent_id, SUM(added) added, SUM(removed) removed, MAX(created_at) updated_at, COUNT(*) versions, MIN(version) first_version, MAX(version) last_version
         FROM file_versions WHERE item_id = ? GROUP BY path ORDER BY path`,
        it.id,
      );
      // Files written before version history existed.
      const legacy = all<{ path: string }>("SELECT path, agent_id, bytes, updated_at FROM files WHERE item_id = ? ORDER BY path", it.id).filter((f) => !versioned.some((v) => v.path === f.path));
      return [...versioned, ...legacy];
    })(),
    documents: all("SELECT id, kind, title, version, updated_at FROM documents WHERE item_id = ?", it.id),
    questions: all("SELECT * FROM questions WHERE item_id = ? ORDER BY id", it.id),
    comments: all("SELECT * FROM comments WHERE item_id = ? ORDER BY id", it.id),
    bugs: listItems(it.project_id).filter((b) => b.type === "bug" && b.parent_id === it.id).map((b) => ({ id: b.id, code: b.code, title: b.title, state: b.state })),
    busy: all("SELECT 1 FROM runs WHERE item_id = ? AND status = 'running'", it.id).length > 0 || listJobs(it.project_id).some((j) => j.itemId === it.id),
    cost: get(
      "SELECT COALESCE(SUM(cost_usd),0) costUsd, COUNT(*) calls, COALESCE(SUM(input_tokens+cache_read_tokens+cache_write_tokens),0) inputTokens, COALESCE(SUM(output_tokens),0) outputTokens FROM llm_calls WHERE item_id = ?",
      it.id,
    ),
    costByAgent: all("SELECT agent_id, SUM(cost_usd) costUsd, COUNT(*) calls FROM llm_calls WHERE item_id = ? GROUP BY agent_id ORDER BY costUsd DESC", it.id),
  });
});

api.patch("/items/:id", (req, res) => {
  const it = getItem(String(req.params.id));
  if (!it) return res.status(404).json({ error: "Item not found" });
  const allowed = [
    "title", "category", "state", "priority", "moscow", "story_points", "sprint", "rank", "user_story", "background",
    "business_rules", "dependencies", "out_of_scope", "acceptance_criteria", "tech_spec", "how_to_test", "manual_steps", "tags",
  ];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (req.body?.[k] !== undefined) patch[k] = req.body[k];
  if (patch.state && patch.state !== it.state) {
    if (all("SELECT 1 FROM runs WHERE item_id = ? AND status = 'running'", it.id).length || listJobs(it.project_id).some((j) => j.itemId === it.id)) {
      return res.status(409).json({ error: `${it.code} is being worked on by an agent — wait until it finishes.` });
    }
    const why = humanTransition(it.state, String(patch.state));
    if (why) return res.status(409).json({ error: why });
  }
  const saved = patchItem(it.id, patch as Partial<WorkItem>);
  logActivity({ projectId: it.project_id, agentId: "human", itemId: it.id, type: "item_updated", summary: `You edited ${it.code}: ${Object.keys(patch).join(", ")}` });
  res.json(saved);
});


// ---------------------------------------------------------------- human control: reorder, split, comments, re-runs, bugs, release

api.post("/projects/:pid/items/reorder", (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const items = listItems(String(req.params.pid)).filter((i) => i.type === "story" || i.type === "task" || i.type === "bug");
  const ordered = [...ids.map((id) => items.find((i) => i.id === id)).filter((i): i is WorkItem => Boolean(i)), ...items.filter((i) => !ids.includes(i.id)).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))];
  ordered.forEach((it, idx) => { if (it.rank !== idx + 1) patchItem(it.id, { rank: idx + 1 }); });
  logActivity({ projectId: String(req.params.pid), agentId: "human", type: "item_planned", summary: "You re-prioritised the backlog" });
  res.json({ ok: true });
});

api.post("/items/:id/split", (req, res) => {
  const it = getItem(String(req.params.id));
  if (!it) return res.status(404).json({ error: "Item not found" });
  const title = String(req.body?.title ?? "").trim();
  const move: number[] = Array.isArray(req.body?.acIndexes) ? req.body.acIndexes.map(Number) : [];
  if (!title) return res.status(400).json({ error: "The new story needs a title" });
  const blocks = it.acceptance_criteria.split(/(?=^### AC \d+:)/m).map((b) => b.trim()).filter((b) => /^### AC \d+:/.test(b));
  if (move.length && move.length >= blocks.length) return res.status(400).json({ error: "Keep at least one acceptance criterion on the original story" });
  const renumber = (list: string[]) => list.map((b, i) => b.replace(/^### AC \d+:/, `### AC ${i + 1}:`)).join("\n\n");
  const keep = blocks.filter((_, i) => !move.includes(i));
  const moved = blocks.filter((_, i) => move.includes(i));
  const half = it.story_points ? Math.max(1, Math.round(it.story_points / 2)) : null;
  const created = createItem(it.project_id, {
    type: it.type === "bug" ? "bug" : it.type,
    title,
    parent_id: it.parent_id,
    category: it.category,
    state: ["Ready for Sprint", "To Do", "Ready for Refinement", "New"].includes(it.state) ? it.state : "Ready for Refinement",
    user_story: it.user_story,
    background: `${it.background}\n\nSplit from ${it.code}.`.trim(),
    business_rules: it.business_rules,
    acceptance_criteria: renumber(moved),
    tech_spec: it.tech_spec,
    sprint: it.sprint,
    rank: it.rank != null ? it.rank + 1 : null,
    story_points: half,
    tags: [...it.tags, `Split from ${it.code}`],
    created_by: "human",
  });
  if (blocks.length) patchItem(it.id, { acceptance_criteria: renumber(keep), story_points: half });
  logActivity({ projectId: it.project_id, agentId: "human", itemId: created.id, type: "item_created", summary: `You split ${it.code} → ${created.code} (${moved.length} AC moved)` });
  res.json(created);
});

api.post("/items/:id/comments", (req, res) => {
  const it = getItem(String(req.params.id));
  if (!it) return res.status(404).json({ error: "Item not found" });
  const content = String(req.body?.content ?? "").trim();
  if (!content) return res.status(400).json({ error: "Comment is empty" });
  insert("comments", { project_id: it.project_id, item_id: it.id, author_id: "human", content, created_at: now() });
  logActivity({ projectId: it.project_id, agentId: "human", itemId: it.id, type: "note", summary: `You commented on ${it.code}: ${content.slice(0, 120)}` });
  emit({ type: "item", projectId: it.project_id });
  res.json({ ok: true });
});

api.get("/items/:id/start-plan", (req, res) => {
  try {
    res.json(startPlan(String(req.params.id)));
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post("/items/:id/start", (req, res) => {
  try {
    startItem(String(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post("/items/:id/rerun", (req, res) => {
  try {
    const role = String(req.body?.role ?? "developer") as RerunRole;
    if (!["requirements", "architect", "developer", "qa", "writer"].includes(role)) return res.status(400).json({ error: "Unknown role" });
    res.json(rerunItem(String(req.params.id), role, String(req.body?.feedback ?? "")));
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post("/items/:id/bugs", (req, res) => {
  const b = req.body ?? {};
  if (!b.title || !b.expected || !b.actual) return res.status(400).json({ error: "Title, expected and actual behaviour are required" });
  try {
    const bug = reportBug(String(req.params.id), {
      title: String(b.title),
      steps: String(b.steps ?? ""),
      expected: String(b.expected),
      actual: String(b.actual),
      severity: ["1 - Critical", "2 - High", "3 - Medium", "4 - Low"].includes(b.severity) ? b.severity : "3 - Medium",
    });
    if (b.fixNow) fixBug(bug.id, Boolean(b.release));
    res.json(bug);
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post("/items/:id/fix", (req, res) => {
  try {
    fixBug(String(req.params.id), Boolean(req.body?.release));
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post("/projects/:pid/release-now", (req, res) => {
  try {
    releaseNow(String(req.params.pid), Array.isArray(req.body?.itemIds) ? req.body.itemIds.map(String) : undefined);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Is this machine ready? `network=1` also checks GitHub and Claude model access (all free, read-only). */
api.get(
  "/system/check",
  wrap(async (req, res) => res.json(await runChecks({ network: req.query.network === "1" }))),
);

// ---------------------------------------------------------------- team: conventions, checks, templates

api.get("/team", (_req, res) => res.json({ ...teamSettings(), defaults: DEFAULT_TEAM }));

api.put("/team", (req, res) => {
  try {
    const saved = saveTeamSettings(req.body ?? {});
    audit(req, "team.update", "team", Object.keys(req.body ?? {}));
    res.json(saved);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Download the team as a portable template file (no API keys or credentials). */
api.get("/team/export", (req, res) => {
  const t = exportTeam({ name: req.query.name ? String(req.query.name) : undefined, description: req.query.description ? String(req.query.description) : undefined });
  const file = `${t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "team"}.agentstudio-team.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
  res.type("application/json").send(JSON.stringify(t, null, 2));
});

/** What importing a team file would change — nothing is applied. */
api.post("/team/import/preview", (req, res) => {
  try {
    res.json(planImport(req.body?.template));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post("/team/import", (req, res) => {
  try {
    const plan = applyImport(req.body?.template);
    audit(req, "team.import", String(req.body?.template?.name ?? "template"));
    emit({ type: "agent" });
    res.json(plan);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------------------------------------------------------------- chat with an agent

api.get("/agents/:id/chat", (req, res) => {
  const pid = req.query.projectId ? getProject(String(req.query.projectId))?.id ?? null : null;
  res.json(chatHistory(String(req.params.id), pid));
});

api.post(
  "/agents/:id/chat",
  wrap(async (req, res) => {
    const a = getAgent(String(req.params.id));
    if (!a) return res.status(404).json({ error: "Agent not found" });
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "Message is empty" });
    const pid = req.body?.projectId ? getProject(String(req.body.projectId))?.id ?? null : null;
    res.json(await chat(a, pid, message));
  }),
);

// ---------------------------------------------------------------- agent versions

api.get("/agents/:id/versions", (req, res) => {
  const id = String(req.params.id);
  const stats = all<{ v: number; runs: number; cost: number; turns: number }>(
    `SELECT r.agent_version v, COUNT(DISTINCT r.id) runs, COALESCE(SUM(c.cost_usd),0) cost, COALESCE(AVG(r.turns),0) turns
     FROM runs r LEFT JOIN llm_calls c ON c.run_id = r.id WHERE r.agent_id = ? GROUP BY r.agent_version`,
    id,
  );
  const reworkByVersion = all<{ v: number; tested: number; rejected: number }>(
    `SELECT r.agent_version v, COUNT(*) tested, SUM(CASE WHEN EXISTS (SELECT 1 FROM item_phases ph WHERE ph.item_id = r.item_id AND ph.phase = 'qa' AND ph.outcome = 'changes_requested') THEN 1 ELSE 0 END) rejected
     FROM runs r WHERE r.agent_id = ? AND r.stage = 'development' AND r.item_id IS NOT NULL GROUP BY r.agent_version`,
    id,
  );
  res.json(
    listVersions(id).map((v) => {
      const s = stats.find((x) => x.v === v.version);
      const q = reworkByVersion.find((x) => x.v === v.version);
      return { ...v, runs: s?.runs ?? 0, costUsd: s?.cost ?? 0, avgTurns: s?.turns ?? 0, reworkRate: q && q.tested ? q.rejected / q.tested : null };
    }),
  );
});

api.post("/agents/:id/versions/:v/restore", (req, res) => {
  const saved = restoreVersion(String(req.params.id), Number(req.params.v));
  if (!saved) return res.status(404).json({ error: "Version not found" });
  emit({ type: "agent", data: saved });
  res.json(agentView(saved));
});

// ---------------------------------------------------------------- exports

api.get("/projects/:pid/export/workspace.zip", (req, res) => {
  const p = getProject(String(req.params.pid))!;
  res.setHeader("Content-Disposition", `attachment; filename="${p.key}-workspace.zip"`);
  res.type("application/zip").send(workspaceZip(p));
});

api.get("/projects/:pid/export/backlog.csv", (req, res) => {
  const p = getProject(String(req.params.pid))!;
  res.setHeader("Content-Disposition", `attachment; filename="${p.key}-backlog.csv"`);
  res.type("text/csv").send(backlogCsv(p));
});

api.get("/projects/:pid/export/azure-devops.csv", (req, res) => {
  const p = getProject(String(req.params.pid))!;
  res.setHeader("Content-Disposition", `attachment; filename="${p.key}-azure-devops-import.csv"`);
  res.type("text/csv").send(adoImportCsv(p));
});

api.get("/documents/:id/download", (req, res) => {
  const d = get<{ title: string; content: string }>("SELECT title, content FROM documents WHERE id = ?", String(req.params.id));
  if (!d) return res.status(404).json({ error: "Document not found" });
  res.setHeader("Content-Disposition", `attachment; filename="${d.title.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "")}.md"`);
  res.type("text/markdown").send(d.content);
});

/** Everything the PDF project report needs, computed from the project's real data. */
api.get(
  "/projects/:pid/report",
  wrap(async (req, res) => {
    const p = getProject(String(req.params.pid))!;
    const st = appSettings();
    const items = listItems(p.id);
    const deliverables = items.filter((i) => i.type === "story" || i.type === "task" || i.type === "bug");
    const byId = new Map(items.map((i) => [i.id, i]));
    const costs = new Map(all<{ item_id: string; c: number }>("SELECT item_id, SUM(cost_usd) c FROM llm_calls WHERE project_id = ? AND item_id IS NOT NULL GROUP BY item_id", p.id).map((r) => [r.item_id, r.c]));
    const tests = all<{ item_id: string; kind: string; result: string }>("SELECT item_id, kind, result FROM test_results WHERE project_id = ?", p.id);
    const phases = all<{ item_id: string; phase: string; started_at: string; ended_at: string | null; outcome: string | null }>("SELECT item_id, phase, started_at, ended_at, outcome FROM item_phases WHERE project_id = ? ORDER BY started_at", p.id);
    const secs = (a: string, b: string | null) => (new Date(b ?? now()).getTime() - new Date(a).getTime()) / 1000;
    const openQ = all<{ item_id: string | null; n: number }>("SELECT item_id, COUNT(*) n FROM questions WHERE project_id = ? AND (answer IS NULL OR answer = '') GROUP BY item_id", p.id);
    const item = (i: WorkItem) => {
      const t = tests.filter((x) => x.item_id === i.id && x.kind === "qa");
      const ph = phases.filter((x) => x.item_id === i.id);
      const sum = (name: string) => ph.filter((x) => x.phase === name).reduce((n, x) => n + secs(x.started_at, x.ended_at), 0);
      const first = ph[0]?.started_at;
      const last = ph.filter((x) => x.ended_at).at(-1)?.ended_at ?? null;
      return {
        id: i.id, code: i.code, type: i.type, title: i.title, category: i.category, state: i.state, points: i.story_points, sprint: i.sprint,
        moscow: i.moscow, priority: i.priority, rework: i.rework_count, costUsd: costs.get(i.id) ?? 0, userStory: i.user_story,
        qa: { pass: t.filter((x) => x.result === "pass").length, fail: t.filter((x) => x.result === "fail").length, blocked: t.filter((x) => x.result === "blocked").length },
        smoke: tests.some((x) => x.item_id === i.id && x.kind === "smoke" && x.result === "pass"),
        openQuestions: openQ.find((q) => q.item_id === i.id)?.n ?? 0,
        seconds: { development: sum("development"), qa: sum("qa"), documentation: sum("documentation") },
        leadTimeSeconds: first && last ? secs(first, last) : null,
        humanHours: i.human_hours,
      };
    };
    const epics = items.filter((i) => i.type === "epic").map((e) => ({
      code: e.code, title: e.title, background: e.background,
      features: items.filter((f) => f.parent_id === e.id && f.type === "feature").map((f) => ({ code: f.code, title: f.title, items: items.filter((x) => x.parent_id === f.id && x.type !== "feature").map(item) })),
    }));
    const orphans = deliverables.filter((i) => !i.parent_id || !byId.has(i.parent_id) || byId.get(i.parent_id)!.type === "story" || byId.get(i.parent_id)!.type === "task").filter((i) => !epics.some((e) => e.features.some((f) => f.items.some((x) => x.id === i.id)))).map(item);
    const costByAgent = all<{ agent_id: string; cost: number; calls: number; ms: number; runs: number }>("SELECT agent_id, SUM(cost_usd) cost, COUNT(*) calls, SUM(duration_ms) ms, COUNT(DISTINCT run_id) runs FROM llm_calls WHERE project_id = ? GROUP BY agent_id ORDER BY cost DESC", p.id);
    const costByStage = all<{ stage: string; cost: number; calls: number }>("SELECT stage, SUM(cost_usd) cost, COUNT(*) calls FROM llm_calls WHERE project_id = ? GROUP BY stage ORDER BY cost DESC", p.id);
    const totals = get<{ cost: number; calls: number; tokens: number; ms: number; simulated: number }>("SELECT COALESCE(SUM(cost_usd),0) cost, COUNT(*) calls, COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens),0) tokens, COALESCE(SUM(duration_ms),0) ms, COALESCE(SUM(simulated),0) simulated FROM llm_calls WHERE project_id = ?", p.id)!;
    const team = listAgents().filter((a) => p.agent_ids.includes(a.id)).map((a) => {
      const c = costByAgent.find((x) => x.agent_id === a.id);
      return { id: a.id, name: a.name, title: a.title, role: a.role, model: a.model, effort: a.effort, color: a.color, version: a.version, costUsd: c?.cost ?? 0, calls: c?.calls ?? 0, runs: c?.runs ?? 0, busySeconds: (c?.ms ?? 0) / 1000 };
    });
    const qaAll = tests.filter((x) => x.kind === "qa");
    const tested = deliverables.filter((i) => phases.some((x) => x.item_id === i.id && x.phase === "qa"));
    const points = deliverables.reduce((n, i) => n + (i.story_points ?? 0), 0);
    const humanHours = points * st.hoursPerStoryPoint * 1.35;
    const elapsed = p.started_at ? secs(p.started_at, p.finished_at) : 0;
    const releases = all<{ version: string; created_at: string; validation: string | null; notes: string }>("SELECT version, created_at, validation, notes FROM releases WHERE project_id = ? ORDER BY created_at", p.id).map((r) => {
      const v = r.validation ? (JSON.parse(r.validation) as { ok: boolean; mode: string }) : null;
      return { version: r.version, date: r.created_at, validationOk: v?.ok ?? null, validationMode: v?.mode ?? null, items: (r.notes.match(/^\| [A-Z]{2}-\d+ \|/gm) ?? []).length };
    });
    const questions = all<{ question: string; answer: string | null; item_code: string | null; created_at: string; answered_at: string | null }>(
      "SELECT q.question, q.answer, w.code item_code, q.created_at, q.answered_at FROM questions q LEFT JOIN work_items w ON w.id = q.item_id WHERE q.project_id = ? ORDER BY q.id",
      p.id,
    );
    const docOrder = ["project_brief", "solution_design", "delivery_plan", "user_manual", "technical_overview", "release_notes", "changelog"];
    const documents = all<{ id: string; kind: string; title: string; content: string; version: number; updated_at: string; item_id: string | null; item_code: string | null }>(
      "SELECT d.id, d.kind, d.title, d.content, d.version, d.updated_at, d.item_id, w.code item_code FROM documents d LEFT JOIN work_items w ON w.id = d.item_id WHERE d.project_id = ?",
      p.id,
    );
    let commits = 0;
    try {
      commits = (await gitLog(p, 1000)).commits.length;
    } catch {
      commits = 0;
    }
    res.json({
      generatedAt: now(),
      project: {
        key: p.key, name: p.name, description: p.description, status: p.status, mode: p.mode, createdAt: p.created_at, startedAt: p.started_at, finishedAt: p.finished_at,
        pdfName: p.pdf_name, repo: p.settings.repo ?? null, gates: p.settings.gates, budgetUsd: p.settings.budgetUsd,
      },
      kpis: {
        epics: items.filter((i) => i.type === "epic").length, features: items.filter((i) => i.type === "feature").length, items: deliverables.length, points,
        deployed: deliverables.filter((i) => i.state === "Deployed (Done)").length,
        releaseReady: deliverables.filter((i) => ["Release Ready", "Smoke Testing"].includes(i.state)).length,
        inProgress: deliverables.filter((i) => ["In Progress", "In Peer Testing", "Ready for UAT"].includes(i.state)).length,
        notStarted: deliverables.filter((i) => ["New", "Ready for Refinement", "Ready for Sprint", "To Do"].includes(i.state)).length,
        // Only items that can't start yet: open questions on work already under way don't hold it back.
        held: deliverables.filter((i) => ["New", "Ready for Refinement", "Ready for Sprint", "To Do"].includes(i.state) && openQ.some((q) => q.item_id === i.id)).length,
        blocked: deliverables.filter((i) => i.state === "Blocked").length,
        costUsd: totals.cost, calls: totals.calls, tokens: totals.tokens, aiBusySeconds: totals.ms / 1000, simulated: totals.simulated > 0,
        elapsedSeconds: elapsed, humanHours, humanCostUsd: humanHours * st.humanHourlyRateUsd, speedup: elapsed > 0 ? (humanHours * 3600) / 4 / elapsed : null,
        reworkLoops: deliverables.reduce((n, i) => n + i.rework_count, 0),
        firstPassYield: tested.length ? tested.filter((i) => i.rework_count === 0).length / tested.length : null,
        qaChecks: { pass: qaAll.filter((x) => x.result === "pass").length, fail: qaAll.filter((x) => x.result === "fail").length, blocked: qaAll.filter((x) => x.result === "blocked").length },
        openQuestions: questions.filter((q) => !q.answer).length, commits,
      },
      team, epics, orphans, costByStage, releases, questions,
      documents: documents.filter((d) => !d.item_id).sort((a, b) => docOrder.indexOf(a.kind) - docOrder.indexOf(b.kind)),
      taskDocuments: documents.filter((d) => d.item_id).sort((a, b) => (a.item_code ?? "").localeCompare(b.item_code ?? "", undefined, { numeric: true }) || a.kind.localeCompare(b.kind)),
    });
  }),
);

api.get("/projects/:pid/print", (req, res) => {
  const p = getProject(String(req.params.pid))!;
  const order = ["project_brief", "solution_design", "delivery_plan", "user_manual", "technical_overview", "release_notes", "changelog"];
  const docs = all<{ id: string; kind: string; title: string; content: string; version: number; updated_at: string; item_id: string | null; item_code: string | null }>(
    "SELECT d.id, d.kind, d.title, d.content, d.version, d.updated_at, d.item_id, w.code item_code FROM documents d LEFT JOIN work_items w ON w.id = d.item_id WHERE d.project_id = ?",
    p.id,
  );
  const general = docs.filter((d) => !d.item_id).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const perTask = docs.filter((d) => d.item_id).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  res.json({ project: { key: p.key, name: p.name, mode: p.mode }, documents: req.query.tasks ? [...general, ...perTask] : general });
});

// ---------------------------------------------------------------- graph

function graphFor(projectId: string | null) {
  const agents = listAgents();
  const scope = projectId ? "WHERE project_id = ?" : "";
  const params = projectId ? [projectId] : [];
  const edges = all<{ from_agent_id: string; to_agent_id: string; n: number; last: string; kinds: string }>(
    `SELECT from_agent_id, to_agent_id, COUNT(*) n, MAX(created_at) last, GROUP_CONCAT(DISTINCT kind) kinds FROM messages ${scope}
     GROUP BY from_agent_id, to_agent_id`,
    ...params,
  );
  const stats = all<{ agent_id: string; cost: number; calls: number; tokens: number }>(
    `SELECT agent_id, SUM(cost_usd) cost, COUNT(*) calls, SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) tokens FROM llm_calls ${scope} GROUP BY agent_id`,
    ...params,
  );
  const active = all<{ agent_id: string; item_id: string | null; stage: string }>(
    `SELECT agent_id, item_id, stage FROM runs WHERE status = 'running' ${projectId ? "AND project_id = ?" : ""}`,
    ...params,
  );
  const project = projectId ? getProject(projectId) : undefined;
  const ids = new Set<string>(project ? project.agent_ids : agents.map((a) => a.id));
  for (const e of edges) {
    ids.add(e.from_agent_id);
    ids.add(e.to_agent_id);
  }
  const pseudo = Object.values(PSEUDO_AGENTS);
  const nodes = [...ids]
    .map((id) => {
      const a = agents.find((x) => x.id === id);
      const ps = pseudo.find((x) => x.id === id);
      if (!a && !ps) return null;
      const s = stats.find((x) => x.agent_id === id);
      const act = active.filter((x) => x.agent_id === id);
      return {
        id,
        name: a?.name ?? ps!.name,
        role: a?.role ?? ps!.role,
        title: a?.title ?? ps!.title,
        color: a?.color ?? ps!.color,
        icon: a?.icon ?? ps!.icon,
        model: a?.model ?? null,
        costUsd: s?.cost ?? 0,
        calls: s?.calls ?? 0,
        tokens: s?.tokens ?? 0,
        active: act.length,
        activeStage: act[0]?.stage ?? null,
        activeItem: act[0]?.item_id ? getItem(act[0].item_id)?.code ?? null : null,
      };
    })
    .filter(Boolean);
  return { nodes, edges: edges.map((e) => ({ from: e.from_agent_id, to: e.to_agent_id, count: e.n, last: e.last, kinds: e.kinds?.split(",") ?? [] })) };
}

api.get("/graph", (_req, res) => res.json(graphFor(null)));
api.get("/projects/:pid/graph", (req, res) => res.json(graphFor(String(req.params.pid))));

// ---------------------------------------------------------------- activity, messages, documents, files, questions

api.get("/projects/:pid/activity", (req, res) => {
  const limit = Math.min(1000, Number(req.query.limit) || 300);
  res.json(all("SELECT a.*, w.code item_code FROM activity a LEFT JOIN work_items w ON w.id = a.item_id WHERE a.project_id = ? ORDER BY a.id DESC LIMIT ?", String(req.params.pid), limit));
});

api.get("/activity", (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 100);
  res.json(all("SELECT a.*, p.key project_key, w.code item_code FROM activity a LEFT JOIN projects p ON p.id = a.project_id LEFT JOIN work_items w ON w.id = a.item_id ORDER BY a.id DESC LIMIT ?", limit));
});

api.get("/projects/:pid/messages", (req, res) => {
  res.json(all("SELECT m.*, w.code item_code FROM messages m LEFT JOIN work_items w ON w.id = m.item_id WHERE m.project_id = ? ORDER BY m.id DESC LIMIT 500", String(req.params.pid)));
});

api.get("/messages", (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 200);
  res.json(all("SELECT m.*, w.code item_code, p.key project_key FROM messages m LEFT JOIN work_items w ON w.id = m.item_id LEFT JOIN projects p ON p.id = m.project_id ORDER BY m.id DESC LIMIT ?", limit));
});

api.get("/projects/:pid/documents", (req, res) => {
  res.json(
    all(
      "SELECT d.id, d.kind, d.title, d.version, d.agent_id, d.item_id, d.updated_at, w.code item_code FROM documents d LEFT JOIN work_items w ON w.id = d.item_id WHERE d.project_id = ? ORDER BY d.item_id IS NOT NULL, d.kind, w.code",
      String(req.params.pid),
    ),
  );
});

api.get("/documents/:id", (req, res) => {
  const d = get("SELECT d.*, w.code item_code FROM documents d LEFT JOIN work_items w ON w.id = d.item_id WHERE d.id = ?", String(req.params.id));
  if (!d) return res.status(404).json({ error: "Document not found" });
  res.json(d);
});

api.get("/projects/:pid/files", (req, res) => {
  const p = getProject(String(req.params.pid));
  if (!p) return res.status(404).json({ error: "Project not found" });
  const meta = all<{ path: string; agent_id: string; item_id: string; bytes: number; updated_at: string }>(
    `SELECT f.path, f.agent_id, f.item_id, f.bytes, f.updated_at, w.code item_code,
            (SELECT COUNT(*) FROM file_versions v WHERE v.project_id = f.project_id AND v.path = f.path) versions,
            (SELECT v.added FROM file_versions v WHERE v.project_id = f.project_id AND v.path = f.path ORDER BY v.version DESC LIMIT 1) added,
            (SELECT v.removed FROM file_versions v WHERE v.project_id = f.project_id AND v.path = f.path ORDER BY v.version DESC LIMIT 1) removed
     FROM files f LEFT JOIN work_items w ON w.id = f.item_id WHERE f.project_id = ?`,
    p.id,
  );
  // The base branch plus every task branch still in progress (their files aren't merged yet).
  const rows = new Map<string, Record<string, unknown>>();
  for (const f of listWorkspaceFiles(p)) rows.set(f, { path: f });
  for (const w of activeWorktrees(p)) {
    for (const f of listWorkspaceFiles(p, w.code)) if (!rows.has(f)) rows.set(f, { path: f, branch: w.branch, unmerged: true });
  }
  res.json([...rows.values()].sort((a, b) => String(a.path).localeCompare(String(b.path))).map((r) => ({ ...r, ...(meta.find((m) => m.path === r.path) ?? {}) })));
});

/** Tasks currently on their own branch (worktree present). */
function activeWorktrees(p: Project) {
  return listItems(p.id)
    .filter((i) => i.branch && fs.existsSync(path.join(worktreeDir(p, i.code), ".git")))
    .map((i) => ({ code: i.code, branch: i.branch! }));
}

/** A file from the base branch, or from a task branch still in progress (text by default; pass a binary reader for images). */
function findWorkspaceFile<T = string>(p: Project, rel: string, read: (p: Project, rel: string, code?: string) => T | null = readWorkspaceFile as never): T | null {
  const onBase = read(p, rel);
  if (onBase !== null) return onBase;
  const code = rel.match(/^docs\/stories\/([A-Z]{2}-\d+)\//)?.[1];
  const owner = get<{ code: string }>("SELECT w.code FROM files f JOIN work_items w ON w.id = f.item_id WHERE f.project_id = ? AND f.path = ?", p.id, rel)?.code;
  for (const c of [code, owner, ...activeWorktrees(p).map((w) => w.code)]) {
    if (!c) continue;
    const v = read(p, rel, c);
    if (v !== null) return v;
  }
  return null;
}

api.get("/projects/:pid/file", (req, res) => {
  const p = getProject(String(req.params.pid));
  if (!p) return res.status(404).json({ error: "Project not found" });
  try {
    const content = findWorkspaceFile(p, String(req.query.path ?? ""));
    if (content === null) return res.status(404).json({ error: "File not found" });
    res.json({ path: req.query.path, content });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Test evidence images only (docs/stories/<code>/evidence/*.svg|png), served with scripts disabled. */
api.get("/projects/:pid/raw", (req, res) => {
  const p = getProject(String(req.params.pid))!;
  const rel = String(req.query.path ?? "");
  if (!/^docs\/stories\/[A-Z]{2}-\d+\/evidence\/[\w.-]+\.(svg|png)$/.test(rel)) return res.status(404).end();
  try {
    const content = findWorkspaceFile(p, rel, readWorkspaceBinary);
    if (content == null) return res.status(404).end();
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type(rel.endsWith(".svg") ? "image/svg+xml" : "image/png").send(content);
  } catch {
    res.status(404).end();
  }
});

/** Can this computer read and write the project's remote repository with its own git login? Nothing is changed. */
api.post(
  "/projects/:pid/repo/test",
  wrap(async (req, res) => {
    const p = getProject(String(req.params.pid));
    if (!p) return res.status(404).json({ error: "Project not found" });
    if (!p.settings.repo?.url) return res.json({ read: false, write: false, output: "No repository URL." });
    res.json(await testRemoteUrl(p.settings.repo.url));
  }),
);

/** Same check for a URL typed in the New project form (no project yet). */
api.post(
  "/repo/test",
  wrap(async (req, res) => res.json(await testRemoteUrl(String(req.body?.url ?? "")))),
);

api.get(
  "/projects/:pid/git",
  wrap(async (req, res) => {
    const p = getProject(String(req.params.pid))!;
    const only = req.query.branch ? String(req.query.branch) : undefined;
    const [{ commits, branch }, branches] = await Promise.all([gitLog(p, Number(req.query.limit) || 500, only), listBranches(p)]);
    res.json({ repo: p.settings.repo ?? null, branch, commits, branches });
  }),
);

api.get("/projects/:pid/file-versions", (req, res) => {
  const pid = String(req.params.pid);
  const path = String(req.query.path ?? "");
  const versions = all("SELECT v.version, v.agent_id, v.item_id, w.code item_code, v.added, v.removed, v.created_at, LENGTH(v.content) bytes FROM file_versions v LEFT JOIN work_items w ON w.id = v.item_id WHERE v.project_id = ? AND v.path = ? ORDER BY v.version DESC", pid, path);
  res.json(versions);
});

api.get("/projects/:pid/file-version", (req, res) => {
  const row = get<{ content: string }>("SELECT content FROM file_versions WHERE project_id = ? AND path = ? AND version = ?", String(req.params.pid), String(req.query.path ?? ""), Number(req.query.version));
  if (!row) return res.status(404).json({ error: "Version not found" });
  res.json({ content: row.content });
});

api.get("/projects/:pid/questions", (req, res) => {
  res.json(all("SELECT q.*, w.code item_code FROM questions q LEFT JOIN work_items w ON w.id = q.item_id WHERE q.project_id = ? ORDER BY q.id", String(req.params.pid)));
});

api.post("/questions/:id/answer", (req, res) => {
  const q = get<{ id: number; project_id: string; item_id: string | null; asked_by: string; question: string }>("SELECT * FROM questions WHERE id = ?", Number(req.params.id));
  if (!q) return res.status(404).json({ error: "Question not found" });
  const answer = String(req.body?.answer ?? "").trim();
  run("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?", answer, now(), q.id);
  if (answer) {
    postMessage({ projectId: q.project_id, from: "human", to: q.asked_by ?? "orchestrator", itemId: q.item_id, kind: "answer", content: answer });
    if (q.item_id) {
      const it = getItem(q.item_id);
      if (it?.state === "Requires additional information" && openQuestionCount(it.id) === 0) patchItem(it.id, { state: "Ready for Refinement" });
    }
  }
  emit({ type: "question", projectId: q.project_id });
  res.json({ ok: true });
});

api.get("/projects/:pid/releases", (req, res) => {
  res.json(all("SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC", String(req.params.pid)));
});

api.get("/projects/:pid/tests", (req, res) => {
  res.json(all("SELECT t.*, w.code item_code FROM test_results t LEFT JOIN work_items w ON w.id = t.item_id WHERE t.project_id = ? ORDER BY t.id DESC", String(req.params.pid)));
});

// ---------------------------------------------------------------- metrics & costs

api.get("/projects/:pid/metrics", (req, res) => {
  const p = getProject(String(req.params.pid));
  if (!p) return res.status(404).json({ error: "Project not found" });
  const phases = phaseRows("project_id = ?", p.id);
  const items = listItems(p.id).filter((i) => i.type === "story" || i.type === "task" || i.type === "bug");
  const dur = (ph: { started_at: string; ended_at: string | null }) =>
    (new Date(ph.ended_at ?? now()).getTime() - new Date(ph.started_at).getTime()) / 1000;
  const perItem = items.map((it) => {
    const ph = phases.filter((x) => x.item_id === it.id);
    const sum = (name: string) => ph.filter((x) => x.phase === name).reduce((n, x) => n + dur(x), 0);
    const first = ph[0]?.started_at;
    const last = ph.filter((x) => x.ended_at).at(-1)?.ended_at;
    return {
      id: it.id,
      code: it.code,
      title: it.title,
      category: it.category,
      state: it.state,
      points: it.story_points,
      rework: it.rework_count,
      humanHours: it.human_hours,
      seconds: {
        analysis: sum("analysis"),
        architecture: sum("architecture"),
        planning: sum("planning"),
        development: sum("development"),
        qa: sum("qa"),
        documentation: sum("documentation"),
        release: sum("release"),
      },
      leadTimeSeconds: first && last ? (new Date(last).getTime() - new Date(first).getTime()) / 1000 : null,
      phases: ph,
    };
  });
  res.json({ perItem, startedAt: p.started_at, finishedAt: p.finished_at });
});

// Bucket sizes for the spend chart: the smallest that keeps the chart at ≤ 48 buckets.
const TIMELINE_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/** Spend per time bucket and agent, with empty buckets filled in so the chart is continuous — from the first call
 *  to now while work is running (so it keeps moving during a run), or to the last call once everything is idle. */
function spendTimeline(projectId: string | null) {
  const calls = all<{ created_at: string; agent_id: string; cost_usd: number }>(
    `SELECT created_at, agent_id, cost_usd FROM llm_calls ${projectId ? "WHERE project_id = ?" : ""} ORDER BY created_at`,
    ...(projectId ? [projectId] : []),
  );
  if (!calls.length) return { timeline: [], timelineBuckets: [] as string[], timelineStep: 60 };
  const running = get<{ n: number }>(`SELECT COUNT(*) n FROM runs WHERE status = 'running' ${projectId ? "AND project_id = ?" : ""}`, ...(projectId ? [projectId] : []))!.n > 0;
  const t0 = new Date(calls[0].created_at).getTime();
  const t1 = Math.max(new Date(calls[calls.length - 1].created_at).getTime(), running ? Date.now() : 0);
  const step = (TIMELINE_STEPS.find((st) => (t1 - t0) / 1000 / st <= 48) ?? 86400) * 1000;
  const first = Math.floor(t0 / step) * step;
  const timelineBuckets: string[] = [];
  for (let b = first; b <= t1; b += step) timelineBuckets.push(new Date(b).toISOString());
  const sums = new Map<string, { bucket: string; agent_id: string; costUsd: number; calls: number }>();
  for (const c of calls) {
    const bucket = new Date(Math.floor(new Date(c.created_at).getTime() / step) * step).toISOString();
    const k = `${bucket}|${c.agent_id}`;
    const row = sums.get(k) ?? { bucket, agent_id: c.agent_id, costUsd: 0, calls: 0 };
    row.costUsd += c.cost_usd;
    row.calls += 1;
    sums.set(k, row);
  }
  return { timeline: [...sums.values()], timelineBuckets, timelineStep: step / 1000 };
}

api.get("/costs", (req, res) => {
  const projectId = req.query.projectId ? getProject(String(req.query.projectId))?.id ?? "-" : null;
  const where = projectId ? "WHERE c.project_id = ?" : "";
  const params = projectId ? [projectId] : [];
  const totals = get(
    `SELECT COALESCE(SUM(cost_usd),0) costUsd, COUNT(*) calls, COALESCE(SUM(input_tokens),0) inputTokens, COALESCE(SUM(output_tokens),0) outputTokens,
            COALESCE(SUM(cache_read_tokens),0) cacheReadTokens, COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens, COALESCE(SUM(duration_ms),0) busyMs,
            COALESCE(SUM(CASE WHEN simulated=1 THEN cost_usd ELSE 0 END),0) simulatedUsd
     FROM llm_calls c ${where}`,
    ...params,
  );
  const byAgent = all(
    `SELECT agent_id, SUM(cost_usd) costUsd, COUNT(*) calls, SUM(input_tokens) inputTokens, SUM(output_tokens) outputTokens,
            SUM(cache_read_tokens) cacheReadTokens, SUM(cache_write_tokens) cacheWriteTokens, SUM(duration_ms) busyMs,
            COUNT(DISTINCT run_id) runs, COUNT(DISTINCT item_id) items
     FROM llm_calls c ${where} GROUP BY agent_id ORDER BY costUsd DESC`,
    ...params,
  );
  const byProject = all(
    `SELECT c.project_id, p.key, p.name, SUM(cost_usd) costUsd, COUNT(*) calls FROM llm_calls c JOIN projects p ON p.id = c.project_id ${where} GROUP BY c.project_id ORDER BY costUsd DESC`,
    ...params,
  );
  const byItem = all(
    `SELECT c.item_id, w.code, w.title, w.type, w.category, w.story_points points, SUM(cost_usd) costUsd, COUNT(*) calls, p.key project_key
     FROM llm_calls c JOIN work_items w ON w.id = c.item_id JOIN projects p ON p.id = c.project_id ${where} GROUP BY c.item_id ORDER BY costUsd DESC LIMIT 200`,
    ...params,
  );
  const byItemAgent = all(
    `SELECT c.item_id, c.agent_id, SUM(cost_usd) costUsd FROM llm_calls c ${where ? where + " AND" : "WHERE"} c.item_id IS NOT NULL GROUP BY c.item_id, c.agent_id`,
    ...params,
  );
  const byModel = all(`SELECT model, SUM(cost_usd) costUsd, COUNT(*) calls FROM llm_calls c ${where} GROUP BY model ORDER BY costUsd DESC`, ...params);
  const byStage = all(`SELECT stage, SUM(cost_usd) costUsd, COUNT(*) calls, SUM(duration_ms) busyMs FROM llm_calls c ${where} GROUP BY stage ORDER BY costUsd DESC`, ...params);
  res.json({ totals, byAgent, byProject, byItem, byItemAgent, byModel, byStage, ...spendTimeline(projectId) });
});

// ---------------------------------------------------------------- feature routers
registerAdo(api);
registerAuth(api);
registerAccuracy(api);
registerTemplates(api);
