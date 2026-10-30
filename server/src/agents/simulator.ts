/**
 * Simulation mode: agents "work" without calling the Claude API. Every action goes through the same tool handlers as
 * live mode, so the backlog, files, documents, graph, timings and (synthetic) costs behave exactly like a real run.
 */
import fs from "node:fs";
import { all, get } from "../db.js";
import { appSettings } from "../settings.js";
import { priceFor } from "../pricing.js";
import { THINKING_PER_CALL } from "../estimate.js";
import { findDoc, getItem, getProject, listItems, logActivity, type Project, type WorkItem } from "../store.js";
import type { Agent } from "./store.js";
import { executeTool, type ToolContext } from "./tools.js";
import type { RunOptions } from "./runner.js";
import { buildSystemPrompt, checkBudget, firstMessageTail, recordCall, runContext } from "./runner.js";
import { AbortedError } from "../errors.js";
import { knowledgeById } from "../knowledge.js";
import { buildPlanFromText, detectObject, extractPdfText, loadPlan, planStories, savePlan, type SimEpic, type SimPlan, type SimStory } from "./simplan.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tok = (s: string) => Math.max(1, Math.round(s.length / 3.6));

interface SimState {
  history: number; // tokens accumulated in the conversation (re-read from cache each turn)
  first: boolean;
  /** Size of the real first message this run would send live (context + task). */
  firstTokens?: number;
}

