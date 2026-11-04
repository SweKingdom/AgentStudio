/**
 * Importing a backlog that already exists in Azure DevOps, so AgentStudio can join a project people are working on.
 *
 * Read only: it queries work items (WIQL) and reads them; nothing in Azure DevOps is changed here. Items keep their
 * Azure DevOps id (`ado_id`) and code (US-12146), so importing again updates them instead of adding copies. Done items
 * come in as delivered and are never rebuilt; who an item is assigned to and its iteration and tags come along, so
 * AgentStudio's rule (ownership.ts) decides which ones it builds. Imported stories are merged after review.
 */
import { adoFetch, ok, type AdoConfig } from "./ado.js";
import { insert, now } from "./db.js";
import { ownedByStudio } from "./ownership.js";
import { addQuestion, createItem, getProject, listItems, logActivity, openQuestionCount, patchItem, patchProject, type Project, type WorkItem } from "./store.js";

/** Which Azure DevOps items belong to the project: under an area path, in an iteration, with tags (all optional). */
export interface AdoImportFilter {
  areaPath?: string;
  iterationPath?: string;
  tags?: string[];
}

const TYPES: Record<string, WorkItem["type"]> = { Epic: "epic", Feature: "feature", "User Story": "story", "Product Backlog Item": "story", Requirement: "story", Task: "task", Bug: "bug" };
const PREFIX: Record<WorkItem["type"], string> = { epic: "EP", feature: "FT", story: "US", task: "TK", bug: "BG" };
/** Azure DevOps states that mean the work is finished (any process), and ones that mean it was dropped. */
const DONE = /^(done|closed|resolved|completed)$/i;
const DROPPED = /^(removed|cut)$/i;
/** States that mean someone is working on it (Agile, Scrum, CMMI and boards like Design → Develop → Test). */
const STARTED = /^(active|committed|in progress|doing|design|develop|development|test|testing|in review)$/i;

export interface AdoItem {
  adoId: number;
  type: WorkItem["type"];
  title: string;
  adoState: string;
  description: string;
  acceptance: string;
  points: number | null;
  assignee: string | null;
  iteration: string | null;
  tags: string[];
  parentAdoId: number | null;
  dependsOnAdoIds: number[];
}

/** Azure DevOps rich text as plain text: paragraphs and list items on their own lines, entities decoded. */
export function htmlToText(html: string) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h\d|ul|ol|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const idFromUrl = (url: string) => Number(String(url).match(/\/workItems\/(\d+)$/i)?.[1] ?? NaN);

