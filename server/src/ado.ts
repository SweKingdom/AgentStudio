/**
 * Azure DevOps sync: pushes the backlog (epics → features → stories → tasks/bugs) to an Azure DevOps project as work items,
 * through the REST API (api-version 7.1). The Personal Access Token lives ONLY in the user's `.env` as AZURE_DEVOPS_PAT:
 * it is read from the environment at call time, sent only in the Authorization header, and never stored, logged or returned.
 */
import { getSetting, setSetting, update } from "./db.js";
import { emit } from "./events.js";
import { getItem, listItems, listProjects, logActivity, type Project, type WorkItem } from "./store.js";
import { teamSettings } from "./team.js";

export type AdoStateMode = "same" | "agile";

export interface AdoConfig {
  /** https://dev.azure.com/<org> (or a self-hosted collection URL). */
  orgUrl: string;
  /** Azure DevOps project name. */
  project: string;
  areaPath?: string;
  /** Iteration path root, e.g. "MyProject" or "MyProject\\Release 1". Sprints go underneath it. */
  iterationRoot?: string;
  /** "same": send the ARM state names as-is (processes that use the same states). "agile": map onto the Agile process. */
  stateMode: AdoStateMode;
}

const API = "api-version=7.1";
export const ADO_TYPE: Record<WorkItem["type"], string> = { epic: "Epic", feature: "Feature", story: "User Story", task: "Task", bug: "Bug" };

// ---------------------------------------------------------------- config & token

