/**
 * Importing a backlog that already exists in Azure DevOps, so AgentStudio can join a project people are working on.
 *
 * Three steps, with a buffer between fetching and the backlog:
 *  1. Fetch (read only): a WIQL query for the ids, then the work items in batches of 200 with only the fields the
 *     project's mapping reads (adomapping.ts), and dependency links with one link query per batch.
 *  2. Buffer: each work item is kept as Azure DevOps sent it (`ado_raw`). The next refresh compares against it, so only
 *     fields that changed in Azure DevOps are passed on — AgentStudio's own refinements of a story aren't overwritten,
 *     and a story under way gets only the change, not the whole text again.
 *  3. Map: the saved mapping turns the buffered fields into backlog items. Items keep their Azure DevOps id (`ado_id`)
 *     and code (US-12146); done items come in as delivered; who an item is assigned to, its iteration and tags come
 *     along, so AgentStudio's rule (ownership.ts) decides which ones it builds. Imported stories merge after review.
 */
import { diffLines } from "diff";
import { adoFetch, ok, type AdoConfig } from "./ado.js";
import { categoryOf, computeMapping, defaultMapping, DEFAULT_TYPES, fieldsToRead, type AdoMapping } from "./adomapping.js";
import { get, insert, now, run } from "./db.js";
import { ownedByStudio } from "./ownership.js";
import { addQuestion, createItem, getProject, listItems, logActivity, openQuestionCount, patchItem, patchProject, type Project, type WorkItem } from "./store.js";

/** Which Azure DevOps items belong to the project: under an area path, in an iteration, with tags (all optional). */
export interface AdoImportFilter {
  areaPath?: string;
  iterationPath?: string;
  tags?: string[];
}

const PREFIX: Record<WorkItem["type"], string> = { epic: "EP", feature: "FT", story: "US", task: "TK", bug: "BG" };

/** A work item as Azure DevOps sent it: the fields the mapping reads, and the items it depends on (links). */
export interface RawItem {
  id: number;
  rev: number | null;
  fields: Record<string, any>;
  dependsOnLinks: number[];
}

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

/** One buffered work item, as AgentStudio needs it, through the project's mapping. Null for types it doesn't track. */
export function mapAdoItem(raw: RawItem, m: AdoMapping = defaultMapping()): AdoItem | null {
  const f = raw.fields ?? {};
  const type = m.types[String(f["System.WorkItemType"] ?? "")];
  if (!type) return null;
  const description = htmlToText(f[m.fields.description] ?? "");
  // "Depends on: #12140, 12141" in the description, as well as Azure DevOps dependency links.
  const dependsLine = description.match(/depends on[:\s]+([^\n]+)/i)?.[1] ?? "";
  const fromText = [...dependsLine.matchAll(/#?(\d{2,})/g)].map((x) => Number(x[1]));
  const assigned = f[m.fields.assignee];
  const points = Number(f[m.fields.points]);
  const parent = Number(f["System.Parent"]);
  return {
    adoId: raw.id,
    type,
    title: String(f[m.fields.title] ?? `Work item ${raw.id}`).slice(0, 250),
    adoState: String(f["System.State"] ?? ""),
    description,
    acceptance: htmlToText(f[m.fields.acceptance] ?? ""),
    points: Number.isFinite(points) && points > 0 ? Math.round(points) : null,
    assignee: (typeof assigned === "object" ? assigned?.displayName : assigned)?.toString().trim() || null,
    iteration: String(f[m.fields.iteration] ?? "").split("\\").filter(Boolean).at(-1) || null,
    tags: String(f[m.fields.tags] ?? "").split(";").map((t) => t.trim()).filter(Boolean),
    parentAdoId: Number.isFinite(parent) && parent > 0 ? parent : null,
    dependsOnAdoIds: [...new Set([...fromText, ...raw.dependsOnLinks].filter((n) => Number.isFinite(n) && n !== raw.id))],
  };
}

const wiqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The WIQL query for the filter: work items of the mapped types, in the project, not removed. */
export function wiqlFor(cfg: Pick<AdoConfig, "project">, filter: AdoImportFilter, m: Pick<AdoMapping, "types"> = { types: DEFAULT_TYPES }) {
  const where = [
    `[System.TeamProject] = ${wiqlText(cfg.project)}`,
    `[System.WorkItemType] IN (${Object.keys(m.types).map(wiqlText).join(", ")})`,
    `[System.State] <> 'Removed'`,
    filter.areaPath?.trim() ? `[System.AreaPath] UNDER ${wiqlText(filter.areaPath.trim())}` : "",
    filter.iterationPath?.trim() ? `[System.IterationPath] UNDER ${wiqlText(filter.iterationPath.trim())}` : "",
    ...(filter.tags ?? []).filter((t) => t.trim()).map((t) => `[System.Tags] CONTAINS ${wiqlText(t.trim())}`),
  ].filter(Boolean);
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY [System.Id]`;
}

/** The dependency links of a batch: which of these items depend on which (predecessor links). */
export const dependencyWiql = (ids: number[]) =>
  `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.Id] IN (${ids.join(", ")})) AND ([System.Links.LinkType] = 'System.LinkTypes.Dependency-Reverse') MODE (MustContain)`;

/** Fetches the matching work items (at most 2,000): only the mapped fields, in batches of 200. Changes nothing. */
export async function fetchRawItems(cfg: AdoConfig, filter: AdoImportFilter, m: AdoMapping): Promise<{ items: RawItem[]; warnings: string[] }> {
  const base = `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_apis/wit`;
  const q = await adoFetch("POST", `${base}/wiql?api-version=7.1&$top=2000`, { query: wiqlFor(cfg, filter, m) });
  if (!ok(q)) throw new Error(`Azure DevOps query failed: ${q.message}`);
  const ids: number[] = (q.body?.workItems ?? []).map((w: { id: number }) => w.id);
  const items: RawItem[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const r = await adoFetch("POST", `${base}/workitemsbatch?api-version=7.1`, { ids: batch, fields: fieldsToRead(m) });
    if (!ok(r)) throw new Error(`Reading work items from Azure DevOps failed: ${r.message}`);
    const links = new Map<number, number[]>();
    const l = await adoFetch("POST", `${base}/wiql?api-version=7.1`, { query: dependencyWiql(batch) });
    if (ok(l)) {
      for (const rel of l.body?.workItemRelations ?? []) {
        if (!rel?.rel || !rel.source?.id || !rel.target?.id) continue;
        links.set(rel.source.id, [...(links.get(rel.source.id) ?? []), rel.target.id]);
      }
    } else warnings.push(`Dependency links couldn't be read (${l.message}); "Depends on" lines in descriptions still count.`);
    for (const raw of r.body?.value ?? []) items.push({ id: raw.id, rev: typeof raw.rev === "number" ? raw.rev : null, fields: raw.fields ?? {}, dependsOnLinks: links.get(raw.id) ?? [] });
  }
  return { items, warnings };
}