async function simTurn(ctx: ToolContext, o: Pick<RunOptions, "stage" | "item" | "signal">, st: SimState, calls: [string, Record<string, unknown>][], note?: string) {
  if (o.signal?.aborted) throw new AbortedError("Stopped by user");
  checkBudget(ctx.project.id);
  const agent = ctx.agent;
  const system = tok(buildSystemPrompt(agent));
  // Visible output (tool inputs, notes) plus the reasoning tokens a live model spends per call at this effort level —
  // billed as output, so simulated costs track what a live run would cost (and the estimate's assumptions).
  const thinking = Math.round((THINKING_PER_CALL[agent.effort] ?? 600) * (0.8 + Math.random() * 0.4));
  const out = calls.reduce((n, [, input]) => n + tok(JSON.stringify(input)), 0) + 250 + Math.round(Math.random() * 500) + (note ? tok(note) : 0) + thinking;
  const fresh = st.first ? (st.firstTokens ?? 1800) + (ctx.project.pdf_tokens && o.stage === "requirements" ? ctx.project.pdf_tokens : 0) : 120 + calls.length * 90;
  const speed = priceFor(agent.model).tokensPerSecond;
  const ms = Math.min(7000, Math.max(900, (out / speed) * 1000 * 0.35 + 600)) * appSettings().simulationSpeed;
  await sleep(ms);
  recordCall({
    runId: ctx.runId,
    projectId: ctx.project.id,
    agentId: agent.id,
    itemId: o.item?.id,
    stage: o.stage,
    model: agent.model,
    usage: {
      input_tokens: fresh,
      output_tokens: out,
      cache_read_tokens: st.first ? 0 : system + st.history,
      cache_write_tokens: st.first ? system : 0,
    },
    durationMs: Math.round(ms),
    simulated: true,
  });
  st.history += fresh + out;
  st.first = false;
  if (note) {
    logActivity({ projectId: ctx.project.id, agentId: agent.id, runId: ctx.runId, itemId: o.item?.id, type: "note", summary: note });
  }
  const results: Record<string, unknown>[] = [];
  for (const [name, input] of calls) {
    const r = await executeTool(name, input, ctx);
    let parsed: unknown = r.content;
    try {
      parsed = JSON.parse(r.content);
    } catch {
      /* plain text */
    }
    results.push({ ok: r.ok, value: parsed });
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenario: a team task tracker — a web app with an API, an import from the old tool and a chat integration.
// ---------------------------------------------------------------------------------------------------------------------

const SCENARIO: SimEpic[] = [
  {
    title: "Task management",
    background: "The team tracks work in a shared spreadsheet. The goal is one place to create, assign, prioritise and finish tasks.",
    features: [
      {
        title: "Create and organise tasks",
        category: "development",
        stories: [
          {
            title: "Create, edit and delete tasks",
            type: "story",
            category: "development",
            points: 3,
            moscow: "Must",
            user_story: "As a team member, I want to create, edit and delete tasks, so that the team's work is in one place instead of a spreadsheet.",
            background: "Today tasks are rows in a shared spreadsheet and get overwritten. The API stores them with an owner, a status and a due date.",
            rules: ["A task has a title (1–120 characters), an optional description, a status (*Open*, *In progress*, *Done*) and an optional due date.", "Only the task's owner or a team lead can delete it.", "Deleted tasks are soft-deleted and can be restored for 30 days."],
            acs: [
              ["Create a task", "`POST /api/tasks` with a title creates a task with status `Open` and returns it with its id (201)."],
              ["Invalid input is rejected", "A task without a title, or with a title over 120 characters, returns 400 with a message naming the field; nothing is saved."],
              ["Edit and delete", "`PATCH /api/tasks/:id` updates the given fields; `DELETE /api/tasks/:id` soft-deletes the task and it no longer appears in lists."],
            ],
            spec: "| Component | Type | Notes |\n|---|---|---|\n| `src/tasks/task.service.ts` | Service | Validation and business rules |\n| `src/tasks/tasks.routes.ts` | API route | CRUD, errors as JSON |\n| `migrations/001_tasks.sql` | Migration | `tasks` table with `deleted_at` |\n| `test/tasks/task.service.test.ts` | Tests | Happy path, invalid input, soft delete |",
          },
          {
            title: "Filter and sort the task list",
            type: "story",
            category: "development",
            points: 2,
            moscow: "Must",
            user_story: "As a team member, I want to filter tasks by status and owner and sort them by due date, so that I can see what to work on next.",
            background: "The spreadsheet's filters are the most used feature today.",
            rules: ["Filters combine (status AND owner).", "Tasks without a due date sort last."],
            acs: [
              ["Filter", "`GET /api/tasks?status=Open&owner=me` returns only open tasks owned by the current user."],
              ["Sort", "`?sort=due` returns tasks by due date ascending, tasks without a due date last."],
            ],
            spec: "| Component | Type | Notes |\n|---|---|---|\n| `src/tasks/task.query.ts` | Query builder | Whitelisted filters and sort keys |\n| `test/tasks/task.query.test.ts` | Tests | Each filter, combinations, sort order |",
            dependsOn: ["Create, edit and delete tasks"],
          },
          {
            title: "Assign tasks and notify the assignee in Slack",
            type: "story",
            category: "integration",
            points: 5,
            moscow: "Should",
            user_story: "As a team lead, I want the assignee to get a Slack message when I assign a task, so that nobody misses new work.",
            background: "The team lives in Slack. Assignment emails are ignored.",
            rules: ["A message is sent when the assignee changes, never for other edits.", "If Slack does not answer within 10 seconds, the message is queued and retried; the assignment itself always succeeds."],
            acs: [
              ["Message on assignment", "Changing a task's assignee sends one Slack message to that person with the task title and a link."],
              ["Slack unavailable", "If Slack does not answer within 10 s, the assignment is saved, the message is queued and retried with back-off, and the failure is logged."],
              ["No duplicate messages", "Saving a task without changing the assignee sends no message."],
            ],
            spec: "| Component | Type | Notes |\n|---|---|---|\n| `src/integrations/slack-client.ts` | HTTP client | Timeout 10 s, retries with back-off |\n| `src/integrations/outbox.ts` | Outbox | Queues failed messages |\n| `test/integrations/slack-client.test.ts` | Tests | Success, timeout, retry |",
            dependsOn: ["Create, edit and delete tasks"],
            failsQaOnce: "AC 2 — `slack-client.ts` sets no request timeout and never queues a retry; when Slack is slow the assignment request hangs.",
          },
        ],
      },
      {
        title: "Team overview",
        category: "reporting",
        stories: [
          {
            title: "Workload overview per team member",
            type: "story",
            category: "reporting",
            points: 2,
            moscow: "Should",
            user_story: "As a team lead, I want to see open tasks and overdue tasks per person, so that I can balance the team's workload.",
            background: "Team leads build this view by hand every Monday.",
            rules: ["Only open and in-progress tasks count as workload."],
            acs: [
              ["Workload per person", "`GET /api/reports/workload` returns, per team member, the number of open, in-progress and overdue tasks."],
              ["Team only", "A team lead sees only their own team's members."],
            ],
            spec: "| Component | Type | Notes |\n|---|---|---|\n| `src/reports/workload.ts` | Query | Aggregates tasks per assignee |\n| `src/reports/reports.routes.ts` | API route | Scoped to the lead's team |",
            dependsOn: ["Assign tasks and notify the assignee in Slack"],
          },
        ],
      },
    ],
  },
  {
    title: "Moving from the spreadsheet",
    background: "About 1,200 tasks and 40 users live in the old spreadsheet. They must move without losing history, and access must be controlled from day one.",
    features: [
      {
        title: "Import",
        category: "data_migration",
        stories: [
          {
            title: "Import tasks from the old spreadsheet",
            type: "story",
            category: "data_migration",
            points: 5,
            moscow: "Must",
            user_story: "As the product owner, I want every existing task imported with its owner and status, so that the team can switch over without re-typing anything.",
            background: "The spreadsheet is exported as CSV. Owners are written as names, not ids, and some rows are duplicates.",
            rules: ["Tasks are upserted on the spreadsheet row id, so the import can be re-run.", "Owners are matched by email; unmatched owners are reported, not invented."],
            acs: [
              ["Re-runnable import", "Running the import twice creates no duplicates: tasks are upserted on `legacy_id`."],
              ["Counts reconcile", "The script prints source and target counts and exits non-zero on a mismatch."],
            ],
            spec: "| Component | Type | Notes |\n|---|---|---|\n| `tasks.legacy_id` | Column (unique) | Upsert key |\n| `scripts/import-tasks.ts` | Import script | CSV → tasks, owners by email |\n| `scripts/reconcile-tasks.ts` | Script | Source vs target counts |",
            question: "Should tasks marked *Archived* in the spreadsheet be imported as *Done*, or left out?",
            dependsOn: ["Create, edit and delete tasks"],
          },
        ],
      },
      {
        title: "Access",
        category: "security",
        stories: [
          {
            title: "Sign in and team roles",
            type: "story",
            category: "security",
            points: 3,
            moscow: "Must",
            user_story: "As an administrator, I want people to sign in and have a role (member or team lead), so that only the right people can change or delete tasks.",
            background: "The spreadsheet is shared by link today; anyone with the link can change anything.",
            rules: ["Every API request needs a signed-in user.", "Members edit their own tasks; team leads can edit and delete any task in their team."],
            acs: [
              ["Sign-in required", "A request without a valid session returns 401 and nothing is changed."],
              ["Role checked on the server", "A member who tries to delete someone else's task gets 403, even when calling the API directly."],
            ],
            spec: "| Component | Type | Notes |\n|---|---|---|\n| `src/auth/session.ts` | Middleware | Session cookie, 401 when missing |\n| `src/auth/task.policy.ts` | Policy | Member vs team lead rules |\n| `test/auth/task.policy.test.ts` | Tests | Allowed and denied per role |",
          },
        ],
      },
    ],
  },
];

const SAMPLE_PLAN: SimPlan = {
  source: "sample",
  docTitle: "Sample scenario — team task tracker",
  intro: "A team tracks its work in a shared spreadsheet; it needs a task tracker with an API, Slack notifications and an import of the existing tasks.",
  personas: ["team member", "team lead", "product owner", "administrator"],
  objects: ["Task", "User"],
  systems: ["Slack"],
  nfrs: ["Every API error is returned as JSON with a clear message", "Slack calls time out after 10 s with a queued retry"],
  epics: SCENARIO,
};

function planFor(p: Project) {
  return loadPlan(p) ?? SAMPLE_PLAN;
}

function findSimStory(p: Project, title: string): SimStory | undefined {
  return planStories(planFor(p)).find((s) => s.title === title);
}

function objectOf(p: Project, it: WorkItem) {
  const parent = it.parent_id ? getItem(it.parent_id) : undefined;
  return findSimStory(p, it.title)?.object ?? (parent ? findSimStory(p, parent.title)?.object : undefined) ?? detectObject(`${it.title} ${it.user_story} ${it.tech_spec}`, planFor(p).objects[0] ?? "Item");
}

function humanComments(itemId: string) {
  return all<{ content: string }>("SELECT content FROM comments WHERE item_id = ? AND author_id = 'human' ORDER BY id", itemId).map((c) => c.content);
}

function acMarkdown(acs: [string, string][]) {
  return acs.map(([t, b], i) => `### AC ${i + 1}: ${t}\n${b}`).join("\n\n");
}

function pascal(title: string, max = 3) {
  return (
    title
      .replace(/[^A-Za-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !["and", "the", "of", "a", "an", "for", "with", "by", "on", "from", "to", "their", "show", "is", "are", "never", "only", "when", "all"].includes(w.toLowerCase()))
      .slice(0, max)
      .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
      .join("") || "Feature"
  );
}

function acTitles(it: WorkItem) {
  return (it.acceptance_criteria.match(/### AC \d+: .*/g) ?? []).map((h) => h.replace("### ", ""));
}

// ---------------------------------------------------------------------------------------------------------------------

export async function simulateRun(ctx: ToolContext, o: RunOptions): Promise<string> {
  // Same first message a live run would send, so simulated costs follow the real context size.
  const c = await runContext(ctx, o);
  const st: SimState = { history: 0, first: true, firstTokens: tok(c.shared) + tok(firstMessageTail(c, o)) };
  if (o.stage === "review" && o.item && ctx.agent.role === "architect") return simCodeReview(ctx, o, st);
  if (o.kind === "rerun" && o.item && (ctx.agent.role === "requirements" || ctx.agent.role === "architect")) return simRefineItem(ctx, o, st);
  switch (ctx.agent.role) {
    case "requirements":
      return simRequirements(ctx, o, st);
    case "architect":
      return simArchitect(ctx, o, st);
    case "planner":
      return simPlanner(ctx, o, st);
    case "developer":
      return simDeveloper(ctx, o, st);
    case "qa":
      return simQa(ctx, o, st);
    case "writer":
      return simWriter(ctx, o, st);
    case "release":
      return simRelease(ctx, o, st);
    default:
      await simTurn(ctx, o, st, [], "Reviewed the request — nothing to do in this stage.");
      return "No action needed.";
  }
}

async function buildPlan(p: Project): Promise<{ plan: SimPlan; note: string }> {
  let text = "";
  if (p.pdf_file && fs.existsSync(p.pdf_file)) {
    try {
      text = await extractPdfText(p.pdf_file);
    } catch {
      text = "";
    }
  }
  if (p.description) text = `${text}\n\n${p.description}`;
  const derived = buildPlanFromText(text, p.name);
  const plan = derived ?? SAMPLE_PLAN;
  savePlan(p, plan);
  const reqs = planStories(plan).length;
  return {
    plan,
    note: derived
      ? `Read ${p.pdf_name ?? "the description"}: ${plan.epics.length} capability areas and ${reqs} requirements found.`
      : `Couldn't find structured requirements in ${p.pdf_name ?? "the description"} (scanned PDF or too little text) — using the sample task-tracker scenario instead.`,
  };
}

function briefFor(p: Project, plan: SimPlan) {
  const stories = planStories(plan);
  const personaNeeds = plan.personas.slice(0, 6).map((persona) => {
    const theirs = stories.filter((s) => s.user_story.toLowerCase().startsWith(`as a ${persona}`));
    return `| ${persona[0].toUpperCase()}${persona.slice(1)} | ${theirs.length ? theirs.slice(0, 2).map((s) => s.title).join("; ") : "—"} |`;
  });
  return `# Project brief — ${p.name}

${plan.source === "document" ? `_Derived from **${plan.docTitle}**${p.pdf_name ? ` (${p.pdf_name})` : ""}._` : "_Simulation mode: no structured requirements were found in the input, so this brief describes the sample scenario._"}

## Goal
${plan.intro || `Deliver the capabilities described in ${plan.docTitle}.`}

## Scope
${plan.epics.map((e) => `- **${e.title}** — ${e.features.map((f) => f.title).join(", ")}`).join("\n")}

## Personas
| Persona | Main needs |
|---|---|
${personaNeeds.join("\n") || "| Business user | — |"}

## Business processes (to-be)
${plan.epics.map((e, i) => `${i + 1}. **${e.title}:** ${e.features.flatMap((f) => f.stories.map((s) => s.title.toLowerCase())).slice(0, 4).join("; ")}.`).join("\n")}

## Data entities
${plan.objects.map((o) => `\`${o}\``).join(", ") || "To be confirmed"}

## Integrations
${plan.systems.length ? plan.systems.map((s) => `- ${s}`).join("\n") : "- None identified"}

## Non-functional requirements
${plan.nfrs.length ? plan.nfrs.map((n) => `- ${n}`).join("\n") : "- Every API error is returned as JSON with a clear message"}

## Assumptions
- The repository's existing stack and conventions are kept.
- Open questions are answered before development of the affected stories.

## Out of scope
- Anything not described in the source document.
`;
}

async function simRequirements(ctx: ToolContext, o: RunOptions, st: SimState) {
  const p = ctx.project;
  const { plan, note } = await buildPlan(p);
  await simTurn(ctx, o, st, [["write_document", { kind: "project_brief", title: `Project brief — ${p.name}`, content: briefFor(p, plan) }]], note);

  const questions: [string, string][] = [];
  for (const epic of plan.epics) {
    const [er] = await simTurn(ctx, o, st, [["create_work_item", { type: "epic", title: epic.title, category: epic.features[0]?.category ?? "development", background: epic.background }]]);
    const epicCode = (er.value as { code: string }).code;
    for (const f of epic.features) {
      const [fr] = await simTurn(ctx, o, st, [["create_work_item", { type: "feature", title: f.title, parent_code: epicCode, category: f.category }]]);
      const featureCode = (fr.value as { code: string }).code;
      const calls: [string, Record<string, unknown>][] = f.stories.map((s) => [
        "create_work_item",
        {
          type: s.type,
          title: s.title,
          parent_code: featureCode,
          category: s.category,
          state: s.question ? "Requires additional information" : "Ready for Refinement",
          user_story: s.user_story,
          background: s.background,
          business_rules: s.rules.map((r) => `- ${r}`).join("\n"),
          dependencies: (s.dependsOn ?? []).map((d) => `- ${d}`).join("\n") || "- None",
          out_of_scope: "- Anything not described in this story's acceptance criteria",
          acceptance_criteria: acMarkdown(s.acs),
          tech_spec: s.spec,
          tags: [s.source ? `Source ${s.source}` : "Sample", s.category === "data_migration" ? "Data" : s.category === "integration" ? "Integration" : "Process"],
        },
      ]);
      for (let i = 0; i < calls.length; i += 3) {
        const res = await simTurn(ctx, o, st, calls.slice(i, i + 3));
        res.forEach((r, j) => {
          const s = f.stories[i + j];
          if (s.question) questions.push([s.question, (r.value as { code: string }).code]);
        });
      }
    }
  }
  if (questions.length) {
    await simTurn(ctx, o, st, questions.map(([q, code]) => ["ask_human", { question: q, item_code: code }]), `${questions.length} point(s) in the document need a decision from the product owner.`);
  }
  const stories = planStories(plan);
  const byCat = Object.entries(stories.reduce<Record<string, number>>((m, s) => ((m[s.category] = (m[s.category] ?? 0) + 1), m), {}))
    .map(([c, n]) => `${n} ${c.replace("_", " ")}`)
    .join(", ");
  await simTurn(ctx, o, st, [
    [
      "post_message",
      {
        to: "architect",
        kind: "handoff",
        content: `Backlog ready: ${plan.epics.length} epics, ${plan.epics.reduce((n, e) => n + e.features.length, 0)} features, ${stories.length} stories/tasks (${byCat}). ${questions.length} open question(s) for the product owner.`,
      },
    ],
  ]);
  return `Created the project brief and a backlog of ${stories.length} stories across ${plan.epics.length} epics from ${plan.source === "document" ? "the document" : "the sample scenario"}. ${questions.length} open questions recorded.`;
}

/** Re-run of the analyst or architect on a single item with product-owner feedback. */
async function simRefineItem(ctx: ToolContext, o: RunOptions, st: SimState) {
  const it = getItem(o.item!.id)!;
  const feedback = (o.feedback ?? "").trim() || "Make it clearer and more testable.";
  await simTurn(ctx, o, st, [["get_item", { code: it.code }]], `Revising ${it.code} with your feedback.`);
  if (ctx.agent.role === "requirements") {
    const n = acTitles(it).length + 1;
    await simTurn(ctx, o, st, [
      [
        "update_work_item",
        {
          code: it.code,
          business_rules: `${it.business_rules}\n- ${feedback}`.trim(),
          acceptance_criteria: `${it.acceptance_criteria}\n\n### AC ${n}: Product owner feedback\n${feedback}`.trim(),
          state: "Ready for Refinement",
        },
      ],
    ]);
  } else {
    await simTurn(ctx, o, st, [
      [
        "update_work_item",
        {
          code: it.code,
          tech_spec: `${it.tech_spec}\n\n#### Revision — product owner feedback\n- ${feedback}\n- Impact: components above updated accordingly; no new dependencies.`,
          state: it.state === "Requires additional information" ? "Requires additional information" : "Ready for Sprint",
        },
      ],
    ]);
  }
  await simTurn(ctx, o, st, [["post_message", { to: "developer", kind: "info", item_code: it.code, content: `${it.code} was revised after product-owner feedback: "${feedback}".` }]]);
  return `Revised ${it.code}: ${feedback}`;
}

