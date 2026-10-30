import type Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { all, get, getSetting, insert, now, setSetting, uid } from "../db.js";
import { emit } from "../events.js";
import {
  addQuestion,
  addTestResult,
  createItem,
  findDoc,
  getItemByCode,
  listItems,
  listWorkspaceFiles,
  rootFor,
  logActivity,
  openQuestionCount,
  patchItem,
  postMessage,
  readWorkspaceFile,
  recordFile,
  safeWorkspacePath,
  upsertDoc,
  workspaceDir,
  writeWorkspaceBinary,
  type Project,
  type WorkItem,
} from "../store.js";
import type { Agent } from "./store.js";
import { describeTarget, resolveTargetOrg, type TargetOrg } from "../salesforce.js";
import { renderEvidenceSvg } from "../evidence.js";
import { captureOrgScreenshot, orgPath, ScreenshotUnavailable } from "../screenshots.js";
import { detectObject } from "./simplan.js";
import { sections, toc } from "./context.js";
import { projectSalesforce, sfdxProjectJson } from "../team.js";
import { changedOnBranch, commitWork, tagRelease } from "../git.js";
import { deploySource, describeObject, formatDeploy, query, runAnonymousApex, sfAccess, sf, parseDeploy } from "../sf.js";
import { effectiveMode } from "../settings.js";
import { agentEmail, listAgents } from "./store.js";
import { buildEnvironment, type ReleaseEnvironment } from "../environments.js";

const pexec = promisify(execFile);

export interface ToolContext {
  project: Project;
  agent: Agent;
  runId: string;
  item?: WorkItem;
  iteration: number;
  /** Signals collected during the run, read by the orchestrator afterwards. */
  outcome: {
    devCompleted?: string;
    review?: { verdict: "approved" | "changes_requested"; findings: string };
    /** The architect's code review of the story's diff (submit_code_review). */
    codeReview?: { verdict: "approved" | "changes_requested"; findings: string };
    released?: { version: string };
    validation?: { ok: boolean; output: string };
    /** Last deploy_story result in this run (live with an org only). */
    orgDeploy?: { ok: boolean };
    /** Last run_apex_tests result in this run (live with an org only). */
    apexTests?: { ok: boolean };
  };
  /** Lets consult_agent run another agent (injected by the runner to avoid import cycles). */
  consult?: (target: Agent, question: string, ctx: ToolContext) => Promise<string>;
  /** The environment a release run works on (projects with environments): its org, deploy mode and test level. */
  environment?: ReleaseEnvironment;
}

type Handler = (input: Record<string, any>, ctx: ToolContext) => Promise<unknown> | unknown;

interface ToolSpec {
  def: Anthropic.Tool;
  handler: Handler;
  label: string; // human description for the UI
}

const STATES = [
  "New",
  "Requires additional information",
  "Ready for Refinement",
  "Ready for Sprint",
  "To Do",
  "In Progress",
  "In Peer Testing",
  "Ready for UAT",
  "Release Ready",
  "Smoke Testing",
  "Deployed (Done)",
  "Blocked",
  "Cancelled",
];

export const CATEGORIES = [
  "development",
  "configuration",
  "data_migration",
  "script",
  "integration",
  "security",
  "reporting",
  "testing",
  "documentation",
  "devops",
];

/** Documents that belong to one work item (stored next to its story folder) rather than to the project. */
const ITEM_DOC_KINDS = ["task_doc", "test_report"];

const DOC_KINDS = [
  "test_report",
  "project_brief",
  "solution_design",
  "delivery_plan",
  "task_doc",
  "user_manual",
  "technical_overview",
  "changelog",
  "release_notes",
];

const ITEM_TEXT_FIELDS = {
  user_story: { type: "string", description: "One sentence: As a {persona}, I want to {goal}, so that {benefit}." },
  background: { type: "string", description: "2-3 sentences of business context in plain language (Markdown)." },
  business_rules: { type: "string", description: "Markdown bullet list of business rules with explicit conditions." },
  dependencies: { type: "string", description: "Markdown bullet list." },
  out_of_scope: { type: "string", description: "Markdown bullet list." },
  acceptance_criteria: { type: "string", description: "Markdown. '### AC 1: Title' headings, direct outcomes, no Given/When/Then." },
  tech_spec: { type: "string", description: "Markdown technical specification with tables." },
} as const;

function req(input: Record<string, any>, ...keys: string[]) {
  const missing = keys.filter((k) => input[k] === undefined || input[k] === null || input[k] === "");
  if (missing.length) throw new Error(`Missing required field(s): ${missing.join(", ")}`);
}

function itemOrThrow(ctx: ToolContext, code: string) {
  const it = getItemByCode(ctx.project.id, code);
  if (!it) throw new Error(`No work item with code ${code} in this project`);
  return it;
}

function itemView(it: WorkItem) {
  const parent = it.parent_id ? get<{ code: string }>("SELECT code FROM work_items WHERE id = ?", it.parent_id) : undefined;
  return {
    code: it.code,
    type: it.type,
    parent: parent?.code ?? null,
    title: it.title,
    category: it.category,
    state: it.state,
    priority: it.priority,
    moscow: it.moscow,
    story_points: it.story_points,
    sprint: it.sprint,
    rank: it.rank,
    depends_on: it.depends_on,
    tags: it.tags,
    user_story: it.user_story,
    background: it.background,
    business_rules: it.business_rules,
    dependencies: it.dependencies,
    out_of_scope: it.out_of_scope,
    acceptance_criteria: it.acceptance_criteria,
    tech_spec: it.tech_spec,
    how_to_test: it.how_to_test,
    manual_steps: it.manual_steps,
    solution_components: it.solution_components,
    rework_count: it.rework_count,
  };
}

function resolveAgentRef(ctx: ToolContext, ref: string): Agent | undefined {
  const team = listAgents().filter((a) => ctx.project.agent_ids.includes(a.id) && a.id !== ctx.agent.id);
  const r = ref.toLowerCase().trim();
  return team.find((a) => a.role === r) ?? team.find((a) => a.name.toLowerCase() === r) ?? team.find((a) => a.id === ref);
}