/** Validates and normalises a config from the UI. Returns null when ADO is switched off (empty URL and project). */
export function cleanAdoConfig(input: unknown): AdoConfig | null {
  if (input == null) return null;
  if (typeof input !== "object") throw new Error("Azure DevOps settings must be an object");
  const o = input as Record<string, unknown>;
  const rawUrl = String(o.orgUrl ?? "").trim();
  const project = String(o.project ?? "").trim();
  if (!rawUrl && !project) return null;
  if (!rawUrl) throw new Error("Azure DevOps organization URL is required (https://dev.azure.com/<org>)");
  if (!project) throw new Error("Azure DevOps project name is required");
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("Azure DevOps organization URL must look like https://dev.azure.com/<org>");
  }
  // Plain http is only accepted for a local stand-in (tests); everything real goes over https.
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("Azure DevOps organization URL must use https://");
  if (u.username || u.password) throw new Error("SiroccoARM never stores credentials — remove the user/token from the URL and put AZURE_DEVOPS_PAT in .env");
  if (u.search || u.hash) throw new Error("Azure DevOps organization URL must not have a query string");
  if (/[\\/?#]/.test(project)) throw new Error("Azure DevOps project name can't contain / \\ ? or #");
  const mode = o.stateMode === "agile" ? "agile" : "same";
  const text = (v: unknown) => String(v ?? "").trim().replace(/\//g, "\\").replace(/^\\+|\\+$/g, "");
  return {
    orgUrl: `${u.origin}${u.pathname.replace(/\/+$/, "")}`,
    project,
    ...(text(o.areaPath) ? { areaPath: text(o.areaPath) } : {}),
    ...(text(o.iterationRoot) ? { iterationRoot: text(o.iterationRoot) } : {}),
    stateMode: mode,
  };
}

/** The config saved on the project, or null when it's missing/invalid. */
export function adoConfigOf(p: Project): AdoConfig | null {
  try {
    return cleanAdoConfig(p.settings.ado);
  } catch {
    return null;
  }
}

function adoToken() {
  return process.env.AZURE_DEVOPS_PAT?.trim() || null;
}

export function hasAdoToken() {
  return Boolean(adoToken());
}

export const NO_TOKEN = "No Azure DevOps token. Add AZURE_DEVOPS_PAT=… (a Personal Access Token with Work Items read & write) to the .env file in the project folder and restart.";

/** Strips the token (raw or base64) from any text that might end up in a response or log. */
function redact(text: string) {
  const t = adoToken();
  if (!t) return text;
  return text.split(t).join("***").split(Buffer.from(`:${t}`).toString("base64")).join("***");
}

/** Link to a work item in the Azure DevOps web UI. */
export function adoWebUrl(cfg: Pick<AdoConfig, "orgUrl" | "project">, id: number) {
  return `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_workitems/edit/${id}`;
}

// ---------------------------------------------------------------- HTTP

interface AdoResponse {
  status: number;
  body: any;
  /** Human-readable error (ADO's own message when it sent one). */
  message: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function adoFetch(method: string, url: string, body?: unknown, contentType = "application/json"): Promise<AdoResponse> {
  const token = adoToken();
  if (!token) throw new Error(NO_TOKEN);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        // A rejected PAT is answered with a redirect to the sign-in page — don't follow it, report it.
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": contentType } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      const why = e instanceof Error ? ((e.cause as Error | undefined)?.message ?? e.message) : String(e);
      throw new Error(redact(`Could not reach Azure DevOps (${new URL(url).host}): ${why}`));
    }
    // Throttled: wait as asked (capped) and try again, twice at most.
    if (res.status === 429 && attempt < 2) {
      await sleep(Math.min(10, Number(res.headers.get("retry-after")) || 2) * 1000);
      continue;
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* HTML sign-in page or proxy error */
    }
    const message = redact(
      res.status === 401 || res.status === 203 || (res.status >= 300 && res.status < 400)
        ? "Azure DevOps rejected the token (AZURE_DEVOPS_PAT) — it may be expired or for another organization"
        : res.status === 403
          ? "The token isn't allowed to do this — give the PAT the Work Items (read & write) and Project (read) scopes"
          : String(json?.message ?? (res.ok ? "" : `HTTP ${res.status} ${res.statusText}`)),
    );
    return { status: res.status, body: json, message };
  }
}

const ok = (r: AdoResponse) => r.status >= 200 && r.status < 300 && r.status !== 203;

// ---------------------------------------------------------------- test connection

export interface AdoTestResult {
  ok: boolean;
  project?: string;
  process?: string | null;
  error?: string;
}

/** Reads the project (nothing is changed). */
export async function testAdo(cfg: AdoConfig): Promise<AdoTestResult> {
  if (!hasAdoToken()) return { ok: false, error: NO_TOKEN };
  try {
    const r = await adoFetch("GET", `${cfg.orgUrl}/_apis/projects/${encodeURIComponent(cfg.project)}?includeCapabilities=true&${API}`);
    if (ok(r)) {
      return { ok: true, project: String(r.body?.name ?? cfg.project), process: r.body?.capabilities?.processTemplate?.templateName ?? null };
    }
    if (r.status === 401 || r.status === 203 || (r.status >= 300 && r.status < 400)) return { ok: false, error: "Azure DevOps rejected the token — check AZURE_DEVOPS_PAT in .env (expired, or created for another organization)" };
    if (r.status === 404) return { ok: false, error: `Azure DevOps project not found: "${cfg.project}" in ${cfg.orgUrl}` };
    return { ok: false, error: r.message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- mapping

/** ARM state → Agile process state. Tasks have no Resolved and bugs no Removed, so those fall to Closed. */
export function agileState(state: string, type: WorkItem["type"]): string {
  const map: Record<string, string> = {
    "New": "New",
    "Requires additional information": "New",
    "Ready for Refinement": "New",
    "Ready for Sprint": "New",
    "To Do": "New",
    "In Progress": "Active",
    "In Peer Testing": "Active",
    "Ready for UAT": "Active",
    "Blocked": "Active",
    "Release Ready": "Resolved",
    "Smoke Testing": "Resolved",
    "Deployed (Done)": "Closed",
    "Cancelled": "Removed",
  };
  const s = map[state] ?? "New";
  if (type === "task" && s === "Resolved") return "Closed";
  if (type === "bug" && s === "Removed") return "Closed";
  return s;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");

/** Plain text / light markdown (paragraphs, bullet and numbered lists, **bold**, `code`) → the HTML ADO rich-text fields expect. */
export function textToHtml(text: string) {
  const blocks = text.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  return blocks
    .map((b) => {
      const lines = b.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
      if (!lines.length) return "";
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
      if (lines.length === 1 && /^#{1,6}\s/.test(lines[0])) return `<h4>${inline(lines[0].replace(/^#+\s*/, ""))}</h4>`;
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

/** story template sections → the work item's Description. */
export function descriptionHtml(i: WorkItem, withAcceptance = false) {
  const sections: [string, string][] = [
    ["User Story", i.user_story],
    ["Background &amp; Context", i.background],
    ["Business Rules", i.business_rules],
    ["Dependencies", i.dependencies],
    ["Out of Scope", i.out_of_scope],
    ...(withAcceptance ? ([["Acceptance Criteria", i.acceptance_criteria]] as [string, string][]) : []),
    ["Technical Specification", i.tech_spec],
    ["How to Test", i.how_to_test],
    ["Manual Steps", i.manual_steps],
    ["Solution Components", i.solution_components],
  ];
  return sections
    .filter(([, v]) => v?.trim())
    .map(([h, v]) => `<h3>${h}</h3>\n${textToHtml(v)}`)
    .join("\n");
}

export function adoTags(i: WorkItem, extra: string[] = []) {
  const team = teamSettings().conventions.ado.tags.split(/[;,]/).map((t) => t.trim());
  const all = [...i.tags, ...team, i.category, `ARM ${i.code}`, ...extra].map((t) => String(t ?? "").replace(/;/g, ",").trim()).filter(Boolean);
  const seen = new Set<string>();
  return all.filter((t) => (seen.has(t.toLowerCase()) ? false : (seen.add(t.toLowerCase()), true))).join("; ");
}

export function iterationPath(cfg: AdoConfig, sprint: number | null) {
  if (!cfg.iterationRoot) return null;
  return sprint != null ? `${cfg.iterationRoot}\\${teamSettings().conventions.ado.iterationPrefix}${sprint}` : cfg.iterationRoot;
}

interface PatchOp {
  op: "add" | "remove" | "replace" | "test";
  path: string;
  value?: unknown;
}

/** Fields that may be missing on a customised process (or a path that doesn't exist yet): dropped and reported instead of failing the item. */
const DROPPABLE = new Set([
  "Microsoft.VSTS.Common.AcceptanceCriteria",
  "Microsoft.VSTS.Scheduling.StoryPoints",
  "Microsoft.VSTS.Common.Priority",
  "Microsoft.VSTS.TCM.ReproSteps",
  "System.AreaPath",
  "System.IterationPath",
]);

function fieldOps(cfg: AdoConfig, i: WorkItem, state: string, skip: Set<string>): PatchOp[] {
  // Tasks and bugs have no Acceptance Criteria field in the Agile process: the criteria go into the description instead.
  const acField = i.type === "epic" || i.type === "feature" || i.type === "story";
  const desc = descriptionHtml(i, !acField);
  const fields: [string, unknown][] = [
    ["System.Title", i.title.slice(0, 255)],
    ["System.Description", desc],
    ...(acField ? ([["Microsoft.VSTS.Common.AcceptanceCriteria", textToHtml(i.acceptance_criteria || "")]] as [string, unknown][]) : []),
    // A bug's form shows Repro Steps rather than Description.
    ...(i.type === "bug" ? ([["Microsoft.VSTS.TCM.ReproSteps", desc]] as [string, unknown][]) : []),
    ...(i.story_points != null && i.type !== "epic" && i.type !== "feature" ? ([["Microsoft.VSTS.Scheduling.StoryPoints", i.story_points]] as [string, unknown][]) : []),
    ...(i.priority != null && i.priority >= 1 && i.priority <= 4 ? ([["Microsoft.VSTS.Common.Priority", i.priority]] as [string, unknown][]) : []),
    ["System.Tags", adoTags(i, cfg.stateMode === "agile" && i.state === "Blocked" ? ["Blocked"] : [])],
    ...(cfg.areaPath ? ([["System.AreaPath", cfg.areaPath]] as [string, unknown][]) : []),
    ...(iterationPath(cfg, i.sprint) ? ([["System.IterationPath", iterationPath(cfg, i.sprint)]] as [string, unknown][]) : []),
    ["System.State", state],
  ];
  return fields.filter(([f]) => !skip.has(f)).map(([f, value]) => ({ op: "add", path: `/fields/${f}`, value }));
}

const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const itemApiUrl = (cfg: AdoConfig, id: number) => `${cfg.orgUrl}/_apis/wit/workItems/${id}`;
const idFromUrl = (u: string) => Number(u.match(/workItems\/(\d+)\s*$/i)?.[1] ?? NaN);

/** Parent link ops for an update: add/replace the Hierarchy-Reverse relation only when it differs from what ADO has. */
function parentOps(cfg: AdoConfig, existing: any, parentId: number | null): PatchOp[] {
  const rels: any[] = existing?.relations ?? [];
  const idx = rels.findIndex((r) => r?.rel === PARENT);
  const current = idx >= 0 ? idFromUrl(String(rels[idx].url ?? "")) : null;
  if (parentId == null || current === parentId) return [];
  const ops: PatchOp[] = [];
  if (idx >= 0) ops.push({ op: "remove", path: `/relations/${idx}` });
  ops.push({ op: "add", path: "/relations/-", value: { rel: PARENT, url: itemApiUrl(cfg, parentId) } });
  return ops;
}

const invalidState = (r: AdoResponse) => r.status === 400 && /state/i.test(r.message) && /(not in the list of (supported|allowed) values|LimitedToValues|invalid|TF401320|not a valid)/i.test(r.message);
/** The field reference a 400 complains about, when it's one we can drop. */
const badField = (r: AdoResponse, ops: PatchOp[]) =>
  r.status === 400 ? ops.map((o) => o.path.replace(/^\/fields\//, "")).find((f) => DROPPABLE.has(f) && r.message.includes(f.split(".").pop()!)) ?? null : null;

// ---------------------------------------------------------------- sync

export interface AdoSyncSummary {
  at: string;
  ok: boolean;
  total: number;
  created: number;
  updated: number;
  /** Items whose stored ADO id no longer existed (deleted in ADO) and were created again. Also counted in `created`. */
  recreated: number;
  failed: number;
  errors: { code: string; error: string }[];
  warnings: { code: string; message: string }[];
  /** Items whose ARM state ADO refused and were sent with the Agile mapping instead. */
  stateFallbacks: { code: string; state: string; sent: string }[];
  durationMs: number;
  error?: string;
}

const running = new Set<string>();
const SUMMARY_KEY = (projectId: string) => `ado-sync:${projectId}`;

export function lastSync(projectId: string) {
  return getSetting<AdoSyncSummary | null>(SUMMARY_KEY(projectId), null);
}

export function syncRunning(projectId: string) {
  return running.has(projectId);
}

/** Parents before children: epics, features, then stories/tasks/bugs, each level in rank order. */
function parentsFirst(items: WorkItem[]) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const order: Record<WorkItem["type"], number> = { epic: 0, feature: 1, story: 2, task: 3, bug: 4 };
  const out: WorkItem[] = [];
  const walk = (pid: string | null) => {
    const kids = items.filter((i) => (pid === null ? !i.parent_id || !byId.has(i.parent_id) : i.parent_id === pid));
    kids.sort((a, b) => order[a.type] - order[b.type] || (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.code.localeCompare(b.code, undefined, { numeric: true }));
    for (const k of kids) {
      out.push(k);
      walk(k.id);
    }
  };
  walk(null);
  return out;
}

/**
 * Creates or updates every backlog item as an Azure DevOps work item. One bad item never stops the others: its error
 * is collected and the sync goes on. Throws only when the sync can't start (no config, no token, already running).
 */
export async function syncBacklog(p: Project): Promise<AdoSyncSummary> {
  const cfg = cleanAdoConfig(p.settings.ado);
  if (!cfg) throw new Error("Azure DevOps isn't configured for this project (Project settings → Azure DevOps)");
  if (!hasAdoToken()) throw new Error(NO_TOKEN);
  if (running.has(p.id)) throw new Error("An Azure DevOps sync is already running for this project");
  running.add(p.id);
  const t0 = Date.now();
  const s: AdoSyncSummary = { at: new Date().toISOString(), ok: true, total: 0, created: 0, updated: 0, recreated: 0, failed: 0, errors: [], warnings: [], stateFallbacks: [], durationMs: 0 };
  // Learned during the run so each refusal costs one round-trip, not one per item.
  const skipByType = new Map<string, Set<string>>();
  const sameRefused = new Set<string>();
  try {
    const items = parentsFirst(listItems(p.id));
    s.total = items.length;
    const adoIds = new Map<string, number>(items.filter((i) => i.ado_id).map((i) => [i.id, i.ado_id!]));
    for (const i of items) {
      try {
        const id = await syncItem(cfg, i, i.parent_id ? (adoIds.get(i.parent_id) ?? null) : null, s, skipByType, sameRefused);
        adoIds.set(i.id, id);
      } catch (e) {
        s.failed++;
        s.errors.push({ code: i.code, error: redact(e instanceof Error ? e.message : String(e)).slice(0, 500) });
      }
    }
  } catch (e) {
    s.error = redact(e instanceof Error ? e.message : String(e));
  } finally {
    running.delete(p.id);
  }
  s.ok = !s.failed && !s.error;
  s.durationMs = Date.now() - t0;
  // Keep the stored summary small.
  const stored = { ...s, errors: s.errors.slice(0, 50), warnings: s.warnings.slice(0, 50), stateFallbacks: s.stateFallbacks.slice(0, 50) };
  setSetting(SUMMARY_KEY(p.id), stored);
  logActivity({
    projectId: p.id,
    type: "ado_sync",
    summary: `Azure DevOps sync to ${cfg.project}: ${s.created} created, ${s.updated} updated${s.failed ? `, ${s.failed} failed` : ""}${s.stateFallbacks.length ? `, ${s.stateFallbacks.length} sent with Agile states` : ""}`,
    detail: { project: cfg.project, created: s.created, updated: s.updated, recreated: s.recreated, failed: s.failed, errors: stored.errors.slice(0, 10), stateFallbacks: stored.stateFallbacks.slice(0, 10), error: s.error },
  });
  emit({ type: "project", projectId: p.id });
  return s;
}

async function syncItem(
  cfg: AdoConfig,
  i: WorkItem,
  parentAdoId: number | null,
  s: AdoSyncSummary,
  skipByType: Map<string, Set<string>>,
  sameRefused: Set<string>,
): Promise<number> {
  const type = ADO_TYPE[i.type];
  const skip = skipByType.get(type) ?? new Set<string>();
  skipByType.set(type, skip);
  if (i.parent_id && parentAdoId == null) s.warnings.push({ code: i.code, message: "Parent isn't in Azure DevOps (it failed to sync) — sent without a parent link" });

  // Update path first: the stored id must still exist (it may have been deleted in ADO).
  let existing: any = null;
  if (i.ado_id) {
    const r = await adoFetch("GET", `${cfg.orgUrl}/_apis/wit/workitems/${i.ado_id}?$expand=relations&${API}`);
    if (ok(r)) existing = r.body;
    else if (r.status !== 404) throw new Error(r.message);
  }

  let agile = cfg.stateMode === "agile" || sameRefused.has(`${type}|${i.state}`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const state = agile ? agileState(i.state, i.type) : i.state;
    const ops = fieldOps(cfg, i, state, skip);
    const r = existing
      ? await adoFetch("PATCH", `${cfg.orgUrl}/_apis/wit/workitems/${i.ado_id}?${API}`, [...ops, ...parentOps(cfg, existing, parentAdoId)], "application/json-patch+json")
      : await adoFetch(
          "POST",
          `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/$${encodeURIComponent(type)}?${API}`,
          [...ops, ...(parentAdoId != null ? [{ op: "add", path: "/relations/-", value: { rel: PARENT, url: itemApiUrl(cfg, parentAdoId) } }] : [])],
          "application/json-patch+json",
        );
    if (ok(r)) {
      const id = Number(r.body?.id ?? i.ado_id);
      if (!Number.isFinite(id) || id <= 0) throw new Error("Azure DevOps didn't return a work item id");
      if (agile && cfg.stateMode === "same") s.stateFallbacks.push({ code: i.code, state: i.state, sent: state });
      if (existing) s.updated++;
      else {
        s.created++;
        if (i.ado_id) s.recreated++;
      }
      if (i.ado_id !== id) {
        update("work_items", i.id, { ado_id: id });
        emit({ type: "item", projectId: i.project_id, data: getItem(i.id) });
      }
      return id;
    }
    // Deleted in ADO between our read and the write: create it again.
    if (r.status === 404 && existing) {
      existing = null;
      continue;
    }
    if (!agile && invalidState(r)) {
      agile = true;
      sameRefused.add(`${type}|${i.state}`);
      continue;
    }
    const f = badField(r, ops);
    if (f) {
      skip.add(f);
      s.warnings.push({ code: i.code, message: `${f} was refused for ${type} and left out: ${r.message.slice(0, 200)}` });
      continue;
    }
    throw new Error(r.message || `HTTP ${r.status}`);
  }
  throw new Error("Azure DevOps kept refusing this item");
}

/** For the system check: projects that have Azure DevOps configured. */
export function adoProjects() {
  return listProjects().filter((p) => adoConfigOf(p));
}