async function simArchitect(ctx: ToolContext, o: RunOptions, st: SimState) {
  const items = listItems(ctx.project.id);
  const feature = o.item;
  const plan = planFor(ctx.project);
  const single = feature && ["story", "task", "bug"].includes(feature.type);
  const stories = single ? [getItem(feature.id)!] : items.filter((i) => (i.type === "story" || i.type === "task") && (!feature || i.parent_id === feature.id));
  await simTurn(ctx, o, st, [["read_document", { kind: "project_brief" }], ["read_document", { kind: "solution_design" }]], `Refining ${stories.length} item(s) of ${feature?.code ?? "the backlog"}.`);
  for (const s of stories) {
    if (s.category === "integration") {
      await simTurn(ctx, o, st, [["consult_agent", { agent: "requirements", question: `For ${s.code}, is a read-only view of ${plan.systems[0] ?? "the external system"} data enough, or must users also change data there from this app?`, item_code: s.code }]]);
    }
    const decision =
      s.category === "development" || s.category === "integration"
        ? "Extend the existing service and route modules; calls to external systems go through a client with a timeout and a retry outbox."
        : s.category === "data_migration" || s.category === "script"
          ? "A re-runnable script that upserts on the legacy id and reconciles counts afterwards."
          : "Follow the existing module layout; configuration through validated settings with safe defaults.";
    await simTurn(ctx, o, st, [
      [
        "update_work_item",
        {
          code: s.code,
          tech_spec: `${s.tech_spec}\n\n#### Architecture decision\n${decision}\n\n#### Security\n- Authorisation checked on the server for every request.\n\n#### Test approach\n- Tests: happy path, invalid input and the failure paths in the ACs.\n- Manual: one check per AC (see How to Test).`,
          state: s.state === "Requires additional information" ? "Requires additional information" : "Ready for Sprint",
        },
      ],
    ]);
  }
  const prev =
    findDoc(ctx.project.id, "solution_design", null)?.content ??
    `# Solution design — ${ctx.project.name}\n\n## Architecture overview\nThe existing application, extended with ${plan.objects.slice(0, 5).map((x) => `\`${x}\``).join(", ")}${plan.systems.length ? `; integrations with ${plan.systems.join(", ")}` : ""}.\n\n## Key decisions\n| Decision | Reason | Alternatives |\n|---|---|---|\n| Follow the existing module layout | Familiar to the team, fewer surprises | A new structure |\n| Validate input at the API boundary | One place for rules and error messages | Validation in the UI only |\n${plan.systems.length ? `| Outbox for ${plan.systems[0]} | No lost messages, retries | Synchronous calls only |\n` : ""}\n## Components by area\n`;
  const section = `\n### ${feature?.code ?? ""} ${feature?.title ?? "Backlog"}\n${stories.map((s) => `- **${s.code}** ${s.title} — ${s.category.replace("_", " ")}`).join("\n")}\n`;
  await simTurn(ctx, o, st, [["write_document", { kind: "solution_design", title: `Solution design — ${ctx.project.name}`, content: prev + section }]]);
  return `Refined ${stories.length} item(s) and updated the solution design.`;
}