const TOOLS: Record<string, ToolSpec> = {
  write_document: {
    label: "Write / replace a project document",
    def: {
      name: "write_document",
      description:
        "Create or replace a project document (Markdown). General documents (project_brief, solution_design, delivery_plan, user_manual, technical_overview, changelog, release_notes) are one per project and are REPLACED by the content you send — always send the complete document. To change part of an existing document, use update_document_section instead (much cheaper). task_doc and test_report are one per work item and need item_code; a test_report embeds the evidence images returned by capture_evidence.",
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: DOC_KINDS },
          title: { type: "string" },
          content: { type: "string", description: "Complete Markdown document." },
          item_code: { type: "string", description: "Required for task_doc." },
        },
        required: ["kind", "title", "content"],
      },
    },
    handler: (i, ctx) => {
      req(i, "kind", "title", "content");
      if (!DOC_KINDS.includes(i.kind)) throw new Error(`Unknown kind ${i.kind}`);
      const item = i.item_code ? itemOrThrow(ctx, i.item_code) : undefined;
      if (ITEM_DOC_KINDS.includes(i.kind) && !item) throw new Error(`${i.kind} requires item_code`);
      const doc = upsertDoc({
        projectId: ctx.project.id,
        kind: i.kind,
        itemId: ITEM_DOC_KINDS.includes(i.kind) ? item!.id : null,
        title: i.title,
        content: i.content,
        agentId: ctx.agent.id,
      });
      logActivity({
        projectId: ctx.project.id,
        agentId: ctx.agent.id,
        runId: ctx.runId,
        itemId: item?.id,
        type: "document",
        summary: `${doc.version > 1 ? "Updated" : "Wrote"} ${i.kind.replace(/_/g, " ")}${item ? ` for ${item.code}` : ""} (v${doc.version})`,
      });
      return `Saved ${i.kind} v${doc.version}.`;
    },
  },

  read_document: {
    label: "Read a project document",
    def: {
      name: "read_document",
      description:
        "Read a project document. Long documents return their table of contents first — then read just the section you need with `section` (a heading, or part of it). Empty string if it doesn't exist yet.",
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: DOC_KINDS },
          item_code: { type: "string" },
          section: { type: "string", description: "Heading (or part of it) of the one section to read." },
          full: { type: "boolean", description: "The whole document even if long (only when you really need all of it)." },
        },
        required: ["kind"],
      },
    },
    handler: (i, ctx) => {
      req(i, "kind");
      const item = i.item_code ? itemOrThrow(ctx, i.item_code) : undefined;
      const doc = findDoc(ctx.project.id, i.kind, ITEM_DOC_KINDS.includes(i.kind) ? item?.id ?? null : null);
      if (!doc) return "";
      if (i.section) {
        const want = String(i.section).toLowerCase();
        const hit = sections(doc.content).filter((s) => s.heading.toLowerCase().includes(want));
        if (!hit.length) return `No section matching "${i.section}". Sections:\n${toc(doc.content)}`;
        return hit.map((s) => `${"#".repeat(Math.max(2, s.level))} ${s.heading}\n${s.body}`).join("\n\n");
      }
      if (doc.content.length > 6000 && !i.full) {
        return `${doc.title} (v${doc.version}, ${doc.content.length} chars) — read a section with \`section\`:\n${toc(doc.content)}`;
      }
      return doc.content;
    },
  },

  update_document_section: {
    label: "Update one section of a document",
    def: {
      name: "update_document_section",
      description:
        "Replace one section (## heading) of a project document, or append it when the heading doesn't exist yet. Use this to keep living documents (user_manual, technical_overview, changelog, solution_design) up to date without resending the whole document.",
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: DOC_KINDS },
          heading: { type: "string", description: "Section heading without the #, e.g. 'Case routing'" },
          content: { type: "string", description: "Markdown body of the section (without its heading line)." },
          item_code: { type: "string", description: "Only for task_doc / test_report." },
        },
        required: ["kind", "heading", "content"],
      },
    },
    handler: (i, ctx) => {
      req(i, "kind", "heading", "content");
      if (!DOC_KINDS.includes(i.kind)) throw new Error(`Unknown kind ${i.kind}`);
      const item = i.item_code ? itemOrThrow(ctx, i.item_code) : undefined;
      const itemId = ITEM_DOC_KINDS.includes(i.kind) ? (item?.id ?? null) : null;
      if (ITEM_DOC_KINDS.includes(i.kind) && !itemId) throw new Error(`${i.kind} requires item_code`);
      const existing = findDoc(ctx.project.id, i.kind, itemId);
      const heading = String(i.heading).replace(/^#+\s*/, "").trim();
      const body = String(i.content).trim();
      const content = replaceSection(existing?.content ?? `# ${i.kind.replace(/_/g, " ").replace(/^\w/, (c: string) => c.toUpperCase())}\n`, heading, body);
      const doc = upsertDoc({ projectId: ctx.project.id, kind: i.kind, itemId, title: existing?.title ?? i.kind.replace(/_/g, " "), content, agentId: ctx.agent.id });
      logActivity({ projectId: ctx.project.id, agentId: ctx.agent.id, runId: ctx.runId, itemId: item?.id ?? ctx.item?.id, type: "document", summary: `Updated "${heading}" in ${i.kind.replace(/_/g, " ")} (v${doc.version})` });
      return `Saved ${i.kind} v${doc.version} (section "${heading}").`;
    },
  },

  create_work_item: {
    label: "Create epic / feature / story / task",
    def: {
      name: "create_work_item",
      description:
        "Create a work item (epic, feature, story, task or bug) following the story template. Returns the new code. Create parents first and pass parent_code.",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["epic", "feature", "story", "task", "bug"] },
          title: { type: "string" },
          parent_code: { type: "string" },
          category: { type: "string", enum: CATEGORIES },
          state: { type: "string", enum: ["New", "Requires additional information", "Ready for Refinement"] },
          tags: { type: "array", items: { type: "string" } },
          ...ITEM_TEXT_FIELDS,
        },
        required: ["type", "title", "category"],
      },
    },
    handler: (i, ctx) => {
      req(i, "type", "title");
      const parent = i.parent_code ? itemOrThrow(ctx, i.parent_code) : undefined;
      const item = createItem(ctx.project.id, {
        type: i.type,
        title: i.title,
        parent_id: parent?.id ?? null,
        category: CATEGORIES.includes(i.category) ? i.category : "development",
        state: i.state && STATES.includes(i.state) ? i.state : "New",
        tags: Array.isArray(i.tags) ? i.tags : [],
        user_story: i.user_story ?? "",
        background: i.background ?? "",
        business_rules: i.business_rules ?? "",
        dependencies: i.dependencies ?? "",
        out_of_scope: i.out_of_scope ?? "",
        acceptance_criteria: i.acceptance_criteria ?? "",
        tech_spec: i.tech_spec ?? "",
        created_by: ctx.agent.id,
      });
      logActivity({
        projectId: ctx.project.id,
        agentId: ctx.agent.id,
        runId: ctx.runId,
        itemId: item.id,
        type: "item_created",
        summary: `Created ${item.type} ${item.code} — ${item.title}`,
      });
      return { code: item.code };
    },
  },

  update_work_item: {
    label: "Update work item fields / state",
    def: {
      name: "update_work_item",
      description: "Update fields of an existing work item. Only the fields you send are changed.",
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string" },
          title: { type: "string" },
          category: { type: "string", enum: CATEGORIES },
          state: { type: "string", enum: STATES },
          tags: { type: "array", items: { type: "string" } },
          ...ITEM_TEXT_FIELDS,
          how_to_test: { type: "string", description: "Markdown: unit test command + one manual check per AC with a **Verify:** line." },
          manual_steps: { type: "string", description: "Markdown: Pre-Deployment / Post-Deployment / Verification checklists." },
          solution_components: { type: "string", description: "Markdown bullet list of component API names grouped by metadata type." },
        },
        required: ["code"],
      },
    },
    handler: (i, ctx) => {
      req(i, "code");
      const it = itemOrThrow(ctx, i.code);
      const allowed = [
        "title", "category", "state", "tags", "user_story", "background", "business_rules", "dependencies",
        "out_of_scope", "acceptance_criteria", "tech_spec", "how_to_test", "manual_steps", "solution_components",
      ];
      const patch: Record<string, unknown> = {};
      for (const k of allowed) if (i[k] !== undefined) patch[k] = i[k];
      if (patch.state && !STATES.includes(String(patch.state))) delete patch.state;
      const held = openQuestionCount(it.id) > 0 && patch.state && !["New", "Requires additional information", "Cancelled"].includes(String(patch.state));
      if (held) patch.state = "Requires additional information";
      if (patch.category && !CATEGORIES.includes(String(patch.category))) delete patch.category;
      // Developers and testers may not move items through the workflow by hand: the orchestrator owns those transitions.
      if (["developer", "qa", "writer", "release"].includes(ctx.agent.role)) delete patch.state;
      patchItem(it.id, patch as Partial<WorkItem>);
      logActivity({
        projectId: ctx.project.id,
        agentId: ctx.agent.id,
        runId: ctx.runId,
        itemId: it.id,
        type: "item_updated",
        summary: `Updated ${it.code}: ${Object.keys(patch).join(", ") || "no changes"}`,
      });
      return held ? `Updated, but ${it.code} stays in "Requires additional information": it has unanswered questions for the product owner.` : "Updated.";
    },
  },

  get_item: {
    label: "Read a work item",
    def: {
      name: "get_item",
      description: "Get the full content of a work item by code.",
      input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    },
    handler: (i, ctx) => {
      req(i, "code");
      const it = itemOrThrow(ctx, i.code);
      const children = listItems(ctx.project.id).filter((c) => c.parent_id === it.id).map((c) => `${c.code} ${c.title}`);
      const tests = all("SELECT kind, ac_ref, result, notes, iteration FROM test_results WHERE item_id = ? ORDER BY id", it.id);
      const comments = all("SELECT author_id AS author, content, created_at FROM comments WHERE item_id = ? ORDER BY id", it.id);
      return { ...itemView(it), children, test_results: tests, comments };
    },
  },

  list_items: {
    label: "List work items",
    def: {
      name: "list_items",
      description: "List work items of the project (summary). Optional filters by type and state.",
      input_schema: {
        type: "object",
        properties: { type: { type: "string", enum: ["epic", "feature", "story", "task", "bug"] }, state: { type: "string" } },
      },
    },
    handler: (i, ctx) => {
      const items = listItems(ctx.project.id).filter(
        (it) => (!i.type || it.type === i.type) && (!i.state || it.state === i.state),
      );
      const codeOf = new Map(items.map((x) => [x.id, x.code]));
      const allItems = listItems(ctx.project.id);
      for (const x of allItems) codeOf.set(x.id, x.code);
      return items.map((it) => ({
        code: it.code,
        type: it.type,
        parent: it.parent_id ? codeOf.get(it.parent_id) : null,
        title: it.title,
        category: it.category,
        state: it.state,
        points: it.story_points,
        priority: it.priority,
        sprint: it.sprint,
        rank: it.rank,
        depends_on: it.depends_on,
      }));
    },
  },

  plan_item: {
    label: "Estimate & prioritise an item",
    def: {
      name: "plan_item",
      description: "Set estimation, prioritisation, dependencies and sprint for a story or task. Moves it to 'To Do'.",
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string" },
          story_points: { type: "integer", enum: [1, 2, 3, 5, 8, 13] },
          moscow: { type: "string", enum: ["Must", "Should", "Could", "Won't"] },
          wsjf: { type: "number" },
          priority: { type: "integer", minimum: 1, maximum: 4 },
          depends_on: { type: "array", items: { type: "string" } },
          sprint: { type: "integer", minimum: 1 },
          rank: { type: "integer", minimum: 1 },
        },
        required: ["code", "story_points", "moscow", "priority", "sprint", "rank"],
      },
    },
    handler: (i, ctx) => {
      req(i, "code", "story_points", "priority", "sprint", "rank");
      const it = itemOrThrow(ctx, i.code);
      if (openQuestionCount(it.id) > 0) throw new Error(`${it.code} has unanswered questions for the product owner — don't plan it until they're answered.`);
      const deps = (Array.isArray(i.depends_on) ? i.depends_on : []).filter((c: string) => getItemByCode(ctx.project.id, c));
      patchItem(it.id, {
        story_points: Number(i.story_points),
        moscow: i.moscow ?? null,
        wsjf: i.wsjf ?? null,
        priority: Number(i.priority),
        depends_on: deps,
        sprint: Number(i.sprint),
        rank: Number(i.rank),
        state: i.moscow === "Won't" ? "Cancelled" : "To Do",
      });
      logActivity({
        projectId: ctx.project.id,
        agentId: ctx.agent.id,
        runId: ctx.runId,
        itemId: it.id,
        type: "item_planned",
        summary: `Planned ${it.code}: ${i.story_points} pts · ${i.moscow} · sprint ${i.sprint} · rank ${i.rank}`,
      });
      return "Planned.";
    },
  },

  list_files: {
    label: "List workspace files",
    def: {
      name: "list_files",
      description: "List files in the project workspace (SFDX project). While you work on a task you see its own git branch: the base branch plus that task's changes. Optional path prefix filter.",
      input_schema: { type: "object", properties: { prefix: { type: "string" } } },
    },
    handler: (i, ctx) => {
      // On a task, the agent sees its own branch (base branch + the task's changes).
      const files = listWorkspaceFiles(ctx.project, ctx.item?.code);
      return files.filter((f) => !i.prefix || f.startsWith(i.prefix));
    },
  },

  read_file: {
    label: "Read a workspace file",
    def: {
      name: "read_file",
      description: "Read a file from the project workspace (your task's branch). For long files, read only the lines you need with start_line/end_line.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } },
        required: ["path"],
      },
    },
    handler: (i, ctx) => {
      req(i, "path");
      const c = readWorkspaceFile(ctx.project, i.path, ctx.item?.code);
      if (c === null) throw new Error(`File not found: ${i.path}`);
      if (i.start_line || i.end_line) {
        const lines = c.split("\n");
        const a = Math.max(1, Number(i.start_line) || 1);
        const b = Math.min(lines.length, Number(i.end_line) || lines.length);
        return `${i.path} lines ${a}-${b} of ${lines.length}:\n${lines.slice(a - 1, b).join("\n")}`;
      }
      return c.length > 40_000 ? `${c.slice(0, 40_000)}\n…[truncated at 40,000 chars of ${c.length} — read the rest with start_line/end_line]` : c;
    },
  },

  write_file: {
    label: "Write a source file",
    def: {
      name: "write_file",
      description:
        "Create or overwrite a file in the project workspace (SFDX layout, e.g. force-app/main/default/classes/CaseService.cls). Always send the complete file.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    handler: (i, ctx) => {
      req(i, "path", "content");
      const rel = recordFile(ctx.project.id, i.path, i.content, ctx.agent.id, ctx.item?.id ?? null);
      logActivity({
        projectId: ctx.project.id,
        agentId: ctx.agent.id,
        runId: ctx.runId,
        itemId: ctx.item?.id,
        type: "file",
        summary: `Wrote ${rel} (${i.content.split("\n").length} lines)`,
      });
      return `Wrote ${rel}`;
    },
  },

  complete_development: {
    label: "Hand the story to QA",
    def: {
      name: "complete_development",
      description: "Declare the assigned story implemented and hand it over to QA. Call once, at the end.",
      input_schema: {
        type: "object",
        properties: { code: { type: "string" }, summary: { type: "string", description: "What was built; for rework, how each finding was fixed." } },
        required: ["code", "summary"],
      },
    },
    handler: (i, ctx) => {
      req(i, "summary");
      // Live with a target org: the story must have validated in the org in this run before it goes to QA.
      if (sfAccess(ctx.project, ctx.environment).live && ctx.agent.tools.includes("deploy_story") && !ctx.outcome.orgDeploy?.ok) {
        throw new Error("Validate the story in the org first: call deploy_story and fix every error until it succeeds, then call complete_development.");
      }
      ctx.outcome.devCompleted = String(i.summary);
      return "Development marked complete. QA will be notified by the orchestrator.";
    },
  },

  record_test_result: {
    label: "Record ✅/❌/⛔ test result",
    def: {
      name: "record_test_result",
      description: "Record the result of one check against an acceptance criterion.",
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string" },
          ac_ref: { type: "string", description: "e.g. 'AC 1' or 'AC 2 — negative'" },
          result: { type: "string", enum: ["pass", "fail", "blocked"] },
          notes: { type: "string", description: "Evidence: file and what was found / what is wrong." },
        },
        required: ["code", "ac_ref", "result", "notes"],
      },
    },
    handler: (i, ctx) => {
      req(i, "code", "ac_ref", "result");
      const it = itemOrThrow(ctx, i.code);
      const result = ["pass", "fail", "blocked"].includes(i.result) ? i.result : "blocked";
      addTestResult({
        projectId: ctx.project.id,
        itemId: it.id,
        kind: ctx.agent.role === "release" ? "smoke" : "qa",
        acRef: String(i.ac_ref),
        result,
        notes: String(i.notes ?? ""),
        iteration: ctx.iteration,
        agentId: ctx.agent.id,
      });
      const icon = result === "pass" ? "✅" : result === "fail" ? "❌" : "⛔";
      logActivity({
        projectId: ctx.project.id,
        agentId: ctx.agent.id,
        runId: ctx.runId,
        itemId: it.id,
        type: "test",
        summary: `${icon} ${it.code} ${i.ac_ref} — ${String(i.notes ?? "").slice(0, 140)}`,
      });
      return "Recorded.";
    },
  },

  capture_evidence: {
    label: "Capture a test screenshot",
    def: {
      name: "capture_evidence",
      description:
        "Capture a screenshot of the check you just performed (the record page with the verified fields; failures are marked with a red box). Returns a Markdown image line to paste into the test report.",
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string" },
          ac_ref: { type: "string", description: "The check, e.g. 'AC 2 — negative path'" },
          result: { type: "string", enum: ["pass", "fail", "blocked"] },
          notes: { type: "string", description: "What the screenshot shows / what is wrong." },
        },
        required: ["code", "ac_ref", "result", "notes"],
      },
    },
    handler: (i, ctx) => {
      req(i, "code", "ac_ref", "result");
      const it = itemOrThrow(ctx, i.code);
      const result = ["pass", "fail", "blocked"].includes(i.result) ? i.result : "blocked";
      const slug = String(i.ac_ref).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "check";
      const file = `evidence/${slug}-i${ctx.iteration}.svg`;
      const svg = renderEvidenceSvg({
        item: it,
        object: detectObject(`${it.title} ${it.tech_spec}`, "Account"),
        acRef: String(i.ac_ref),
        result,
        notes: String(i.notes ?? ""),
        iteration: ctx.iteration,
        simulated: ctx.project.mode === "simulation",
      });
      recordFile(ctx.project.id, `docs/stories/${it.code}/${file}`, svg, ctx.agent.id, it.id);
      const icon = result === "pass" ? "✅" : result === "fail" ? "❌" : "⛔";
      logActivity({ projectId: ctx.project.id, agentId: ctx.agent.id, runId: ctx.runId, itemId: it.id, type: "test", summary: `📸 ${icon} Evidence for ${it.code} ${i.ac_ref}` });
      return { image: file, markdown: `![${icon} ${String(i.ac_ref).replace(/[[\]]/g, "")}](${file})` };
    },
  },

  capture_screenshot: {
    label: "Take a real screenshot of the org",
    def: {
      name: "capture_screenshot",
      description:
        "Take a real screenshot of a page in the project's Salesforce org (headless Chrome, logged in through the Salesforce CLI) as evidence for one acceptance criterion. `path` is a page inside the org, e.g. /lightning/r/Case/<Id>/view or /lightning/o/Case/list. Returns a Markdown image line to paste into the test report. Live mode with an org only; otherwise use capture_evidence.",
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Story code; defaults to the story under test." },
          ac_ref: { type: "string", description: "The check, e.g. 'AC 2 — negative path'" },
          caption: { type: "string", description: "What the screenshot shows (used as the image's alt text)." },
          path: { type: "string", description: "Page inside the org, starting with /lightning/ or /. No external URLs." },
          wait_for_text: { type: "string", description: "Optional text to wait for before taking the screenshot (e.g. the record name)." },
        },
        required: ["ac_ref", "caption", "path"],
      },
    },
    handler: async (i, ctx) => {
      req(i, "ac_ref", "caption", "path");
      const it = i.code ? itemOrThrow(ctx, String(i.code)) : ctx.item;
      if (!it) throw new Error("Missing required field(s): code");
      const target = orgPath(String(i.path)); // refuse external URLs even in simulation
      const access = sfAccess(ctx.project, ctx.environment);
      if (!access.live) return `Simulation — use capture_evidence. (${access.reason})`;
      const slug = String(i.ac_ref).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "check";
      const dir = `docs/stories/${it.code}/evidence`;
      let n = 1;
      while (fs.existsSync(safeWorkspacePath(ctx.project, `${dir}/${slug}-${n}.png`, it.code).abs)) n++;
      let shot;
      try {
        shot = await captureOrgScreenshot({ alias: access.org.alias, path: target, waitForText: i.wait_for_text ? String(i.wait_for_text) : undefined });
      } catch (e) {
        if (e instanceof ScreenshotUnavailable) return e.message;
        throw e;
      }
      const file = `evidence/${slug}-${n}.png`;
      writeWorkspaceBinary(ctx.project, `${dir}/${slug}-${n}.png`, shot.png, it.code, ctx.agent.id);
      const caption = String(i.caption).replace(/[[\]\n]/g, " ").trim();
      logActivity({ projectId: ctx.project.id, agentId: ctx.agent.id, runId: ctx.runId, itemId: it.id, type: "test", summary: `📸 Screenshot for ${it.code} ${i.ac_ref} from ${access.org.alias} (${target.split("?")[0]})` });
      return {
        image: file,
        markdown: `![${String(i.ac_ref).replace(/[[\]]/g, "")} — ${caption}](${file})`,
        ...(shot.textFound === false ? { warning: `"${i.wait_for_text}" did not appear on the page within 45 s — check the screenshot before using it as a pass.` } : {}),
      };
    },
  },

  submit_review: {
    label: "Approve or request changes",
    def: {
      name: "submit_review",
      description: "Submit the QA verdict for the story under test.",
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string" },
          verdict: { type: "string", enum: ["approved", "changes_requested"] },
          findings: { type: "string", description: "Markdown. One bullet per failure: AC, what is wrong, where, expected. Notes if approved." },
        },
        required: ["code", "verdict", "findings"],
      },
    },
    handler: (i, ctx) => {
      req(i, "verdict");
      if (i.verdict === "approved" && sfAccess(ctx.project, ctx.environment).live && ctx.agent.tools.includes("run_apex_tests") && !ctx.outcome.apexTests?.ok) {
        throw new Error(ctx.outcome.apexTests ? "The story's Apex tests failed in the org — you can't approve it. Request changes with the failures." : "Run the story's Apex tests in the org with run_apex_tests before approving.");
      }
      ctx.outcome.review = {
        verdict: i.verdict === "approved" ? "approved" : "changes_requested",
        findings: String(i.findings ?? ""),
      };
      return "Verdict recorded.";
    },
  },

  submit_code_review: {
    label: "Submit a code review",
    def: {
      name: "submit_code_review",
      description: "Submit your code review verdict for the story's diff (after QA approved it).",
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string" },
          verdict: { type: "string", enum: ["approved", "changes_requested"] },
          findings: { type: "string", description: "Markdown. One bullet per finding: file, what is wrong, what is expected. Short notes if approved." },
        },
        required: ["code", "verdict", "findings"],
      },
    },
    handler: (i, ctx) => {
      req(i, "verdict");
      ctx.outcome.codeReview = {
        verdict: i.verdict === "approved" ? "approved" : "changes_requested",
        findings: String(i.findings ?? ""),
      };
      return "Code review recorded.";
    },
  },

  ask_human: {
    label: "Ask the product owner",
    def: {
      name: "ask_human",
      description: "Record an open question for the human product owner. Does not block; answers are shared with later agents.",
      input_schema: {
        type: "object",
        properties: { question: { type: "string" }, item_code: { type: "string" } },
        required: ["question"],
      },
    },
    handler: (i, ctx) => {
      req(i, "question");
      const it = i.item_code ? getItemByCode(ctx.project.id, i.item_code) : undefined;
      addQuestion(ctx.project.id, i.question, it?.id ?? null, ctx.agent.id);
      postMessage({ projectId: ctx.project.id, from: ctx.agent.id, to: "human", itemId: it?.id, kind: "question", content: i.question });
      return "Question recorded for the product owner.";
    },
  },

  post_message: {
    label: "Message another agent",
    def: {
      name: "post_message",
      description:
        "Send a message to another agent of the team (by role: requirements, architect, planner, developer, qa, writer, release — or by name), or to 'human'.",
      input_schema: {
        type: "object",
        properties: {
          to: { type: "string" },
          content: { type: "string" },
          item_code: { type: "string" },
          kind: { type: "string", enum: ["handoff", "info", "question"] },
        },
        required: ["to", "content"],
      },
    },
    handler: (i, ctx) => {
      req(i, "to", "content");
      const target = i.to === "human" ? undefined : resolveAgentRef(ctx, i.to);
      if (i.to !== "human" && !target) return `No agent '${i.to}' in this project team — message not delivered.`;
      const it = i.item_code ? getItemByCode(ctx.project.id, i.item_code) : undefined;
      postMessage({
        projectId: ctx.project.id,
        from: ctx.agent.id,
        to: target?.id ?? "human",
        itemId: it?.id,
        kind: i.kind ?? "info",
        content: i.content,
      });
      return "Delivered.";
    },
  },

  consult_agent: {
    label: "Consult another agent (synchronous)",
    def: {
      name: "consult_agent",
      description:
        "Ask another agent of the team a question and wait for the answer (by role or name). Use for clarifications instead of guessing.",
      input_schema: {
        type: "object",
        properties: { agent: { type: "string" }, question: { type: "string" }, item_code: { type: "string" } },
        required: ["agent", "question"],
      },
    },
    handler: async (i, ctx) => {
      req(i, "agent", "question");
      const target = resolveAgentRef(ctx, i.agent);
      if (!target) return `No agent '${i.agent}' in this project team.`;
      if (!ctx.consult) return "Consultation is not available right now.";
      const it = i.item_code ? getItemByCode(ctx.project.id, i.item_code) : undefined;
      postMessage({ projectId: ctx.project.id, from: ctx.agent.id, to: target.id, itemId: it?.id ?? ctx.item?.id, kind: "question", content: i.question });
      const answer = await ctx.consult(target, i.question, ctx);
      postMessage({ projectId: ctx.project.id, from: target.id, to: ctx.agent.id, itemId: it?.id ?? ctx.item?.id, kind: "answer", content: answer });
      return answer;
    },
  },

  describe_object: {
    label: "Describe a Salesforce object (org)",
    def: {
      name: "describe_object",
      description:
        "Describe an object in the project's target Salesforce org: fields (API name, label, type, length, references, required, picklist values) and record types. Use it to build on the org's real data model instead of assuming it.",
      input_schema: { type: "object", properties: { object: { type: "string", description: "API name, e.g. Case or Work_Order__c" } }, required: ["object"] },
    },
    handler: async (i, ctx) => {
      req(i, "object");
      const access = sfAccess(ctx.project, ctx.environment);
      if (!access.live) return `${access.reason} Use standard Salesforce knowledge of ${i.object} and state your assumptions.`;
      const d = await describeObject(access.org.alias, String(i.object));
      logActivity({ projectId: ctx.project.id, agentId: ctx.agent.id, runId: ctx.runId, itemId: ctx.item?.id, type: "note", summary: `Described ${d.name} in ${access.org.alias} (${d.fields.length} fields)` });
      return d;
    },
  },

  run_soql: {
    label: "Query the org (read-only SOQL)",
    def: {
      name: "run_soql",
      description: "Run one read-only SOQL SELECT against the project's target org (max 200 rows returned). For checking data, configuration and smoke tests. No DML.",
      input_schema: { type: "object", properties: { soql: { type: "string" } }, required: ["soql"] },
    },
    handler: async (i, ctx) => {
      req(i, "soql");
      const access = sfAccess(ctx.project, ctx.environment);
      if (!access.live) return `${access.reason} The query was not run.`;
      const r = await query(access.org.alias, String(i.soql));
      logActivity({ projectId: ctx.project.id, agentId: ctx.agent.id, runId: ctx.runId, itemId: ctx.item?.id, type: "note", summary: `SOQL on ${access.org.alias}: ${r.totalSize} row(s)`, detail: String(i.soql) });
      return r;
    },
  },

  deploy_story: {
    label: "Deploy/validate the story in the org",
    def: {
      name: "deploy_story",
      description:
        "Deploy the Salesforce metadata this story changed on its branch to the project's target org and run the story's Apex test classes. Check-only (validation) unless the developer is configured to deploy to a non-production org. Returns component errors with file and line, test failures and coverage: fix them and call again until it succeeds.",
      input_schema: { type: "object", properties: {} },
    },
    handler: async (_i, ctx) => deployItem(ctx, "development"),
  },

  run_apex_tests: {
    label: "Run the story's Apex tests (org)",
    def: {
      name: "run_apex_tests",
      description:
        "Run the story's Apex test classes in the project's target org (check-only deploy of the story's branch with those tests — nothing is saved in the org). Returns test failures and per-class coverage. Record results with record_test_result.",
      input_schema: { type: "object", properties: {} },
    },
    handler: async (_i, ctx) => deployItem(ctx, "qa"),
  },

  run_anonymous_apex: {
    label: "Run anonymous Apex (smoke test)",
    def: {
      name: "run_anonymous_apex",
      description:
        "Run a short anonymous Apex script in the target org for a smoke test after a real deployment (e.g. call a service and System.assert the outcome). Returns success, compile problems, exceptions and USER_DEBUG lines. Not allowed on production orgs.",
      input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    },
    handler: async (i, ctx) => {
      req(i, "code");
      const access = sfAccess(ctx.project, ctx.environment);
      if (!access.live) return `${access.reason} The script was not run.`;
      if (access.org.type === "production") throw new Error("Anonymous Apex is not run on production orgs — use run_soql to smoke-test instead.");
      const r = await runAnonymousApex(access.org.alias, String(i.code));
      logActivity({ projectId: ctx.project.id, agentId: ctx.agent.id, runId: ctx.runId, type: "validation", summary: `${r.ok ? "✅" : "❌"} Anonymous Apex on ${access.org.alias}${r.problem ? `: ${r.problem}` : ""}`, detail: String(i.code) });
      return r;
    },
  },

  build_manifest: {
    label: "Generate package.xml",
    def: {
      name: "build_manifest",
      description: "Generate manifest/package.xml from every metadata file under force-app/. Returns the manifest.",
      input_schema: { type: "object", properties: {} },
    },
    handler: (_i, ctx) => {
      const xml = buildPackageXml(listWorkspaceFiles(ctx.project), projectSalesforce(ctx.project).apiVersion);
      recordFile(ctx.project.id, "manifest/package.xml", xml, ctx.agent.id, null);
      logActivity({ projectId: ctx.project.id, agentId: ctx.agent.id, runId: ctx.runId, type: "file", summary: "Built manifest/package.xml" });
      return xml;
    },
  },

  validate_deployment: {
    label: "Validate deployment (check-only)",
    def: {
      name: "validate_deployment",
      description:
        "Validate (and, if the release agent is configured to, deploy) the release against the project's target Salesforce org — the project's override or the release agent's default; with environments, the environment this release step works on, with its deploy mode and test level. Production orgs must be allowed in the registry. Without a target org, runs static validation only.",
      input_schema: { type: "object", properties: {} },
    },
    handler: async (_i, ctx) => {
      const result = await validateWorkspace(ctx.project, ctx.agent, ctx.environment);
      ctx.outcome.validation = result;
      logActivity({
        projectId: ctx.project.id,
        agentId: ctx.agent.id,
        runId: ctx.runId,
        type: "validation",
        summary: `${result.ok ? "✅ Validation passed" : "❌ Validation failed"} (${result.mode})`,
        detail: result.output,
      });
      return result;
    },
  },

  publish_release: {
    label: "Publish the release",
    def: {
      name: "publish_release",
      description: "Publish the release with complete release notes. The released items (those in 'Smoke Testing') move to 'Deployed (Done)'.",
      input_schema: {
        type: "object",
        properties: { version: { type: "string" }, notes: { type: "string", description: "Complete Markdown release notes." } },
        required: ["version", "notes"],
      },
    },
    handler: async (i, ctx) => {
      req(i, "version", "notes");
      // With environments, notes and tag are published once — after the last environment.
      if (ctx.environment && !ctx.environment.final) {
        throw new Error(`Don't publish yet: ${ctx.environment.name} is environment ${ctx.environment.index + 1} of ${ctx.environment.total}. The release is published after the last environment.`);
      }
      const id = uid("rel");
      insert("releases", {
        id,
        project_id: ctx.project.id,
        version: i.version,
        notes: i.notes,
        status: "published",
        validation: ctx.outcome.validation ? JSON.stringify(ctx.outcome.validation) : null,
        created_at: now(),
      });
      upsertDoc({ projectId: ctx.project.id, kind: "release_notes", itemId: null, title: `Release ${i.version}`, content: i.notes, agentId: ctx.agent.id });
      ctx.outcome.released = { version: i.version };
      emit({ type: "project", projectId: ctx.project.id });
      try {
        // Commit what's pending (manifest, notes) and tag the release in the project repository.
        await commitWork(ctx.project, { author: `${ctx.agent.name} (${ctx.agent.title})`, email: agentEmail(ctx.agent.name), message: `release: ${i.version}` });
        const tag = await tagRelease(ctx.project, i.version, String(i.notes).split("\n")[0]);
        return `Release ${i.version} published and tagged ${tag}.`;
      } catch {
        return `Release ${i.version} published (git tag failed).`;
      }
    },
  },
};