/** One Azure DevOps work item, as AgentStudio needs it. Null for types it doesn't track. */
export function mapAdoItem(raw: { id: number; fields: Record<string, any>; relations?: { rel: string; url: string }[] | null }): AdoItem | null {
  const f = raw.fields ?? {};
  const type = TYPES[String(f["System.WorkItemType"] ?? "")];
  if (!type) return null;
  const rels = raw.relations ?? [];
  const description = htmlToText(f["System.Description"] ?? "");
  // "Depends on: #12140, 12141" in the description, as well as Azure DevOps dependency links.
  const dependsLine = description.match(/depends on[:\s]+([^\n]+)/i)?.[1] ?? "";
  const fromText = [...dependsLine.matchAll(/#?(\d{2,})/g)].map((m) => Number(m[1]));
  const fromLinks = rels.filter((r) => r.rel === "System.LinkTypes.Dependency-Reverse").map((r) => idFromUrl(r.url));
  const assigned = f["System.AssignedTo"];
  const points = Number(f["Microsoft.VSTS.Scheduling.StoryPoints"] ?? f["Microsoft.VSTS.Scheduling.Effort"]);
  return {
    adoId: raw.id,
    type,
    title: String(f["System.Title"] ?? `Work item ${raw.id}`).slice(0, 250),
    adoState: String(f["System.State"] ?? ""),
    description,
    acceptance: htmlToText(f["Microsoft.VSTS.Common.AcceptanceCriteria"] ?? ""),
    points: Number.isFinite(points) && points > 0 ? Math.round(points) : null,
    assignee: (typeof assigned === "object" ? assigned?.displayName : assigned)?.toString().trim() || null,
    iteration: String(f["System.IterationPath"] ?? "").split("\\").filter(Boolean).at(-1) || null,
    tags: String(f["System.Tags"] ?? "").split(";").map((t) => t.trim()).filter(Boolean),
    parentAdoId: rels.map((r) => (r.rel === "System.LinkTypes.Hierarchy-Reverse" ? idFromUrl(r.url) : NaN)).find((n) => Number.isFinite(n)) ?? null,
    dependsOnAdoIds: [...new Set([...fromText, ...fromLinks].filter((n) => Number.isFinite(n) && n !== raw.id))],
  };
}

const wiqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The WIQL query for the filter: work items AgentStudio tracks, in the project, not removed. */
export function wiqlFor(cfg: Pick<AdoConfig, "project">, filter: AdoImportFilter) {
  const where = [
    `[System.TeamProject] = ${wiqlText(cfg.project)}`,
    `[System.WorkItemType] IN (${Object.keys(TYPES).map(wiqlText).join(", ")})`,
    `[System.State] <> 'Removed'`,
    filter.areaPath?.trim() ? `[System.AreaPath] UNDER ${wiqlText(filter.areaPath.trim())}` : "",
    filter.iterationPath?.trim() ? `[System.IterationPath] UNDER ${wiqlText(filter.iterationPath.trim())}` : "",
    ...(filter.tags ?? []).filter((t) => t.trim()).map((t) => `[System.Tags] CONTAINS ${wiqlText(t.trim())}`),
  ].filter(Boolean);
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY [System.Id]`;
}

/** Reads the matching work items from Azure DevOps (at most 2,000). Changes nothing there. */
export async function fetchAdoItems(cfg: AdoConfig, filter: AdoImportFilter): Promise<AdoItem[]> {
  const base = `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_apis/wit`;
  const q = await adoFetch("POST", `${base}/wiql?api-version=7.1&$top=2000`, { query: wiqlFor(cfg, filter) });
  if (!ok(q)) throw new Error(`Azure DevOps query failed: ${q.message}`);
  const ids: number[] = (q.body?.workItems ?? []).map((w: { id: number }) => w.id);
  const out: AdoItem[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await adoFetch("GET", `${base}/workitems?ids=${ids.slice(i, i + 200).join(",")}&$expand=relations&api-version=7.1`);
    if (!ok(r)) throw new Error(`Reading work items from Azure DevOps failed: ${r.message}`);
    for (const raw of r.body?.value ?? []) {
      const m = mapAdoItem(raw);
      if (m) out.push(m);
    }
  }
  return out;
}

/** The AgentStudio state for an Azure DevOps state: finished and dropped items keep that; someone's work in progress
 *  shows as In Progress; anything else starts at New, where AgentStudio refines and plans it if it builds it. */
function stateFor(project: Pick<Project, "settings">, a: AdoItem, current?: WorkItem) {
  if (DONE.test(a.adoState)) return "Deployed (Done)";
  if (DROPPED.test(a.adoState)) return "Cancelled";
  const owner = { owner: current?.owner ?? null, assignee: a.assignee, iteration: a.iteration, tags: a.tags };
  if (current && ownedByStudio(project, owner)) return current.state; // AgentStudio's own progress is its own
  return STARTED.test(a.adoState) && !ownedByStudio(project, owner) ? "In Progress" : current?.state ?? "New";
}

export interface ImportResult {
  created: number;
  updated: number;
  done: number;
  questions: number;
  total: number;
}

/** Creates the items that are new and updates the ones imported before (matched by Azure DevOps id). */
export async function importBacklog(projectId: string, cfg: AdoConfig, filter: AdoImportFilter): Promise<ImportResult> {
  const fetched = await fetchAdoItems(cfg, filter);
  const p = getProject(projectId)!;
  const existing = new Map(listItems(projectId).filter((i) => i.ado_id).map((i) => [i.ado_id!, i]));
  const codes = new Set(listItems(projectId).map((i) => i.code));
  const byAdo = new Map<number, WorkItem>();
  let created = 0;
  let updated = 0;
  // Parents first, so children can point at them.
  const order: WorkItem["type"][] = ["epic", "feature", "story", "task", "bug"];
  for (const a of [...fetched].sort((x, y) => order.indexOf(x.type) - order.indexOf(y.type))) {
    const cur = existing.get(a.adoId);
    const fields: Partial<WorkItem> = {
      title: a.title,
      user_story: a.description,
      acceptance_criteria: a.acceptance,
      story_points: a.points ?? cur?.story_points ?? null,
      assignee: a.assignee,
      iteration: a.iteration,
      tags: a.tags,
      state: stateFor(p, a, cur),
    };
    if (cur) {
      const changed = (Object.keys(fields) as (keyof WorkItem)[]).filter((k) => JSON.stringify(cur[k] ?? null) !== JSON.stringify(fields[k] ?? null));
      byAdo.set(a.adoId, changed.length ? patchItem(cur.id, fields) : cur);
      if (changed.length) updated++;
      // Someone changed what AgentStudio is already building: it goes to the developer as the product owner's comment.
      const spec = changed.filter((k) => k === "title" || k === "user_story" || k === "acceptance_criteria");
      if (spec.length && ownedByStudio(p, cur) && !["New", "Deployed (Done)", "Cancelled"].includes(cur.state)) {
        const label: Record<string, string> = { title: "title", user_story: "description", acceptance_criteria: "acceptance criteria" };
        insert("comments", { project_id: projectId, item_id: cur.id, author_id: "human", content: `Changed in Azure DevOps (${spec.map((k) => label[k]).join(", ")}):${spec.map((k) => `\n\n${label[k]}:\n${String(fields[k] ?? "")}`).join("")}`, created_at: now() });
      }
      continue;
    }
    const code = codes.has(`${PREFIX[a.type]}-${a.adoId}`) ? undefined : `${PREFIX[a.type]}-${a.adoId}`;
    if (code) codes.add(code);
    const it = createItem(projectId, {
      type: a.type,
      ...fields,
      title: a.title,
      ...(code ? { code } : {}),
      ado_id: a.adoId,
      created_by: "ado",
      ...(a.type === "story" || a.type === "task" || a.type === "bug" ? { merge_mode: "review" as const } : {}),
    });
    byAdo.set(a.adoId, it);
    created++;
  }
  // Links between items, now that every one has its AgentStudio id and code.
  for (const a of fetched) {
    const it = byAdo.get(a.adoId);
    if (!it) continue;
    const parent = a.parentAdoId ? byAdo.get(a.parentAdoId) ?? existing.get(a.parentAdoId) : undefined;
    const deps = a.dependsOnAdoIds.map((id) => (byAdo.get(id) ?? existing.get(id))?.code).filter((c): c is string => !!c);
    const patch: Partial<WorkItem> = {};
    if ((parent?.id ?? null) !== it.parent_id) patch.parent_id = parent?.id ?? null;
    if (JSON.stringify(deps) !== JSON.stringify(it.depends_on)) patch.depends_on = deps;
    if (Object.keys(patch).length) byAdo.set(a.adoId, patchItem(it.id, patch));
  }
  const questions = askAboutUnclear(projectId, [...byAdo.values()]);
  // An imported backlog replaces the analyst's: the requirements stage (which starts from an empty backlog) never runs.
  const proj = getProject(projectId)!;
  patchProject(projectId, {
    settings: { ...proj.settings, ado: { ...cfg, writeMode: cfg.writeMode ?? "state" }, adoImport: { ...filter, lastImport: new Date().toISOString() } },
    stages: proj.stages.map((s) => (s.key === "requirements" && s.status === "pending" ? { ...s, status: "skipped" } : s)),
  });
  const done = [...byAdo.values()].filter((i) => i.state === "Deployed (Done)").length;
  logActivity({ projectId, agentId: "human", type: "item_created", summary: `Imported ${fetched.length} item(s) from Azure DevOps: ${created} new, ${updated} updated, ${done} already done${questions ? `, ${questions} question(s) about unclear stories` : ""}` });
  return { created, updated, done, questions, total: fetched.length };
}

/** AgentStudio's own imported stories that don't say what "done" means: ask the product owner instead of guessing. */
function askAboutUnclear(projectId: string, items: WorkItem[]) {
  const p = getProject(projectId)!;
  let asked = 0;
  for (const it of items) {
    if (it.type !== "story" || it.state === "Deployed (Done)" || it.state === "Cancelled" || !ownedByStudio(p, it)) continue;
    if (it.acceptance_criteria.trim() || openQuestionCount(it.id)) continue;
    // One question per story: similar wording across stories must not merge them into one answer.
    addQuestion(projectId, `${it.code} "${it.title}" came from Azure DevOps without acceptance criteria. What must be true for it to be done?`, it.id, "requirements");
    asked++;
  }
  return asked;
}