async function simPlannerSingle(ctx: ToolContext, o: RunOptions, st: SimState) {
  const it = getItem(o.item!.id)!;
  const all = listItems(ctx.project.id).filter((i) => i.type === "story" || i.type === "task" || i.type === "bug");
  const sim = findSimStory(ctx.project, it.title);
  const points = it.story_points ?? sim?.points ?? 3;
  const open = all.filter((i) => !["Release Ready", "Smoke Testing", "Deployed (Done)", "Cancelled"].includes(i.state) && i.sprint);
  const sprint = open.length ? Math.min(...open.map((i) => i.sprint!)) : 1;
  await simTurn(ctx, o, st, [["get_item", { code: it.code }]], `Estimating ${it.code}.`);
  await simTurn(ctx, o, st, [
    ["plan_item", { code: it.code, story_points: points, moscow: it.moscow ?? sim?.moscow ?? "Should", priority: it.priority ?? 2, wsjf: Math.round((20 / points) * 10) / 10, depends_on: it.depends_on, sprint, rank: it.rank ?? Math.max(0, ...all.map((i) => i.rank ?? 0)) + 1 }],
  ]);
  return `Planned ${it.code}: ${points} points, sprint ${sprint}.`;
}

async function simPlanner(ctx: ToolContext, o: RunOptions, st: SimState) {
  if (o.item && ["story", "task", "bug"].includes(o.item.type)) return simPlannerSingle(ctx, o, st);
  const items = listItems(ctx.project.id).filter((i) => i.type === "story" || i.type === "task");
  await simTurn(ctx, o, st, [["list_items", {}]], `Estimating and ordering ${items.length} items.`);
  const weight: Record<string, number> = { security: 0, configuration: 1, script: 2, development: 3, data_migration: 4, integration: 5, reporting: 6, testing: 7, documentation: 8 };
  const ordered = [...items].sort((a, b) => (weight[a.category] ?? 9) - (weight[b.category] ?? 9));
  let sprint = 1;
  let load = 0;
  const calls: [string, Record<string, unknown>][] = [];
  ordered.forEach((it, idx) => {
    const sim = findSimStory(ctx.project, it.title);
    const points = sim?.points ?? 3;
    if (load + points > 20) {
      sprint++;
      load = 0;
    }
    load += points;
    const deps = (sim?.dependsOn ?? []).map((t) => items.find((x) => x.title === t)?.code).filter(Boolean);
    calls.push([
      "plan_item",
      {
        code: it.code,
        story_points: points,
        moscow: sim?.moscow ?? "Should",
        wsjf: Math.round(((sim?.moscow === "Must" ? 24 : 15) / points) * 10) / 10,
        priority: sim?.moscow === "Must" ? 1 : sim?.moscow === "Should" ? 2 : 3,
        depends_on: deps,
        sprint,
        rank: idx + 1,
      },
    ]);
  });
  for (let i = 0; i < calls.length; i += 3) await simTurn(ctx, o, st, calls.slice(i, i + 3));
  const planned = listItems(ctx.project.id).filter((i) => i.type === "story" || i.type === "task").sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const sprints = [...new Set(planned.map((i) => i.sprint))].filter(Boolean) as number[];
  const total = planned.reduce((n, i) => n + (i.story_points ?? 0), 0);
  const cats = new Set(planned.map((i) => i.category));
  const goal = (s: number) => {
    const its = planned.filter((i) => i.sprint === s);
    const c = [...new Set(its.map((i) => i.category.replace("_", " ")))];
    return s === 1 ? `Foundations: ${c.slice(0, 3).join(", ")}` : `Deliver ${c.slice(0, 3).join(", ")}`;
  };
  const plan = `# Delivery plan — ${ctx.project.name}

## Summary
${planned.length} items, **${total} story points**, ${sprints.length} sprint(s) of 2 weeks at ~20 points.

## Sprint plan
| Sprint | Stories | Points | Goal |
|---|---|---|---|
${sprints.map((s) => {
  const its = planned.filter((i) => i.sprint === s);
  return `| ${s} | ${its.map((i) => i.code).join(", ")} | ${its.reduce((n, i) => n + (i.story_points ?? 0), 0)} | ${goal(s)} |`;
}).join("\n")}

## Critical path
${planned.filter((i) => i.depends_on.length).slice(0, 4).map((i) => `${i.depends_on.join(", ")} → ${i.code}`).join(" · ") || planned.slice(0, 4).map((i) => i.code).join(" → ")}

## Milestones
| Milestone | When |
|---|---|
| Foundations ready | End of sprint 1 |
| UAT | End of sprint ${sprints.length} |
| Go-live | UAT + 1 week |

## Risks & mitigations
| Risk | Mitigation |
|---|---|
${cats.has("integration") ? "| External system latency or downtime | Timeouts, retries via outbox, alerting |\n" : ""}${cats.has("data_migration") ? "| Duplicate or dirty legacy data | Dedupe before load, external-id upserts, reconciliation |\n" : ""}| Open questions unanswered | Affected stories stay in *Requires additional information* |

## Assumptions
- Open questions are answered before the sprint that contains the affected stories.
`;
  await simTurn(ctx, o, st, [
    ["write_document", { kind: "delivery_plan", title: `Delivery plan — ${ctx.project.name}`, content: plan }],
    ["post_message", { to: "developer", kind: "handoff", content: `Sprint 1 is planned (${planned.filter((i) => i.sprint === 1).length} items). Start with ${planned[0]?.code} — the foundations everything else depends on.` }],
  ]);
  return `Planned ${planned.length} items (${total} points) over ${sprints.length} sprint(s).`;
}

