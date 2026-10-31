import fs from "node:fs";
import path from "node:path";
import { diffLines } from "diff";
import { DATA_DIR, all, db, get, insert, now, parseJson, run, uid, update } from "./db.js";
import { emit } from "./events.js";

// ---------- Projects ----------

export interface StageState {
  key: string;
  role: string;
  label: string;
  status: "pending" | "running" | "done" | "skipped" | "awaiting_approval" | "failed";
  gate?: boolean;
}

export interface ProjectSettings {
  gates: boolean;
  parallelism: number;
  budgetUsd: number;
  maxRework: number;
  /** Git repository the project's workspace belongs to (stored as `origin`; never pushed in simulation). */
  /** `push`: push task branches, the base branch and release tags to origin, with this machine's own git login. */
  repo?: { url: string; branch: string; push?: boolean } | null;
  /** Architect code review of each story's diff after QA approves: off (default), complex stories only, or all. */
  codeReview?: "off" | "complex" | "all";
  /** Overrides of the team's checks for this project (commands, timeout). */
  checks?: Partial<import("./team.js").ChecksSettings>;
  /** Azure DevOps project the backlog syncs to. The token is never stored: it lives in .env as AZURE_DEVOPS_PAT. */
  ado?: import("./ado.js").AdoConfig | null;
  /** The Claude account this project's live agents use on the plan backend; unset = the active account. */
  claudeAccount?: string | null;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  status: "draft" | "ready" | "running" | "paused" | "awaiting_approval" | "completed" | "failed" | "stopped";
  stage: string | null;
  stages: StageState[];
  pdf_file: string | null;
  pdf_name: string | null;
  pdf_pages: number | null;
  pdf_tokens: number | null;
  agent_ids: string[];
  settings: ProjectSettings;
  estimate: unknown;
  mode: "live" | "simulation";
  seq: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

type ProjectRow = Omit<Project, "stages" | "agent_ids" | "settings" | "estimate"> & {
  stages: string;
  agent_ids: string;
  settings: string;
  estimate: string | null;
};

function hydrateProject(r: ProjectRow): Project {
  return {
    ...r,
    stages: parseJson(r.stages, []),
    agent_ids: parseJson(r.agent_ids, []),
    settings: parseJson(r.settings, { gates: true, parallelism: 2, budgetUsd: 50, maxRework: 2 }),
    estimate: parseJson(r.estimate, null),
  };
}

export function listProjects(): Project[] {
  return all<ProjectRow>("SELECT * FROM projects ORDER BY created_at DESC").map(hydrateProject);
}

export function getProject(id: string): Project | undefined {
  const r = get<ProjectRow>("SELECT * FROM projects WHERE id = ? OR key = ?", id, id);
  return r ? hydrateProject(r) : undefined;
}

export function patchProject(id: string, patch: Partial<Project>) {
  update("projects", id, { ...patch, updated_at: now() });
  const p = getProject(id);
  emit({ type: "project", projectId: id, data: p });
  return p;
}

export function projectDir(p: Pick<Project, "key">) {
  return path.join(DATA_DIR, "projects", p.key);
}

export function workspaceDir(p: Pick<Project, "key">) {
  return path.join(projectDir(p), "workspace");
}

/** A task's own working copy (git worktree on its branch). */
export function worktreeDir(p: Pick<Project, "key">, code: string) {
  return path.join(projectDir(p), "worktrees", code);
}

/** Where a task's files live: its worktree while it's being built on its own branch, otherwise the main workspace
 *  (the base branch). Project-level files (living documents, manifest) always live in the main workspace. */
export function rootFor(p: Pick<Project, "key">, itemCode?: string | null) {
  if (itemCode) {
    const wt = worktreeDir(p, itemCode);
    if (fs.existsSync(path.join(wt, ".git"))) return wt;
  }
  return workspaceDir(p);
}

function codeOf(itemId: string | null | undefined) {
  return itemId ? (get<{ code: string }>("SELECT code FROM work_items WHERE id = ?", itemId)?.code ?? null) : null;
}

export function uniqueProjectKey(name: string) {
  const base =
    name
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .replace(/[^A-Za-z]/g, "")
      .toUpperCase()
      .slice(0, 4) || "PRJ";
  let key = base.length >= 2 ? base : (name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "PRJ");
  let i = 2;
  while (get("SELECT 1 FROM projects WHERE key = ?", key)) key = `${base}${i++}`;
  return key;
}

// ---------- Work items ----------

export const TYPE_PREFIX: Record<string, string> = { epic: "EP", feature: "FT", story: "US", task: "TK", bug: "BG" };

export interface WorkItem {
  id: string;
  project_id: string;
  code: string;
  type: "epic" | "feature" | "story" | "task" | "bug";
  parent_id: string | null;
  title: string;
  category: string;
  state: string;
  priority: number | null;
  moscow: string | null;
  story_points: number | null;
  wsjf: number | null;
  sprint: number | null;
  rank: number | null;
  user_story: string;
  background: string;
  business_rules: string;
  dependencies: string;
  out_of_scope: string;
  acceptance_criteria: string;
  tech_spec: string;
  how_to_test: string;
  manual_steps: string;
  solution_components: string;
  tags: string[];
  depends_on: string[];
  assigned_agent_id: string | null;
  rework_count: number;
  /** The task's git branch (feature/... or bugfix/...), once development has started. */
  branch: string | null;
  /** Azure DevOps work item id, once the backlog has been synced. */
  ado_id?: number | null;
  /** The task's GitHub pull request, when the project pushes to a GitHub repository. */
  pr_url: string | null;
  human_hours: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

type ItemRow = Omit<WorkItem, "tags" | "depends_on"> & { tags: string; depends_on: string };

function hydrateItem(r: ItemRow): WorkItem {
  return { ...r, tags: parseJson(r.tags, []), depends_on: parseJson(r.depends_on, []) };
}

export function listItems(projectId: string): WorkItem[] {
  return all<ItemRow>(
    "SELECT * FROM work_items WHERE project_id = ? ORDER BY COALESCE(rank, 100000), created_at",
    projectId,
  ).map(hydrateItem);
}

export function getItem(id: string): WorkItem | undefined {
  const r = get<ItemRow>("SELECT * FROM work_items WHERE id = ?", id);
  return r ? hydrateItem(r) : undefined;
}

export function getItemByCode(projectId: string, code: string): WorkItem | undefined {
  const r = get<ItemRow>(
    "SELECT * FROM work_items WHERE project_id = ? AND UPPER(code) = UPPER(?)",
    projectId,
    code.trim(),
  );
  return r ? hydrateItem(r) : undefined;
}

export function createItem(projectId: string, fields: Partial<WorkItem> & { type: WorkItem["type"]; title: string }) {
  const tx = () => {
    const p = get<{ seq: number }>("SELECT seq FROM projects WHERE id = ?", projectId)!;
    const seq = p.seq + 1;
    run("UPDATE projects SET seq = ? WHERE id = ?", seq, projectId);
    return seq;
  };
  db.exec("BEGIN");
  let seq: number;
  try {
    seq = tx();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const ts = now();
  const item = {
    id: uid("wi"),
    project_id: projectId,
    code: `${TYPE_PREFIX[fields.type] ?? "WI"}-${seq}`,
    state: "New",
    category: "development",
    tags: [],
    depends_on: [],
    created_at: ts,
    updated_at: ts,
    ...fields,
  };
  insert("work_items", item);
  const saved = getItem(item.id)!;
  emit({ type: "item", projectId, data: saved });
  return saved;
}

export function patchItem(id: string, patch: Partial<WorkItem>) {
  update("work_items", id, { ...patch, updated_at: now() });
  const saved = getItem(id)!;
  emit({ type: "item", projectId: saved.project_id, data: saved });
  return saved;
}

// ---------- Phases (time tracking per item) ----------

export function startPhase(projectId: string, itemId: string, phase: string, agentId: string | null, iteration = 1) {
  const r = run(
    "INSERT INTO item_phases (project_id, item_id, phase, agent_id, iteration, started_at) VALUES (?,?,?,?,?,?)",
    projectId,
    itemId,
    phase,
    agentId,
    iteration,
    now(),
  );
  return Number(r.lastInsertRowid);
}

export function endPhase(phaseId: number, outcome = "done") {
  run("UPDATE item_phases SET ended_at = ?, outcome = ? WHERE id = ? AND ended_at IS NULL", now(), outcome, phaseId);
}

// ---------- Activity & messages ----------

export function logActivity(a: {
  projectId: string | null;
  agentId?: string | null;
  runId?: string | null;
  itemId?: string | null;
  type: string;
  summary: string;
  detail?: unknown;
}) {
  const row = {
    project_id: a.projectId,
    agent_id: a.agentId ?? null,
    run_id: a.runId ?? null,
    item_id: a.itemId ?? null,
    type: a.type,
    summary: a.summary.slice(0, 500),
    detail: a.detail === undefined ? null : typeof a.detail === "string" ? a.detail : JSON.stringify(a.detail),
    created_at: now(),
  };
  const r = insert("activity", row);
  emit({ type: "activity", projectId: a.projectId, data: { id: Number(r.lastInsertRowid), ...row } });
}

export function postMessage(m: {
  projectId: string | null;
  from: string;
  to: string;
  itemId?: string | null;
  kind: "handoff" | "question" | "answer" | "review" | "info" | "rework" | "approval";
  content: string;
}) {
  const row = {
    project_id: m.projectId,
    from_agent_id: m.from,
    to_agent_id: m.to,
    item_id: m.itemId ?? null,
    kind: m.kind,
    content: m.content,
    created_at: now(),
  };
  const r = insert("messages", row);
  emit({ type: "message", projectId: m.projectId, data: { id: Number(r.lastInsertRowid), ...row } });
}

// ---------- Documents ----------

export interface Doc {
  id: string;
  project_id: string;
  item_id: string | null;
  kind: string;
  title: string;
  content: string;
  version: number;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

export function findDoc(projectId: string, kind: string, itemId: string | null) {
  return itemId
    ? get<Doc>("SELECT * FROM documents WHERE project_id = ? AND kind = ? AND item_id = ?", projectId, kind, itemId)
    : get<Doc>("SELECT * FROM documents WHERE project_id = ? AND kind = ? AND item_id IS NULL", projectId, kind);
}

export function upsertDoc(d: { projectId: string; kind: string; itemId: string | null; title: string; content: string; agentId: string | null }) {
  const existing = findDoc(d.projectId, d.kind, d.itemId);
  const ts = now();
  let doc: Doc;
  if (existing) {
    update("documents", existing.id, {
      title: d.title,
      content: d.content,
      version: existing.version + 1,
      agent_id: d.agentId,
      updated_at: ts,
    });
    doc = get<Doc>("SELECT * FROM documents WHERE id = ?", existing.id)!;
  } else {
    const id = uid("doc");
    insert("documents", {
      id,
      project_id: d.projectId,
      item_id: d.itemId,
      kind: d.kind,
      title: d.title,
      content: d.content,
      version: 1,
      agent_id: d.agentId,
      created_at: ts,
      updated_at: ts,
    });
    doc = get<Doc>("SELECT * FROM documents WHERE id = ?", id)!;
  }
  // Mirror to disk so the project folder is a usable deliverable.
  const p = getProject(d.projectId);
  if (p) {
    const item = d.itemId ? getItem(d.itemId) : undefined;
    const rel = item ? `docs/stories/${item.code}/${d.kind}.md` : `docs/${d.kind}.md`;
    writeWorkspaceFile(p, rel, d.content, item?.code);
  }
  emit({ type: "document", projectId: d.projectId, data: { id: doc.id, kind: doc.kind, version: doc.version } });
  return doc;
}

// ---------- Workspace files ----------

export function safeWorkspacePath(p: Pick<Project, "key">, rel: string, itemCode?: string | null) {
  const root = rootFor(p, itemCode);
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(root, clean);
  if (!abs.startsWith(root + path.sep)) throw new Error(`Path escapes the workspace: ${rel}`);
  return { abs, rel: path.relative(root, abs).split(path.sep).join("/") };
}

export function writeWorkspaceFile(p: Pick<Project, "key">, rel: string, content: string, itemCode?: string | null) {
  const { abs } = safeWorkspacePath(p, rel, itemCode);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Lines added/removed between two versions of a file. */
export function lineChanges(before: string, after: string) {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

export function recordFile(projectId: string, rel: string, content: string, agentId: string | null, itemId: string | null) {
  const p = getProject(projectId)!;
  const code = codeOf(itemId);
  const { rel: clean } = safeWorkspacePath(p, rel, code);
  // Keep every version so the Code tab can show what each agent added or removed.
  let last = get<{ version: number; content: string }>("SELECT version, content FROM file_versions WHERE project_id = ? AND path = ? ORDER BY version DESC LIMIT 1", projectId, clean);
  const onDisk = readWorkspaceFile(p, clean, code);
  if (!last && onDisk != null && onDisk !== content) {
    // File written before version history existed: keep it as the baseline so the diff shows only the new change.
    const prev = get<{ agent_id: string | null; item_id: string | null; updated_at: string }>("SELECT agent_id, item_id, updated_at FROM files WHERE project_id = ? AND path = ?", projectId, clean);
    insert("file_versions", { project_id: projectId, path: clean, version: 1, content: onDisk, agent_id: prev?.agent_id ?? null, item_id: prev?.item_id ?? null, added: onDisk.split("\n").length, removed: 0, created_at: prev?.updated_at ?? now() });
    last = { version: 1, content: onDisk };
  }
  const before = last?.content ?? "";
  if (!last || last.content !== content) {
    const { added, removed } = lineChanges(before, content);
    insert("file_versions", { project_id: projectId, path: clean, version: (last?.version ?? 0) + 1, content, agent_id: agentId, item_id: itemId, added, removed, created_at: now() });
  }
  writeWorkspaceFile(p, clean, content, code);
  const ts = now();
  run(
    `INSERT INTO files (project_id, item_id, path, agent_id, bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(project_id, path) DO UPDATE SET bytes = excluded.bytes, agent_id = excluded.agent_id,
       item_id = COALESCE(excluded.item_id, files.item_id), updated_at = excluded.updated_at`,
    projectId,
    itemId,
    clean,
    agentId,
    Buffer.byteLength(content),
    ts,
    ts,
  );
  emit({ type: "file", projectId, data: { path: clean } });
  return clean;
}

export function readWorkspaceFile(p: Pick<Project, "key">, rel: string, itemCode?: string | null) {
  const { abs } = safeWorkspacePath(p, rel, itemCode);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

/** Binary workspace files (real screenshots): written to disk and listed in `files`, but without text versions —
 *  a PNG has no line diff to show. Returns the clean workspace-relative path. */
export function writeWorkspaceBinary(p: Pick<Project, "id" | "key">, rel: string, buf: Buffer, itemCode?: string | null, agentId: string | null = null) {
  const { abs, rel: clean } = safeWorkspacePath(p, rel, itemCode);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  const itemId = itemCode ? (getItemByCode(p.id, itemCode)?.id ?? null) : null;
  const ts = now();
  run(
    `INSERT INTO files (project_id, item_id, path, agent_id, bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(project_id, path) DO UPDATE SET bytes = excluded.bytes, agent_id = excluded.agent_id,
       item_id = COALESCE(excluded.item_id, files.item_id), updated_at = excluded.updated_at`,
    p.id,
    itemId,
    clean,
    agentId,
    buf.length,
    ts,
    ts,
  );
  emit({ type: "file", projectId: p.id, data: { path: clean } });
  return clean;
}

export function readWorkspaceBinary(p: Pick<Project, "key">, rel: string, itemCode?: string | null): Buffer | null {
  const { abs } = safeWorkspacePath(p, rel, itemCode);
  return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
}

/** Installed dependencies and tool caches: never the project's own code, and thousands of files once installed. */
const GENERATED_DIRS = new Set([".git", "node_modules", ".pnpm-store", ".yarn", ".next", ".nuxt", ".turbo", ".cache", ".vite", "coverage", "__pycache__", ".venv", ".pytest_cache"]);

export function listWorkspaceFiles(p: Pick<Project, "key">, itemCode?: string | null): string[] {
  const root = rootFor(p, itemCode);
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory() && GENERATED_DIRS.has(e.name)) continue;
      if (e.name === ".git") continue;
      if (e.isDirectory()) walk(abs);
      else out.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

// ---------- Questions, tests, releases ----------

export function addQuestion(projectId: string, question: string, itemId: string | null, askedBy: string) {
  const r = insert("questions", { project_id: projectId, item_id: itemId, question, asked_by: askedBy, created_at: now() });
  emit({ type: "question", projectId });
  return Number(r.lastInsertRowid);
}

/** Unanswered questions on an item. An item with open questions never advances in the pipeline. */
export function openQuestionCount(itemId: string) {
  return get<{ n: number }>("SELECT COUNT(*) n FROM questions WHERE item_id = ? AND (answer IS NULL OR answer = '')", itemId)?.n ?? 0;
}

export function answeredQuestions(projectId: string) {
  return all<{ question: string; answer: string; item_id: string | null }>(
    "SELECT question, answer, item_id FROM questions WHERE project_id = ? AND answer IS NOT NULL AND answer != ''",
    projectId,
  );
}

export function addTestResult(t: {
  projectId: string;
  itemId: string;
  kind: "qa" | "smoke";
  acRef: string;
  result: "pass" | "fail" | "blocked";
  notes: string;
  iteration: number;
  agentId: string;
}) {
  insert("test_results", {
    project_id: t.projectId,
    item_id: t.itemId,
    kind: t.kind,
    ac_ref: t.acRef,
    result: t.result,
    notes: t.notes,
    iteration: t.iteration,
    agent_id: t.agentId,
    created_at: now(),
  });
  emit({ type: "item", projectId: t.projectId });
}