/** The matching work items as AgentStudio sees them (for the preview). */
export async function fetchAdoItems(cfg: AdoConfig, filter: AdoImportFilter, m: AdoMapping = defaultMapping()): Promise<AdoItem[]> {
  return (await fetchRawItems(cfg, filter, m)).items.map((r) => mapAdoItem(r, m)).filter((a): a is AdoItem => !!a);
}

/** The project's saved mapping, or one worked out from Azure DevOps now (the standard one if that fails). */
export async function mappingFor(projectId: string, cfg: AdoConfig): Promise<AdoMapping> {
  const saved = getProject(projectId)?.settings.adoMapping;
  if (saved) return saved;
  try {
    return await computeMapping(cfg);
  } catch {
    return defaultMapping();
  }
}

/** The AgentStudio state for an Azure DevOps state: finished and dropped items keep that; someone's work in progress
 *  shows as In Progress; anything else starts at New, where AgentStudio refines and plans it if it builds it. */
function stateFor(project: Pick<Project, "settings">, a: AdoItem, m: AdoMapping, current?: WorkItem) {
  const cat = categoryOf(a.adoState, m);
  if (cat === "done") return "Deployed (Done)";
  if (cat === "dropped") return "Cancelled";
  const owner = { owner: current?.owner ?? null, assignee: a.assignee, iteration: a.iteration, tags: a.tags };
  if (current && ownedByStudio(project, owner)) return current.state; // AgentStudio's own progress is its own
  return cat === "started" && !ownedByStudio(project, owner) ? "In Progress" : current?.state ?? "New";
}

/** Story fields that come from Azure DevOps, and their AgentStudio fields. */
const FROM_ADO: [keyof AdoItem, keyof WorkItem, string][] = [
  ["title", "title", "title"],
  ["description", "user_story", "description"],
  ["acceptance", "acceptance_criteria", "acceptance criteria"],
  ["points", "story_points", "story points"],
  ["assignee", "assignee", "assigned to"],
  ["iteration", "iteration", "iteration"],
  ["tags", "tags", "tags"],
];
const SPEC: (keyof AdoItem)[] = ["title", "description", "acceptance"];

/** Only what changed, line by line: "+ added", "- removed". */
export function changeText(label: string, before: string, after: string) {
  if (!before.includes("\n") && !after.includes("\n")) return `${label}: "${before}" → "${after}"`;
  // Both end with a line break, so an unchanged last line isn't reported as changed.
  const lines = diffLines(`${before}\n`, `${after}\n`).flatMap((p) => (p.added || p.removed ? p.value.replace(/\n$/, "").split("\n").map((l) => `${p.added ? "+" : "-"} ${l}`) : []));
  return `${label}:\n${lines.join("\n")}`;
}