/** `buggy` = the first attempt of the story QA will reject: it contains exactly the defect QA reports, so the rework diff shows the real fix. */
function filesFor(it: WorkItem, obj: string, system: string, buggy = false): [string, string][] {
  const name = pascal(it.title);
  const mod = kebab(name);
  const entity = obj.toLowerCase();
  const header = `// ${it.code} — ${it.title.replace(/\*\//g, "")}\n`;
  switch (it.category) {
    case "development":
      return [
        [
          `src/${entity}s/${mod}.service.ts`,
          `${header}import { db } from "../db.js";

export interface ${obj}Input {
  title?: string;
  description?: string;
}

export class ValidationError extends Error {
  constructor(public field: string, message: string) {
    super(message);
  }
}

export function validate${obj}(input: ${obj}Input) {
${buggy ? "  // TODO: validation" : `  const title = input.title?.trim() ?? "";
  if (!title) throw new ValidationError("title", "Title is required.");
  if (title.length > 120) throw new ValidationError("title", "Title can be at most 120 characters.");`}
}

export async function create${obj}(input: ${obj}Input) {
  validate${obj}(input);
  return db.${entity}s.insert({ title: input.title!.trim(), description: input.description ?? "", status: "Open" });
}
`,
        ],
        [
          `test/${entity}s/${mod}.test.ts`,
          `${header}import { test } from "node:test";
import assert from "node:assert/strict";
import { create${obj}, ValidationError } from "../../src/${entity}s/${mod}.service.js";

test("creates a ${entity} with status Open", async () => {
  const created = await create${obj}({ title: "Write the report" });
  assert.equal(created.status, "Open");
});

test("rejects a ${entity} without a title", async () => {
  await assert.rejects(create${obj}({ title: "  " }), ValidationError);
});

test("rejects a title over 120 characters", async () => {
  await assert.rejects(create${obj}({ title: "x".repeat(121) }), ValidationError);
});
`,
        ],
      ];
    case "configuration":
      return [
        [
          `src/config/${mod}.ts`,
          `${header}export interface ${name}Settings {
  enabled: boolean;
}

const DEFAULTS: ${name}Settings = { enabled: true };

export function load${name}Settings(env: Record<string, string | undefined> = process.env): ${name}Settings {
  const raw = env.${mod.toUpperCase().replace(/-/g, "_")}_ENABLED;
  if (raw === undefined) return DEFAULTS;
  if (raw !== "true" && raw !== "false") throw new Error("${mod.toUpperCase().replace(/-/g, "_")}_ENABLED must be true or false.");
  return { enabled: raw === "true" };
}
`,
        ],
        [`test/config/${mod}.test.ts`, `${header}import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { load${name}Settings } from "../../src/config/${mod}.js";\n\ntest("defaults when nothing is set", () => {\n  assert.deepEqual(load${name}Settings({}), { enabled: true });\n});\n\ntest("rejects an invalid value", () => {\n  assert.throws(() => load${name}Settings({ ${mod.toUpperCase().replace(/-/g, "_")}_ENABLED: "yes" }));\n});\n`],
      ];
    case "data_migration":
      return [
        [`docs/migration/${mod}-mapping.md`, `# ${it.code} mapping\n\n${it.tech_spec}\n`],
        [
          `scripts/import-${mod}.ts`,
          `${header}// Re-runnable: rows are upserted on legacy_id. Usage: node scripts/import-${mod}.js <file.csv>
import fs from "node:fs";
import { db } from "../src/db.js";

const file = process.argv[2];
if (!file) throw new Error("usage: import-${mod} <file.csv>");
const [, ...rows] = fs.readFileSync(file, "utf8").trim().split("\\n");
let upserted = 0;
for (const row of rows) {
  const [legacyId, title, status] = row.split(",");
  await db.${entity}s.upsert({ legacy_id: legacyId, title, status }, "legacy_id");
  upserted++;
}
console.log(\`\${rows.length} source rows, \${upserted} upserted\`);
if (upserted !== rows.length) process.exit(1);
`,
        ],
      ];
    case "script":
      return [[`scripts/${mod}.ts`, `${header}// Idempotent — safe to run more than once.\nimport { db } from "../src/db.js";\n\nconst changed = await db.${entity}s.updateWhere({ status: null }, { status: "Open" });\nconsole.log(\`\${changed} ${entity}s updated\`);\n`]];
    case "integration": {
      const sys = kebab(system);
      return [
        [
          `src/integrations/${sys}-client.ts`,
          `${header}import { enqueueRetry } from "./outbox.js";

const TIMEOUT_MS = 10_000;

export async function send(path: string, body: unknown) {
${buggy ? `  const res = await fetch(\`\${process.env.${sys.toUpperCase().replace(/-/g, "_")}_URL}\${path}\`, { method: "POST", body: JSON.stringify(body) });
  return res.ok;` : `  try {
    const res = await fetch(\`\${process.env.${sys.toUpperCase().replace(/-/g, "_")}_URL}\${path}\`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(\`${system} answered \${res.status}\`);
    return true;
  } catch (e) {
    console.error("${sys}-client.send failed", path, e);
    await enqueueRetry("${sys}", path, body);
    return false;
  }`}
}
`,
        ],
        [`test/integrations/${sys}-client.test.ts`, `${header}import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { send } from "../../src/integrations/${sys}-client.js";\n\ntest("queues a retry when ${system} does not answer", async (t) => {\n  t.mock.method(globalThis, "fetch", () => Promise.reject(new DOMException("timeout", "TimeoutError")));\n  assert.equal(await send("/messages", { text: "hi" }), false);\n});\n`],
      ];
    }
    case "security":
      return [
        [`src/auth/${mod}.policy.ts`, `${header}export type Role = "member" | "lead";\n\nexport interface Actor {\n  id: string;\n  role: Role;\n}\n\n/** Members change their own ${entity}s; leads change any ${entity} in their team. Checked on the server for every request. */\nexport function canChange(actor: Actor, ownerId: string) {\n  return actor.role === "lead" || actor.id === ownerId;\n}\n`],
        [`test/auth/${mod}.test.ts`, `${header}import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { canChange } from "../../src/auth/${mod}.policy.js";\n\ntest("a member can change only their own ${entity}s", () => {\n  assert.equal(canChange({ id: "a", role: "member" }, "a"), true);\n  assert.equal(canChange({ id: "a", role: "member" }, "b"), false);\n});\n\ntest("a lead can change any ${entity}", () => {\n  assert.equal(canChange({ id: "a", role: "lead" }, "b"), true);\n});\n`],
      ];
    case "reporting":
      return [[`src/reports/${mod}.ts`, `${header}import { db } from "../db.js";\n\n/** Open, in-progress and overdue ${entity}s per assignee in the lead's team. */\nexport async function ${name.charAt(0).toLowerCase() + name.slice(1)}(teamId: string, now = new Date()) {\n  const rows = await db.${entity}s.where({ teamId, status: ["Open", "In progress"] });\n  const out = new Map<string, { open: number; inProgress: number; overdue: number }>();\n  for (const r of rows) {\n    const s = out.get(r.assigneeId) ?? { open: 0, inProgress: 0, overdue: 0 };\n    if (r.status === "Open") s.open++;\n    else s.inProgress++;\n    if (r.due && r.due < now) s.overdue++;\n    out.set(r.assigneeId, s);\n  }\n  return Object.fromEntries(out);\n}\n`]];
    default:
      return [[`docs/${it.code}-notes.md`, `# ${it.code}\n\n${it.title}\n`]];
  }
}

function kebab(s: string) {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "feature";
}

async function simDeveloper(ctx: ToolContext, o: RunOptions, st: SimState) {
  const it = getItem(o.item!.id)!;
  const iteration = o.attempt ?? o.iteration ?? 1;
  const isBug = it.type === "bug";
  const comments = humanComments(it.id);
  const plan = planFor(ctx.project);
  const obj = objectOf(ctx.project, it);
  const note = isBug
    ? `Fixing bug ${it.code} — ${it.title}.`
    : iteration > 1
      ? `Fixing QA findings on ${it.code} (iteration ${iteration}).`
      : o.feedback
        ? `Re-working ${it.code} with your feedback.`
        : `Implementing ${it.code} — ${it.title}.`;
  await simTurn(
    ctx,
    o,
    st,
    [["get_item", { code: it.code }], ["read_document", { kind: "solution_design" }], ["list_files", {}], ...(iteration > 1 ? ([["read_document", { kind: "test_report", item_code: it.code }]] as [string, Record<string, unknown>][]) : [])],
    iteration > 1 ? `${note} Reading the test report and screenshots from QA.` : note,
  );
  if (iteration === 1 && !isBug && !o.feedback && it.category === "integration") {
    await simTurn(ctx, o, st, [["consult_agent", { agent: "architect", question: `${it.code}: should failed calls to ${plan.systems[0] ?? "the external system"} be retried from a transactional outbox, or is an immediate error to the user enough?`, item_code: it.code }]]);
  }

  let files: [string, string][];
  if (isBug) {
    const parent = it.parent_id ? getItem(it.parent_id) : undefined;
    const parentFiles = parent ? all<{ path: string }>("SELECT path FROM files WHERE item_id = ? AND path LIKE 'src/%' ORDER BY path", parent.id) : [];
    const target = parentFiles[0]?.path;
    const [read] = target ? await simTurn(ctx, o, st, [["read_file", { path: target }]]) : [{ value: "" }];
    const original = typeof read.value === "string" ? read.value : "";
    const mod = kebab(pascal(it.title));
    files = [];
    if (target && original) {
      files.push([target, original.replace(/\n/, `\n// ${it.code}: ${it.title.replace(/\*\//g, "")} — guard added, see test/regressions/${it.code.toLowerCase()}.test.ts\n`)]);
    }
    files.push([
      `test/regressions/${it.code.toLowerCase()}.test.ts`,
      `// Regression test for ${it.code}: ${it.title.replace(/\*\//g, "")}\nimport { test } from "node:test";\nimport assert from "node:assert/strict";\n\n// Steps from ${it.code}:\n${it.background.split("\n").filter(Boolean).map((l) => `// ${l.replace(/^[-\d.\s]+/, "")}`).join("\n")}\ntest("${it.code} no longer reproduces (${mod})", () => {\n  assert.ok(true);\n});\n`,
    ]);
  } else {
    const victim = findSimStory(ctx.project, it.title)?.failsQaOnce;
    // Use the external system this story talks about (e.g. SAP), not just the first one in the document.
    const system = plan.systems.find((x) => new RegExp(`\\b${x}\\b`, "i").test(`${it.title} ${it.user_story} ${it.business_rules}`)) ?? plan.systems[0] ?? "External";
    files = filesFor(it, obj, system, Boolean(victim) && iteration === 1 && !o.feedback);
    if ((iteration > 1 && !victim) || o.feedback || comments.length) {
      // Rework touches the main source file; add a note of what changed.
      const main = files.findIndex(([p]) => p.startsWith("src/") || p.startsWith("scripts/"));
      if (main >= 0) {
        const why = iteration > 1 ? "QA findings addressed" : o.feedback ? `Product owner feedback: ${o.feedback}` : `Comments addressed: ${comments.join(" / ")}`;
        const [p, c] = files[main];
        files[main] = [p, `// ${why.replace(/\*\//g, "")}\n${c}`];
      }
    }
  }
  // One file per call, as live developers are told to do (complete files, never batched) — keeps simulated turns,
  // cache re-reads and costs in line with a live run.
  for (const [path, content] of files) {
    await simTurn(ctx, o, st, [["write_file", { path, content }]]);
  }

  const name = pascal(it.title);
  const acs = acTitles(it);
  await simTurn(ctx, o, st, [
    [
      "update_work_item",
      {
        code: it.code,
        solution_components: files.map(([p]) => `- \`${p}\``).join("\n") || "- See the story's branch",
        how_to_test: isBug
          ? `## Tests\n- [ ] Run the project's checks; the regression test for ${it.code} passes\n\n## Manual Testing\n- [ ] **Reproduce ${it.code}**\n  Follow the steps to reproduce.\n  **Verify:** the expected behaviour now happens.`
          : `## Tests\n- [ ] Run the project's checks (\`run_checks\`)\n\n## Manual Testing\n${acs.map((ac) => `- [ ] **${ac}**\n  Follow the AC with a test ${obj.toLowerCase()}.\n  **Verify:** the outcome described in the AC.`).join("\n")}`,
        manual_steps: it.category === "configuration" ? `## Configuration\n- [ ] Set \`${kebab(name).toUpperCase().replace(/-/g, "_")}_ENABLED\` in each environment (default \`true\`).` : it.category === "data_migration" ? `## Post-Release\n- [ ] Run \`scripts/import-${kebab(name)}.ts\` with the exported CSV and check the reconciliation output.` : "",
      },
    ],
  ]);
  const victim = findSimStory(ctx.project, it.title);
  const summary = isBug
    ? `Fixed ${it.code}: added a guard in the affected class and a regression test that reproduces the reported steps.`
    : iteration > 1
      ? victim?.category === "integration"
        ? "Fixed QA findings: added a 10 s timeout and a retry through the outbox; a test covers the timeout path."
        : "Fixed QA findings: input is validated and invalid requests return 400; tests cover the invalid cases."
      : o.feedback
        ? `Applied your feedback: ${o.feedback}`
        : `Implemented ${files.length} files for ${it.code}.${comments.length ? ` Addressed ${comments.length} comment(s) from the product owner.` : ""}`;
  await simTurn(ctx, o, st, [["run_checks", {}]]);
  await simTurn(ctx, o, st, [["complete_development", { code: it.code, summary }]]);
  return summary;
}

async function simQa(ctx: ToolContext, o: RunOptions, st: SimState) {
  const it = getItem(o.item!.id)!;
  const sim = findSimStory(ctx.project, it.title);
  const iteration = o.attempt ?? o.iteration ?? 1;
  await simTurn(ctx, o, st, [["get_item", { code: it.code }], ["list_files", {}]], `Planning checks for ${it.code} from ${it.type === "bug" ? "the bug report" : "its acceptance criteria"}.`);
  let checks: [string, string][] = acTitles(it).map((ac) => [ac, ac.split(":")[0]]);
  if (it.type === "bug") checks = [["Steps to reproduce no longer reproduce the bug", "Bug"], ["Regression test covers the reported steps", "Regression"]];
  if (!checks.length) checks = [["AC 1: Main outcome", "AC 1"]];
  if (o.feedback) checks.push([`Product owner feedback applied: ${o.feedback.slice(0, 60)}`, "Feedback"]);
  const failing = sim?.failsQaOnce && iteration === 1 && o.kind !== "rerun" && it.type !== "bug" ? sim.failsQaOnce : null;
  const calls: [string, Record<string, unknown>][] = checks.map(([label, ref], i) => {
    const fail = failing && failing.startsWith(ref);
    return [
      "record_test_result",
      {
        code: it.code,
        ac_ref: label,
        result: fail ? "fail" : "pass",
        notes: fail ? failing! : `Verified in the delivered source: the behaviour required by ${ref} is implemented${i === 0 ? " and covered by a test" : ""}.`,
      },
    ];
  });
  for (let i = 0; i < calls.length; i += 4) await simTurn(ctx, o, st, calls.slice(i, i + 4));

  // Evidence: one screenshot per check, then the test report the developer and the task keep.
  const shots = await simTurn(ctx, o, st, calls.map(([, input]) => ["capture_evidence", input]), `Capturing evidence for ${calls.length} check(s).`);
  const globalIteration = o.iteration ?? 1;
  const verdict = failing ? "❌ Changes requested" : "✅ Approved";
  const steps = (label: string) =>
    it.type === "bug"
      ? "1. Log in as the test user.\n2. Follow the bug's steps to reproduce.\n3. Compare with the expected behaviour."
      : `1. Sign in as a test user.\n2. Create or open test data for ${it.code}.\n3. Perform the action described in ${label.split(":")[0]} and check the outcome.`;
  const report = `# ${it.code} — Test report (iteration ${globalIteration})
**Verdict:** ${verdict} · **Tester:** ${ctx.agent.name} · **Date:** ${new Date().toISOString().slice(0, 10)}${ctx.project.mode === "simulation" ? " · simulated evidence" : ""}

## Summary
| Check | Result | Evidence |
|---|---|---|
${calls.map(([, input], i) => `| ${String(input.ac_ref)} | ${input.result === "pass" ? "✅ Works" : input.result === "fail" ? "❌ Broken" : "⛔ Couldn't test"} | screenshot ${i + 1} |`).join("\n")}

## Checks
${calls
  .map(([, input], i) => {
    const md = (shots[i]?.value as { markdown?: string } | undefined)?.markdown ?? "";
    const r = input.result === "pass" ? "✅ Works" : input.result === "fail" ? "❌ Broken" : "⛔ Couldn't test";
    return `### ${String(input.ac_ref)} — ${r}\n**Steps:**\n${steps(String(input.ac_ref))}\n\n**Found:** ${String(input.notes)}\n\n${md}`;
  })
  .join("\n\n")}
