/**
 * What each agent is told at the start of a run — the minimum it needs, so it can start working on its first turn
 * instead of fetching context with tool calls (every extra turn re-sends the whole conversation).
 *
 * Two parts:
 *  - `shared`: project-level context, identical for every run of the same role in a project → its own prompt-cache
 *    breakpoint, so repeated runs (one per story) re-read it from cache instead of paying for it again.
 *  - `specific`: this run's work — the story card, the design excerpt that concerns it, the files it touches, what the
 *    previous agent handed over. Each block is capped; agents can still read more with tools when they need it.
 */
import { all, get } from "../db.js";
import { answeredQuestions, findDoc, listItems, listWorkspaceFiles, type Project, type WorkItem } from "../store.js";
import type { Agent } from "./store.js";
import { projectSalesforce, teamSettings } from "../team.js";

/** The team's conventions every agent follows — short, and identical across runs (cache-friendly). */
function conventionsBlock(project: Project) {
  const c = teamSettings().conventions;
  const sf = projectSalesforce(project);
  return [
    "## Team conventions",
    `- Write every deliverable (documents, work items, code comments, release notes) in ${c.language}.`,
    `- Salesforce API version ${sf.apiVersion}${sf.namespace ? ` · namespace \`${sf.namespace}\`` : ""}${sf.prefix ? ` · new custom objects, fields, classes and components start with \`${sf.prefix}\`` : ""}.`,
    `- Minimum Apex coverage for every class a story changes: ${sf.coverageMin}%.`,
  ].join("\n");
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, "")}\n…[truncated — read the full text with a tool if you need it]`);

/** Markdown sections (## / ###) of a document. */
export function sections(md: string) {
  const out: { heading: string; level: number; body: string }[] = [];
  let cur: { heading: string; level: number; lines: string[] } = { heading: "", level: 0, lines: [] };
  for (const line of md.split("\n")) {
    const m = line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (m && m[1].length >= 2) {
      out.push({ heading: cur.heading, level: cur.level, body: cur.lines.join("\n").trim() });
      cur = { heading: m[2], level: m[1].length, lines: [] };
    } else cur.lines.push(line);
  }
  out.push({ heading: cur.heading, level: cur.level, body: cur.lines.join("\n").trim() });
  return out.filter((s) => s.heading || s.body);
}

/** A document's table of contents (cheap to send; agents read a section when they need it). */
export function toc(md: string) {
  return sections(md)
    .filter((s) => s.heading)
    .map((s) => `${"  ".repeat(Math.max(0, s.level - 2))}- ${s.heading}`)
    .join("\n");
}