/** deploy_story / run_apex_tests: deploy the task branch's metadata (check-only unless allowed) with its test classes. */
async function deployItem(ctx: ToolContext, purpose: "development" | "qa") {
  const it = ctx.item;
  if (!it) throw new Error("No story is assigned to this run.");
  const changed = (await changedOnBranch(ctx.project, it.code)).filter((f) => f.startsWith("force-app/"));
  const testClasses = changed.filter((f) => /\/classes\/[^/]+(Test|_Test)\.cls$/.test(f)).map((f) => f.split("/").pop()!.replace(".cls", ""));
  const apex = changed.filter((f) => /\/(classes|triggers)\/[^/]+\.(cls|trigger)$/.test(f) && !/(Test|_Test)\.cls$/.test(f));
  const access = sfAccess(ctx.project, ctx.environment);
  if (!access.live) {
    const checks = staticChecks(ctx.project, listWorkspaceFiles(ctx.project, it.code), it.code, false);
    const text = [
      `${access.reason}`,
      `Would ${purpose === "qa" ? "run" : "validate"} ${changed.length} file(s) from ${it.branch ?? "the workspace"}${testClasses.length ? ` with tests ${testClasses.join(", ")}` : ""}.`,
      checks.problems.length ? `Static checks:\n${checks.problems.map((p) => `- ${p}`).join("\n")}` : "Static checks passed.",
    ].join("\n");
    return text;
  }
  if (apex.length && !testClasses.length) throw new Error(`The story changes Apex (${apex.map((f) => f.split("/").pop()).join(", ")}) but has no test class on its branch. Write one first.`);
  // Bundles deploy as a folder; Apex/trigger sources travel with their -meta.xml.
  const paths = new Set<string>();
  for (const f of changed) {
    const bundle = f.match(/^(force-app\/main\/default\/(?:lwc|aura)\/[^/]+)\//);
    if (bundle) paths.add(bundle[1]);
    else if (/\.(cls|trigger)-meta\.xml$/.test(f)) paths.add(f.replace(/-meta\.xml$/, ""));
    else paths.add(f);
  }
  for (const p of [...paths]) if (/\.(cls|trigger)$/.test(p)) paths.add(`${p}-meta.xml`);
  const isProd = access.org.type === "production";
  // With environments the build environment says whether stories are deployed there or only validated.
  const build = buildEnvironment(ctx.project.settings);
  const checkOnly = purpose === "qa" || isProd || (build ? build.deployMode !== "deploy" : ctx.agent.config?.deployMode !== "deploy");
  const where = `${access.org.alias} (${access.org.type})`;
  const sfs = projectSalesforce(ctx.project);
  const report = await deploySource({ alias: access.org.alias, cwd: rootFor(ctx.project, it.code), paths: [...paths], checkOnly, tests: testClasses, testLevel: sfs.devTestLevel });
  // The team's coverage rule: every Apex class the story changed must reach the minimum.
  const changedClasses = apex.map((f) => f.split("/").pop()!.replace(/\.(cls|trigger)$/, ""));
  const low = report.coverage.filter((c) => changedClasses.includes(c.name) && c.percent < sfs.coverageMin);
  if (report.ok && low.length) {
    report.ok = false;
    report.message = `Coverage below the team minimum of ${sfs.coverageMin}%: ${low.map((c) => `${c.name} ${c.percent}%`).join(", ")}. Add tests.`;
  }
  if (purpose === "qa") ctx.outcome.apexTests = { ok: report.ok && report.tests.run > 0 };
  else ctx.outcome.orgDeploy = { ok: report.ok };
  const text = formatDeploy(report, where);
  logActivity({
    projectId: ctx.project.id,
    agentId: ctx.agent.id,
    runId: ctx.runId,
    itemId: it.id,
    type: "validation",
    summary: `${report.ok ? "✅" : "❌"} ${it.code}: ${purpose === "qa" ? `${report.tests.run} Apex test(s) in` : checkOnly ? "validated in" : "deployed to"} ${access.org.alias}${report.ok ? "" : ` — ${report.componentErrors.length} component error(s), ${report.tests.failures.length} test failure(s)`}`,
    detail: text,
  });
  return text;
}

/** JSON replacer: leave out null / empty values (they cost tokens and say nothing). */
function dropEmpty(_k: string, v: unknown) {
  if (v === null || v === undefined || v === "") return undefined;
  if (Array.isArray(v) && v.length === 0) return undefined;
  return v;
}

/** Replace the body of `## heading` (keeping deeper sub-headings out of it), or append the section at the end. */
export function replaceSection(md: string, heading: string, body: string) {
  const lines = md.replace(/\s+$/, "").split("\n");
  const norm = (s: string) => s.trim().toLowerCase();
  const start = lines.findIndex((l) => /^##\s+/.test(l) && norm(l.replace(/^##\s+/, "").replace(/\s*#*$/, "")) === norm(heading));
  // An existing section keeps its own heading text; a new one gets the given heading.
  const block = [start >= 0 ? lines[start] : `## ${heading}`, "", body, ""];
  if (start < 0) return `${lines.join("\n")}\n\n${block.join("\n")}`.replace(/\n{3,}/g, "\n\n");
  let end = lines.findIndex((l, idx) => idx > start && /^#{1,2}\s+/.test(l));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function toolCatalog() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, label: t.label, description: t.def.description }));
}

export function toolDefs(names: string[], streaming: boolean): Anthropic.Tool[] {
  return names
    .filter((n) => TOOLS[n])
    .map((n) => (streaming ? { ...TOOLS[n].def, eager_input_streaming: true } : TOOLS[n].def));
}

export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<{ ok: boolean; content: string }> {
  const spec = TOOLS[name];
  if (!spec || !ctx.agent.tools.includes(name)) return { ok: false, content: `Tool ${name} is not available to this agent.` };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, content: "Tool input must be a JSON object." };
  try {
    const out = await spec.handler(input as Record<string, any>, ctx);
    // Compact JSON: indentation is pure token overhead for the model. An empty result is dropped whole, so fall back to plain JSON ("[]").
    return { ok: true, content: typeof out === "string" ? out : (JSON.stringify(out, dropEmpty) ?? JSON.stringify(out) ?? "") };
  } catch (e) {
    return { ok: false, content: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- Manifest & validation helpers ----------

const TYPE_BY_DIR: Record<string, string> = {
  classes: "ApexClass",
  triggers: "ApexTrigger",
  flows: "Flow",
  lwc: "LightningComponentBundle",
  aura: "AuraDefinitionBundle",
  permissionsets: "PermissionSet",
  permissionsetgroups: "PermissionSetGroup",
  layouts: "Layout",
  flexipages: "FlexiPage",
  customMetadata: "CustomMetadata",
  labels: "CustomLabels",
  staticresources: "StaticResource",
  tabs: "CustomTab",
  applications: "CustomApplication",
  reports: "Report",
  dashboards: "Dashboard",
  quickActions: "QuickAction",
  queues: "Queue",
  globalValueSets: "GlobalValueSet",
  namedCredentials: "NamedCredential",
  externalCredentials: "ExternalCredential",
  remoteSiteSettings: "RemoteSiteSetting",
  email: "EmailTemplate",
  customPermissions: "CustomPermission",
};

export function buildPackageXml(files: string[], apiVersion = "62.0") {
  const members = new Map<string, Set<string>>();
  const add = (type: string, name: string) => {
    if (!members.has(type)) members.set(type, new Set());
    members.get(type)!.add(name);
  };
  for (const f of files) {
    const m = f.match(/^force-app\/main\/default\/([^/]+)\/(.+)$/);
    if (!m) continue;
    const [, dir, rest] = m;
    if (dir === "objects") {
      const parts = rest.split("/");
      const obj = parts[0];
      if (parts[1] === "fields") add("CustomField", `${obj}.${parts[2].replace(/\.field-meta\.xml$/, "")}`);
      else if (parts[1] === "validationRules") add("ValidationRule", `${obj}.${parts[2].replace(/\.validationRule-meta\.xml$/, "")}`);
      else if (parts[1] === "recordTypes") add("RecordType", `${obj}.${parts[2].replace(/\.recordType-meta\.xml$/, "")}`);
      else if (parts[1] === "listViews") add("ListView", `${obj}.${parts[2].replace(/\.listView-meta\.xml$/, "")}`);
      else if (parts[1]?.endsWith(".object-meta.xml")) add("CustomObject", obj);
      continue;
    }
    const type = TYPE_BY_DIR[dir];
    if (!type) continue;
    if (type === "LightningComponentBundle" || type === "AuraDefinitionBundle") {
      add(type, rest.split("/")[0]);
      continue;
    }
    if (rest.endsWith("-meta.xml") && (type === "ApexClass" || type === "ApexTrigger")) continue;
    if (type === "Report" || type === "Dashboard" || type === "EmailTemplate") {
      if (!rest.includes("/")) continue; // folder metadata
      add(type, rest.replace(/\.[^/.]+-meta\.xml$/, ""));
      continue;
    }
    add(type, rest.replace(/\.[^/]+-meta\.xml$/, "").replace(/\.(cls|trigger)$/, "").replace(/\/.*$/, ""));
  }
  const types = [...members.keys()].sort();
  const body = types
    .map(
      (t) =>
        `    <types>\n${[...members.get(t)!].sort().map((m) => `        <members>${m}</members>`).join("\n")}\n        <name>${t}</name>\n    </types>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}\n    <version>${apiVersion}</version>\n</Package>\n`;
}

function staticChecks(project: Project, files: string[], itemCode?: string | null, needManifest = true) {
  const problems: string[] = [];
  const root = rootFor(project, itemCode);
  for (const f of files) {
    if (/\.(cls|trigger)$/.test(f) && !files.includes(`${f}-meta.xml`)) problems.push(`Missing ${f}-meta.xml`);
    if (f.endsWith(".xml")) {
      const c = fs.readFileSync(path.join(root, f), "utf8");
      if (!c.trimStart().startsWith("<?xml") && !c.trimStart().startsWith("<")) problems.push(`Not XML: ${f}`);
      const open = (c.match(/<[A-Za-z][^>]*?(?<!\/)>/g) ?? []).length;
      const close = (c.match(/<\/[A-Za-z][^>]*>/g) ?? []).length;
      if (Math.abs(open - close) > 0 && !f.endsWith("package.xml")) problems.push(`Unbalanced tags in ${f} (${open} open / ${close} close)`);
    }
  }
  const classes = files.filter((f) => /classes\/[^/]+\.cls$/.test(f)).map((f) => f.split("/").pop()!.replace(".cls", ""));
  for (const c of classes) {
    if (/Test$/.test(c)) continue;
    if (!classes.includes(`${c}Test`) && !classes.includes(`${c}_Test`)) problems.push(`No test class for ${c}`);
  }
  if (needManifest && !files.includes("manifest/package.xml")) problems.push("manifest/package.xml not built");
  return { ok: problems.filter((p) => !p.startsWith("No test class")).length === 0, problems, classes };
}

export async function validateWorkspace(project: Project, agent?: Agent, env?: ReleaseEnvironment): Promise<{ ok: boolean; mode: string; output: string; org: TargetOrg | null }> {
  const files = listWorkspaceFiles(project);
  const checks = staticChecks(project, files);
  const staticText = checks.problems.length ? checks.problems.map((p) => `- ${p}`).join("\n") : `All ${files.length} files passed static validation.`;
  // With environments the step's environment decides the org, mode and test level; the production step before the
  // approval is always check-only.
  const org = env ? (env.org ? describeTarget(env.org, "environment", env.name) : null) : await resolveTargetOrg(project, agent?.role === "release" ? agent : undefined);
  const deployMode = env ? (env.phase === "validate" ? "validate" : env.deployMode) : (agent?.config?.deployMode ?? "validate");
  const testLevel = env ? env.testLevel : (agent?.config?.testLevel ?? "RunLocalTests");
  const envText = env ? ` (${env.name} environment, ${env.index + 1} of ${env.total})` : "";

  if (!org) return { ok: checks.ok, mode: env ? `static (${env.name}: no org mapped)` : "static (no target org)", output: staticText, org: null };
  if (!org.selectable) {
    return {
      ok: false,
      mode: `refused → ${org.alias}`,
      output: `Refused: ${org.alias} is ${org.type === "unknown" ? "not a registered org" : "a production org that isn't allowed as a target"}. Allow it in Settings → Salesforce orgs if it's meant to be one (e.g. a Trailhead Playground).`,
      org,
    };
  }
  const where = `${org.alias} (${org.type}${org.instanceUrl ? `, ${org.instanceUrl}` : ""})${envText}`;

  // Simulation never touches Salesforce: the deployment is simulated against the chosen org.
  if (project.mode === "simulation" || effectiveMode() === "simulation") {
    const components = (buildPackageXml(files).match(/<members>/g) ?? []).length;
    const tests = testLevel === "NoTestRun" ? 0 : checks.classes.filter((c) => /Test$/.test(c)).length * 3;
    return {
      ok: checks.ok,
      mode: `simulated ${deployMode === "deploy" ? "deploy" : "check-only"} → ${org.alias}${env ? ` (${env.name})` : ""}`,
      output: [
        `Simulated ${deployMode === "deploy" ? "deployment" : "check-only validation"} to ${where} — nothing was sent to Salesforce.`,
        `Components: ${components} · Test level: ${testLevel} · Tests run: ${tests} (simulated) · Result: ${checks.ok ? "Succeeded" : "Failed"}`,
        staticText,
      ].join("\n"),
      org,
    };
  }

  try {
    const dir = workspaceDir(project);
    if (!fs.existsSync(path.join(dir, "sfdx-project.json"))) {
      fs.writeFileSync(path.join(dir, "sfdx-project.json"), sfdxProjectJson(project));
    }
    const validatedKey = env ? `envValidation:${project.id}:${env.key}` : null;
    // The deploy after a production approval ships the release validated before it (quick deploy) when possible.
    const validated = validatedKey && env?.phase === "deploy" ? getSetting<{ jobId: string } | null>(validatedKey, null) : null;
    if (validated && deployMode === "deploy") {
      setSetting(validatedKey!, null);
      const quick = parseDeploy(await sf(["project", "deploy", "quick", "--job-id", validated.jobId, "--target-org", org.alias, "--wait", "30"], dir), false);
      if (quick.ok) return { ok: true, mode: `sf quick deploy (validated release) → ${org.alias}`, output: formatDeploy(quick, where), org };
    }
    // Production (e.g. a Trailhead Playground) requires tests on deploy; NoTestRun is only valid on non-production orgs.
    const level = org.type === "production" && testLevel === "NoTestRun" ? "RunLocalTests" : testLevel;
    const base = ["--manifest", "manifest/package.xml", "--test-level", level, "--target-org", org.alias, "--wait", "30"];
    const raw = await sf(["project", "deploy", "validate", ...base], dir);
    const validation = parseDeploy(raw, true);
    let ok = validation.ok;
    let output = formatDeploy(validation, where);
    const jobId = raw.result?.id ? String(raw.result.id) : null;
    if (ok && env?.phase === "validate" && validatedKey && jobId) setSetting(validatedKey, { jobId, at: new Date().toISOString() });
    if (ok && deployMode === "deploy") {
      const deploy = parseDeploy(await sf(["project", "deploy", "start", ...base], dir), false);
      ok = deploy.ok;
      output += `\n\n${formatDeploy(deploy, where)}`;
    }
    return { ok, mode: `sf ${deployMode === "deploy" ? "validate + deploy" : "validate"} → ${org.alias}${env ? ` (${env.name})` : ""}`, output, org };
  } catch (e) {
    return { ok: false, mode: `sf → ${org.alias}`, output: `sf CLI failed: ${e instanceof Error ? e.message : e}`, org };
  }
}