${failing ? `\n## What to do\n- **${failing.split(" — ")[0]}** — ${failing.split(" — ")[1] ?? failing}\n  Fix it and add a test that proves the behaviour; I will re-test this check first.\n` : ""}`;
  await simTurn(ctx, o, st, [["write_document", { kind: "test_report", item_code: it.code, title: `${it.code} test report`, content: report }]]);

  if (!failing) await simTurn(ctx, o, st, [["run_checks", {}]]);
  await simTurn(ctx, o, st, [
    [
      "submit_review",
      failing
        ? { code: it.code, verdict: "changes_requested", findings: `- **${failing.split(" — ")[0]}** — ${failing.split(" — ")[1] ?? failing}\n  Expected: the behaviour described in the AC, including the failure path, with a test that proves it.` }
        : { code: it.code, verdict: "approved", findings: "All checks verified and the project's checks pass. Code follows the standards (input validated, errors handled, tests prove each AC)." },
    ],
  ]);
  return failing ? `❌ Changes requested on ${it.code}.` : `✅ ${it.code} approved.`;
}

/** Scripted architect code review: approves, except the first review of the story that also fails QA once — so the
 *  review → development → QA → review loop is exercised on one predictable story. */
async function simCodeReview(ctx: ToolContext, o: RunOptions, st: SimState) {
  const it = getItem(o.item!.id)!;
  const sim = findSimStory(ctx.project, it.title);
  const reviews = all<{ n: number }>("SELECT COUNT(*) n FROM item_phases WHERE item_id = ? AND phase = 'review'", it.id)[0]?.n ?? 0;
  await simTurn(ctx, o, st, [], `Reviewing the diff of ${it.code} against the review checklist and the solution design.`);
  const failing = Boolean(sim?.failsQaOnce) && reviews <= 1 && o.kind !== "rerun" && it.type !== "bug";
  const name = it.title.replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean).slice(0, 4).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  const findings = failing
    ? it.category === "integration"
      ? `- **src/integrations/** — the endpoint URL is hard-coded in the client.\n  Expected: read it from configuration as the solution design says, so each environment points to its own system.`
      : `- **src/** — a failure is swallowed in an empty catch block.\n  Expected: log the error with the ids involved and return a meaningful error, as the checklist requires.`
    : "Design fit, checklist and security verified: input validated, errors handled, authorisation on the server, tests assert real outcomes.";
  await simTurn(ctx, o, st, [["submit_code_review", { code: it.code, verdict: failing ? "changes_requested" : "approved", findings }]]);
  return failing ? `❌ Code review requested changes on ${it.code}.` : `✅ Code review approved ${it.code}.`;
}

async function simWriter(ctx: ToolContext, o: RunOptions, st: SimState) {
  const it = getItem(o.item!.id)!;
  await simTurn(ctx, o, st, [["get_item", { code: it.code }], ["read_document", { kind: "user_manual" }]], `Documenting ${it.code}.`);
  const acs = acTitles(it).map((h) => `- ${h}`).join("\n");
  const taskDoc = `# ${it.code}: ${it.title}
**Status:** Release Ready · **Type:** ${it.type} · **Category:** ${it.category.replace("_", " ")} · **Points:** ${it.story_points ?? "—"} · **Sprint:** ${it.sprint ?? "—"}

## Summary
${it.type === "bug" ? `Fix for a defect reported after release: ${it.title}.` : it.user_story}

## What was built
${it.solution_components || "- See solution components"}

## How it works
${acs || it.background}

## How to test
${it.how_to_test || "See story."}

## Deployment notes
${it.manual_steps || "No manual steps."}

## Test evidence
${findDoc(ctx.project.id, "test_report", it.id) ? `Peer-tested by QA — see **test_report.md** in this story's folder (version ${findDoc(ctx.project.id, "test_report", it.id)!.version}, with screenshots per acceptance criterion).` : "Not peer-tested."}

## Known limitations
- None identified.
`;
  const manual = findDoc(ctx.project.id, "user_manual", null)?.content ?? `# User manual — ${ctx.project.name}\n\nThis manual explains how to use the solution day to day.\n`;
  const chapter =
    it.type === "bug"
      ? ""
      : `\n## ${it.title}\n${it.user_story.replace(/^As an? [^,]+, /, "").replace(/^I want( to)?/, "You can")}\n\n**Steps**\n1. Open the app.\n2. ${it.category === "reporting" ? "Open the report from the Reports page." : "Work as usual — the behaviour described below is available."}\n3. Check the result described below.\n\n${acs}\n`;
  const changelog = findDoc(ctx.project.id, "changelog", null)?.content ?? "# Changelog\n";
  const tech = findDoc(ctx.project.id, "technical_overview", null)?.content ?? `# Technical overview — ${ctx.project.name}\n`;
  const docCalls: [string, Record<string, unknown>][] = [["write_document", { kind: "task_doc", item_code: it.code, title: `${it.code} ${it.title}`, content: taskDoc }]];
  if (chapter && !manual.includes(`## ${it.title}\n`)) docCalls.push(["write_document", { kind: "user_manual", title: `User manual — ${ctx.project.name}`, content: manual + chapter }]);
  await simTurn(ctx, o, st, docCalls);
  await simTurn(ctx, o, st, [
    ["write_document", { kind: "technical_overview", title: `Technical overview — ${ctx.project.name}`, content: `${tech}\n## ${it.code} ${it.title}\n${it.solution_components}\n` }],
    ["write_document", { kind: "changelog", title: "Changelog", content: changelog.replace("# Changelog\n", `# Changelog\n\n- ${new Date().toISOString().slice(0, 10)} — ${it.type === "bug" ? "fix: " : ""}${it.code} ${it.title}`) }],
  ]);
  return `Documented ${it.code}: task document, user manual, technical overview and changelog updated.`;
}

function nextVersion(projectId: string, scope: WorkItem[]) {
  const last = get<{ version: string }>("SELECT version FROM releases WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", projectId)?.version;
  if (!last) return "1.0.0";
  const [ma, mi, pa] = last.split(".").map((n) => Number(n) || 0);
  return scope.every((i) => i.type === "bug") ? `${ma}.${mi}.${pa + 1}` : `${ma}.${mi + 1}.0`;
}

async function simRelease(ctx: ToolContext, o: RunOptions, st: SimState) {
  const ready = listItems(ctx.project.id).filter((i) => i.state === "Smoke Testing");
  await simTurn(ctx, o, st, [["list_items", { state: "Smoke Testing" }]], `Release scope: ${ready.length} item(s).`);
  const [v] = await simTurn(ctx, o, st, [["run_checks", {}]]);
  const checks = String(v.value ?? "");
  const smoke: [string, Record<string, unknown>][] = ready.map((it) => [
    "record_test_result",
    { code: it.code, ac_ref: it.type === "bug" ? "Smoke — bug no longer reproduces" : "Smoke — AC 1", result: "pass", notes: "Critical path verified after deployment." },
  ]);
  for (let i = 0; i < smoke.length; i += 4) await simTurn(ctx, o, st, smoke.slice(i, i + 4));
  const version = nextVersion(ctx.project.id, ready);
  const bugs = ready.filter((i) => i.type === "bug");
  const features = ready.filter((i) => i.type !== "bug");
  const epics = [...new Set(features.map((i) => (i.parent_id ? getItem(i.parent_id) : undefined)).map((f) => (f?.parent_id ? getItem(f.parent_id)?.title : f?.title)).filter(Boolean))] as string[];
  const notes = `# Release ${version} — ${new Date().toISOString().slice(0, 10)}

## Highlights
${features.length ? epics.slice(0, 5).map((e) => `- ${e}`).join("\n") || features.slice(0, 5).map((i) => `- ${i.title}`).join("\n") : ""}${bugs.length ? `${features.length ? "\n" : ""}- ${bugs.length} bug fix(es) after the previous release` : ""}

## Delivered
| Code | Title | Type | Category | Points |
|---|---|---|---|---|
${ready.map((i) => `| ${i.code} | ${i.title} | ${i.type} | ${i.category.replace("_", " ")} | ${i.story_points ?? "—"} |`).join("\n")}

## Checks on the release
${checks}

## Smoke test results
| Code | Result | Note |
|---|---|---|
${ready.map((i) => `| ${i.code} | ✅ | Critical path verified |`).join("\n")}

## Known issues
- None.

## Rollback plan
Revert the release commit and redeploy the previous tag.
`;
  await simTurn(ctx, o, st, [["publish_release", { version, notes }]]);
  await simTurn(ctx, o, st, [["post_message", { to: "human", kind: "info", content: `Release ${version} published: ${ready.length} item(s) checked and smoke-tested.` }]]);
  return `Release ${version} published with ${ready.length} items.`;
}

export async function simulateConsult(target: Agent, question: string, ctx: ToolContext, runId: string) {
  const st: SimState = { history: 0, first: true };
  const fake: ToolContext = { ...ctx, agent: target, runId, outcome: {} };
  await simTurn(fake, { stage: "consult", item: ctx.item }, st, []);
  const it = ctx.item ? getItem(ctx.item.id) : undefined;
  const sim = it ? findSimStory(ctx.project, it.title) : undefined;
  const obj = it ? objectOf(ctx.project, it) : "the record";
  const answers: Record<string, string> = {
    requirements: sim ? `Per the source document${sim.source ? ` (${sim.source})` : ""}: ${sim.rules[0] ?? sim.title} Anything beyond that is out of scope for this release.` : "Keep to what the document states; anything else goes to the product owner as an open question.",
    architect: /retr|outbox|error/i.test(question)
      ? "Use the transactional outbox: the callout failure is recorded, retried with back-off, and the user sees a clear message. Never block the user transaction on the external system."
      : `Store it on ${obj} with a dedicated field. A separate object adds sharing complexity for no benefit at this volume.`,
    planner: "Keep it in the current sprint; it does not change the critical path.",
    qa: "Cover it with one positive and one negative check per condition in the AC.",
    developer: "That is feasible within the current estimate; I'd implement it in the service class with a test for each branch.",
    writer: "I'll describe it in the user manual as a task-oriented step with the field labels users see.",
    release: "No impact on the release plan — it is covered by the current manifest.",
  };
  return answers[target.role] ?? `Based on my expertise: keep it simple, declarative where possible, and document the decision in the solution design.`;
}

/** Simulated reply for the agent chat panel — grounded in the agent's real state, runs and knowledge. */
export async function simulateChat(agent: Agent, project: Project | null, message: string): Promise<string> {
  const m = message.toLowerCase();
  const code = message.match(/\b(EP|FT|US|TK|BG)-\d+\b/i)?.[0]?.toUpperCase();
  const item = project && code ? listItems(project.id).find((i) => i.code === code) : undefined;
  const runs = all<{ stage: string; status: string; summary: string | null; item_id: string | null; started_at: string }>(
    `SELECT stage, status, summary, item_id, started_at FROM runs WHERE agent_id = ? ${project ? "AND project_id = ?" : ""} ORDER BY started_at DESC LIMIT 5`,
    ...(project ? [agent.id, project.id] : [agent.id]),
  );
  const stats = get<{ c: number; n: number }>(`SELECT COALESCE(SUM(cost_usd),0) c, COUNT(*) n FROM llm_calls WHERE agent_id = ? ${project ? "AND project_id = ?" : ""}`, ...(project ? [agent.id, project.id] : [agent.id]))!;
  const where = project ? ` on ${project.key}` : "";

  if (item) {
    const tests = all<{ result: string }>("SELECT result FROM test_results WHERE item_id = ?", item.id);
    const mine = runs.filter((r) => r.item_id === item.id);
    const pass = tests.filter((t) => t.result === "pass").length;
    const fail = tests.filter((t) => t.result === "fail").length;
    const myView: Record<string, string> = {
      developer: `I ${mine.length ? "built it" : "haven't built it yet"}. ${item.solution_components ? `Components:\n${item.solution_components}` : ""}`,
      qa: tests.length ? `My checks: ${pass} ✅ / ${fail} ❌${item.rework_count ? `, after ${item.rework_count} rework loop(s)` : ""}.` : "I haven't tested it yet.",
      architect: item.tech_spec.includes("Architecture decision") ? `My decision: ${item.tech_spec.split("#### Architecture decision\n")[1]?.split("\n")[0] ?? "see the tech spec"}` : "I haven't refined it yet.",
      requirements: `I wrote it from ${item.background.match(/§[\d.]+/)?.[0] ?? "the requirements"}. It has ${acTitles(item).length} acceptance criteria.`,
      planner: item.story_points ? `I estimated it at ${item.story_points} points (${item.moscow}), sprint ${item.sprint}, rank #${item.rank}.` : "It isn't planned yet.",
      writer: findDoc(item.project_id, "task_doc", item.id) ? "Its task document is written and the user manual is updated." : "I haven't documented it yet.",
      release: item.state === "Deployed (Done)" ? "It's deployed and smoke-tested." : `It's in "${item.state}" — not released yet.`,
    };
    return `**${item.code} — ${item.title}** is in *${item.state}*.\n\n${myView[agent.role] ?? ""}`.trim();
  }
  if (/\b(hi|hello|hey|hola|who are you)\b/.test(m)) {
    return `Hi, I'm ${agent.name}, the ${agent.title}. ${agent.description}\n\nAsk me what I'm working on, about a work item (e.g. "US-104"), what I cost, or what I know.`;
  }
  if (/(working|doing|status|progress|busy|up to)/.test(m)) {
    const active = runs.find((r) => r.status === "running");
    if (active) return `Right now I'm on **${active.stage}**${active.item_id ? ` for ${getItem(active.item_id)?.code}` : ""}${where}.`;
    if (runs[0]) return `I'm idle${where}. My last run was **${runs[0].stage}**: ${runs[0].summary ?? runs[0].status}.`;
    return `I haven't worked${where} yet.`;
  }
  if (/(cost|spend|spent|price|tokens|expensive)/.test(m)) {
    return `So far${where} I've made ${stats.n} model calls costing **$${stats.c.toFixed(3)}** (simulated at ${agent.model} prices). My effort level is *${agent.effort}*; lowering it or switching model is the main way to make me cheaper.`;
  }
  if (/(know|knowledge|skill|standard|trained|rules)/.test(m)) {
    const packs = knowledgeById(agent.knowledge).map((k) => `- ${k.title}`).join("\n");
    return `My knowledge packs:\n${packs || "- none"}${agent.custom_knowledge.trim() ? `\n\nPlus my custom knowledge, which starts: "${agent.custom_knowledge.trim().split("\n")[0].slice(0, 120)}"` : "\n\nI have no custom knowledge yet — you can write it on my agent page."}`;
  }
  const flavour: Record<string, string> = {
    requirements: "I'd capture that as a user story with direct acceptance criteria and, if anything is ambiguous, an open question for you.",
    architect: "I'd look at how the codebase already does it, then specify the modules, data model and API in the tech spec.",
    planner: "I'd size it in story points, check its dependencies and slot it into the first sprint with capacity.",
    developer: "I'd implement it in the existing structure with tests for the happy path, invalid input and the failure paths, and run the checks.",
    qa: "I'd plan one check per acceptance criterion and give a ✅/❌/⛔ verdict with evidence — never softening a failure.",
    writer: "I'd document it task-first for end users, and update the technical overview and changelog.",
    release: "I'd run the checks on main, smoke test it and add it to the release notes.",
  };
  return `${flavour[agent.role] ?? "I'll look into it."}\n\nIf you want me to actually change something, use **Re-run with feedback** on the work item${project ? "" : " inside a project"}.`;
}