/** The parts of a document that mention any of the given terms (story code, objects, components). */
function excerpt(md: string, terms: string[], max: number) {
  const t = terms.filter((x) => x && x.length > 2).map((x) => x.toLowerCase());
  if (!t.length) return "";
  const hits = sections(md).filter((s) => t.some((x) => `${s.heading}\n${s.body}`.toLowerCase().includes(x)));
  return clip(hits.map((s) => `${s.heading ? `### ${s.heading}\n` : ""}${s.body}`).join("\n\n"), max);
}

const FIELD_LABELS: [keyof WorkItem, string][] = [
  ["user_story", "User story"],
  ["background", "Background"],
  ["business_rules", "Business rules"],
  ["acceptance_criteria", "Acceptance criteria"],
  ["tech_spec", "Technical specification"],
  ["dependencies", "Dependencies"],
  ["out_of_scope", "Out of scope"],
  ["solution_components", "Solution components"],
  ["how_to_test", "How to test"],
  ["manual_steps", "Manual steps"],
];

/** The full story card — so nobody has to call get_item for the story they were given. */
export function itemCard(it: WorkItem, opts: { fields?: (keyof WorkItem)[] } = {}) {
  const items = listItems(it.project_id);
  const byId = new Map(items.map((x) => [x.id, x]));
  const parent = it.parent_id ? byId.get(it.parent_id) : undefined;
  const epic = parent?.parent_id ? byId.get(parent.parent_id) : undefined;
  const deps = it.depends_on.map((c) => items.find((x) => x.code === c)).filter(Boolean) as WorkItem[];
  const head = [
    `## ${it.code} — ${it.title}`,
    [
      `Type: ${it.type}`,
      `Category: ${it.category}`,
      `State: ${it.state}`,
      it.story_points ? `Points: ${it.story_points}` : "",
      it.moscow ? `MoSCoW: ${it.moscow}` : "",
      it.branch ? `Branch: ${it.branch}` : "",
      it.rework_count ? `Rework loops so far: ${it.rework_count}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    parent ? `Feature: ${parent.code} ${parent.title}${epic ? ` · Epic: ${epic.code} ${epic.title}` : ""}` : "",
    deps.length ? `Depends on: ${deps.map((d) => `${d.code} (${d.state})`).join(", ")}` : "",
  ].filter(Boolean);
  const fields = (opts.fields ?? FIELD_LABELS.map(([k]) => k))
    .map((k) => {
      const v = String(it[k] ?? "").trim();
      const label = FIELD_LABELS.find(([f]) => f === k)?.[1] ?? String(k);
      return v ? `### ${label}\n${v}` : "";
    })
    .filter(Boolean);
  const answers = answeredQuestions(it.project_id).filter((q) => q.item_id === it.id);
  if (answers.length) fields.push(`### Answers from the product owner\n${answers.map((a) => `- **Q:** ${a.question}\n  **A:** ${a.answer}`).join("\n")}`);
  return [...head, ...fields].join("\n");
}

/** One line per work item — enough to reason about the whole backlog without its full text. */
export function backlogTable(projectId: string, filter: (i: WorkItem) => boolean = () => true) {
  const items = listItems(projectId).filter(filter);
  const code = new Map(listItems(projectId).map((x) => [x.id, x.code]));
  const rows = items.map((i) =>
    [i.code, i.type, i.parent_id ? code.get(i.parent_id) ?? "" : "", i.title, i.category, i.state, i.story_points ?? "", i.depends_on.join(" ")].join(" | "),
  );
  return rows.length ? `code | type | parent | title | category | state | pts | depends on\n${rows.join("\n")}` : "(no work items yet)";
}

/** The solution design sections that concern this item (its code, objects, components), capped. */
export function designExcerpt(project: Pick<Project, "id">, item: WorkItem, max = 2500) {
  const design = findDoc(project.id, "solution_design", null);
  return design ? excerpt(design.content, termsFor(item), max) : "";
}

/** Object / component names an item touches — used to pick the design and files that concern it. */
function termsFor(it: WorkItem) {
  const text = `${it.title}\n${it.tech_spec}\n${it.solution_components}`;
  const apiNames = [...new Set(text.match(/\b[A-Z][A-Za-z0-9]*(?:__c|__mdt|__e)\b|\b(?:Case|Account|Contact|Lead|Opportunity|WorkOrder|ServiceAppointment|Order|Product2|User|Task|Event|Asset|Entitlement)\b/g) ?? [])];
  return [it.code, ...apiNames];
}

/** Workspace paths grouped by folder, capped — so agents know what exists without listing it. */
function fileTree(paths: string[], max = 120) {
  const shown = paths.filter((p) => p.startsWith("force-app/") || p.startsWith("scripts/") || p.startsWith("manifest/")).slice(0, max);
  const more = paths.length - shown.length;
  return shown.length ? `${shown.join("\n")}${more > 0 ? `\n…and ${more} more (list_files)` : ""}` : "(no source files yet)";
}

export interface RunContext {
  shared: string;
  specific: string;
}

/** Answers to project-level questions (item-level answers travel on the story card). */
function projectAnswers(projectId: string) {
  const a = answeredQuestions(projectId).filter((q) => !q.item_id);
  return a.length ? `## Answers from the product owner\n${a.map((x) => `- **Q:** ${x.question}\n  **A:** ${x.answer}`).join("\n")}` : "";
}

/** The brief's opening section (its executive summary) — what every agent needs to know about the project. */
function briefSummary(projectId: string, max = 1500) {
  const brief = findDoc(projectId, "project_brief", null);
  if (!brief) return "";
  const s = sections(brief.content);
  const first = s.find((x) => x.body.length > 80) ?? s[0];
  return first ? `## Project summary\n${clip(first.body, max)}` : "";
}

export function contextFor(project: Project, agent: Agent, item?: WorkItem, o: { changedFiles?: string[] } = {}): RunContext {
  const title = `# Project ${project.key} — ${project.name}`;
  const role = agent.role;
  const desc = project.description?.trim() ? `## Description from the product owner\n${project.description.trim()}` : "";
  const shared: string[] = [title, conventionsBlock(project)];
  const specific: string[] = [];

  if (role === "requirements") {
    shared.push(desc, projectAnswers(project.id));
    const existing = listItems(project.id).length;
    if (existing) specific.push(`## Current backlog\n${backlogTable(project.id)}`);
  } else if (role === "architect") {
    const brief = findDoc(project.id, "project_brief", null);
    shared.push(brief ? `## Project brief\n${clip(brief.content, 12_000)}` : desc, projectAnswers(project.id));
    if (item) {
      specific.push(itemCard(item));
      const design = findDoc(project.id, "solution_design", null);
      if (design) specific.push(`## Solution design — table of contents (read a section with read_document)\n${toc(design.content)}`);
    } else specific.push(`## Backlog\n${backlogTable(project.id)}`);
  } else if (role === "planner") {
    shared.push(briefSummary(project.id) || desc, projectAnswers(project.id));
    specific.push(`## Backlog to plan\n${backlogTable(project.id, (i) => i.type !== "epic")}`);
    const design = findDoc(project.id, "solution_design", null);
    if (design) specific.push(`## Solution design — table of contents\n${toc(design.content)}`);
  } else if (role === "release") {
    shared.push(briefSummary(project.id, 800) || desc);
    const scope = listItems(project.id).filter((i) => i.state === "Smoke Testing" || i.state === "Release Ready");
    specific.push(
      `## Release scope\n${scope.map((i) => `### ${i.code} — ${i.title}\n${clip(i.solution_components || "(no components listed)", 1200)}${i.manual_steps ? `\n**Manual steps:** ${clip(i.manual_steps, 600)}` : ""}`).join("\n\n") || "(nothing in scope)"}`,
    );
  } else {
    // developer, qa, writer, specialists: one story at a time.
    shared.push(briefSummary(project.id) || clip(desc, 1500), projectAnswers(project.id));
    if (item) {
      specific.push(itemCard(item));
      const design = findDoc(project.id, "solution_design", null);
      const relevant = design ? excerpt(design.content, termsFor(item), role === "developer" ? 5000 : 2500) : "";
      if (relevant && role !== "writer") specific.push(`## Solution design — the parts that concern ${item.code}\n${relevant}`);
      if (role === "developer") specific.push(`## Files on your branch\n${fileTree(listWorkspaceFiles(project, item.code))}`);
      if (role === "developer" || role === "qa") specific.push(`## Review checklist (${role === "qa" ? "check every point" : "QA checks every point — get it right first time"})\n${teamSettings().conventions.reviewChecklist}`);
      if ((role === "qa" || role === "writer") && o.changedFiles) {
        specific.push(`## Files ${item.code} changed on its branch\n${o.changedFiles.length ? o.changedFiles.join("\n") : "(none)"}`);
      }
      if (role === "writer") {
        const docs = ["user_manual", "technical_overview", "changelog"]
          .map((k) => ({ k, d: findDoc(project.id, k, null) }))
          .map(({ k, d }) => `- **${k}**${d ? `:\n${toc(d.content).split("\n").map((l) => `  ${l}`).join("\n") || "  (no sections yet)"}` : " (not written yet)"}`);
        specific.push(`## Living documents — current sections\n${docs.join("\n")}`);
      }
    }
  }
  return { shared: shared.filter(Boolean).join("\n\n"), specific: specific.filter(Boolean).join("\n\n") };
}

/** Compact context for a consultation: the asker's story plus the project summary. */
export function consultContext(project: Project, item?: WorkItem) {
  return [`# Project ${project.key} — ${project.name}`, briefSummary(project.id, 1000) || clip(project.description ?? "", 1000), item ? itemCard(item, { fields: ["user_story", "acceptance_criteria", "tech_spec"] }) : ""]
    .filter(Boolean)
    .join("\n\n");
}

/** Failed checks only (the rest of the report is noise for a fix). */
export function failedChecks(itemId: string) {
  const rows = all<{ ac_ref: string; notes: string; iteration: number }>(
    "SELECT ac_ref, notes, iteration FROM test_results WHERE item_id = ? AND result = 'fail' AND iteration = (SELECT MAX(iteration) FROM test_results WHERE item_id = ?) ORDER BY id",
    itemId,
    itemId,
  );
  return rows.map((r) => `- ❌ ${r.ac_ref}: ${r.notes}`).join("\n");
}

export const hasTestResults = (itemId: string) => !!get("SELECT 1 FROM test_results WHERE item_id = ?", itemId);