export interface ImportResult {
  created: number;
  updated: number;
  done: number;
  questions: number;
  total: number;
  warnings: string[];
}

/** Creates the items that are new and updates the ones imported before (matched by Azure DevOps id), passing on only
 *  what changed in Azure DevOps since the last import. Saves the mapping it used. */
export async function importBacklog(projectId: string, cfg: AdoConfig, filter: AdoImportFilter, mapping?: AdoMapping): Promise<ImportResult> {
  const m = mapping ?? (await mappingFor(projectId, cfg));
  const { items: raws, warnings } = await fetchRawItems(cfg, filter, m);
  const p = getProject(projectId)!;
  const existing = new Map(listItems(projectId).filter((i) => i.ado_id).map((i) => [i.ado_id!, i]));
  const codes = new Set(listItems(projectId).map((i) => i.code));
  const byAdo = new Map<number, WorkItem>();
  const fetched: AdoItem[] = [];
  let created = 0;
  let updated = 0;
  // Parents first, so children can point at them.
  const order: WorkItem["type"][] = ["epic", "feature", "story", "task", "bug"];
  const mapped = raws.map((r) => ({ raw: r, a: mapAdoItem(r, m) })).filter((x): x is { raw: RawItem; a: AdoItem } => !!x.a);
  for (const { raw, a } of mapped.sort((x, y) => order.indexOf(x.a.type) - order.indexOf(y.a.type))) {
    fetched.push(a);
    const cur = existing.get(a.adoId);
    // What Azure DevOps had last time (the buffer): only fields that changed there since then are taken.
    const buffered = get<{ fields: string; depends_on: string; rev: number | null }>("SELECT fields, depends_on, rev FROM ado_raw WHERE project_id = ? AND ado_id = ?", projectId, a.adoId);
    const before = buffered ? mapAdoItem({ id: a.adoId, rev: buffered.rev, fields: JSON.parse(buffered.fields), dependsOnLinks: JSON.parse(buffered.depends_on) }, m) : null;
    run(
      "INSERT INTO ado_raw (project_id, ado_id, rev, fields, depends_on, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, ado_id) DO UPDATE SET rev = excluded.rev, fields = excluded.fields, depends_on = excluded.depends_on, fetched_at = excluded.fetched_at",
      projectId, a.adoId, raw.rev, JSON.stringify(raw.fields), JSON.stringify(raw.dependsOnLinks), now(),
    );
    const changedInAdo = FROM_ADO.filter(([k]) => !before || JSON.stringify(before[k] ?? null) !== JSON.stringify(a[k] ?? null));
    const fields: Partial<WorkItem> = Object.fromEntries(changedInAdo.map(([k, f]) => [f, k === "points" ? a.points ?? cur?.story_points ?? null : a[k]]));
    fields.state = stateFor(p, a, m, cur);
    if (cur) {
      const changed = (Object.keys(fields) as (keyof WorkItem)[]).filter((k) => JSON.stringify(cur[k] ?? null) !== JSON.stringify(fields[k] ?? null));
      byAdo.set(a.adoId, changed.length ? patchItem(cur.id, Object.fromEntries(changed.map((k) => [k, fields[k]]))) : cur);
      if (changed.length) updated++;
      // Someone changed what AgentStudio is already building: the change (not the whole text) goes to the developer.
      const spec = changedInAdo.filter(([k]) => SPEC.includes(k));
      if (before && spec.length && ownedByStudio(p, cur) && !["New", "Deployed (Done)", "Cancelled"].includes(cur.state)) {
        const text = spec.map(([k, , label]) => changeText(label, String(before[k] ?? ""), String(a[k] ?? ""))).join("\n\n");
        insert("comments", { project_id: projectId, item_id: cur.id, author_id: "human", content: `Changed in Azure DevOps:\n${text}`, created_at: now() });
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
    settings: { ...proj.settings, ado: { ...cfg, writeMode: cfg.writeMode ?? "state" }, adoImport: { ...filter, lastImport: new Date().toISOString() }, adoMapping: m },
    stages: proj.stages.map((s) => (s.key === "requirements" && s.status === "pending" ? { ...s, status: "skipped" } : s)),
  });
  const done = [...byAdo.values()].filter((i) => i.state === "Deployed (Done)").length;
  logActivity({ projectId, agentId: "human", type: "item_created", summary: `Imported ${fetched.length} item(s) from Azure DevOps: ${created} new, ${updated} updated, ${done} already done${questions ? `, ${questions} question(s) about unclear stories` : ""}${warnings.length ? ` — ${warnings[0]}` : ""}` });
  return { created, updated, done, questions, total: fetched.length, warnings };
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
