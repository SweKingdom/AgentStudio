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
// Scenario: a typical Service Cloud implementation with a legacy migration and an ERP integration.
// ---------------------------------------------------------------------------------------------------------------------

const SCENARIO: SimEpic[] = [
  {
    title: "Customer Service Case Management",
    background: "Service agents today work cases from a shared mailbox and spreadsheets. The goal is one place to receive, route, track and escalate every customer request.",
    features: [
      {
        title: "Case intake & routing",
        category: "configuration",
        stories: [
          {
            title: "Email-to-Case with automatic categorisation",
            type: "story",
            category: "configuration",
            points: 3,
            moscow: "Must",
            user_story: "As a service agent, I want customer emails to become categorised cases automatically, so that I never have to copy requests from the shared mailbox.",
            background: "Customers write to support@. Today an agent copies each email into a spreadsheet. Email-to-Case removes the manual step and keyword rules give each case a first category.",
            rules: ["Every email to the support address creates exactly one case (replies thread into the existing case).", "Category is set from subject keywords; unmatched emails get category *General*.", "Cases created from email start with status *New* and origin *Email*."],
            acs: [
              ["Email creates a case", "An email sent to the support address creates a Case with `Origin` = `Email`, `Status` = `New`, subject and body copied."],
              ["Keyword categorisation", "When the subject contains *invoice*, *billing* or *refund* → `Category__c` = `Billing`; *broken*, *error*, *not working* → `Technical`; otherwise `General`."],
              ["Replies thread", "A reply to a case email is attached to the existing case and does not create a new one."],
            ],
            spec: "| Component | Type | Notes |\n|---|---|---|\n| `Case.Category__c` | Picklist (restricted) | Billing / Technical / General |\n| `Case_BeforeSave_Categorise` | Record-triggered flow (before save) | Entry: `Origin = 'Email'` on create |\n| Email-to-Case routing address | Manual setup | support@ → queue *Support Tier 1* |",
          },
          {
            title: "Automatic case assignment by product and region",
            type: "story",
            category: "development",
            points: 5,
            moscow: "Must",
            user_story: "As a team lead, I want new cases assigned to the right team automatically, so that customers get an answer from a specialist quickly.",
            background: "Assignment depends on the product line and the customer's region, which a standard assignment rule cannot express with the current product hierarchy.",
            rules: ["Assignment uses the routing matrix maintained by team leads (custom metadata).", "If no rule matches, the case goes to the *Support Tier 1* queue.", "Manual owner changes are never overwritten."],
            acs: [
              ["Matrix assignment", "On case creation, `OwnerId` is set to the queue from the routing matrix row matching `Product_Line__c` + `Account.Region__c`."],
              ["Fallback queue", "When no row matches, the case is assigned to the *Support Tier 1* queue."],
              ["Bulk safe", "Creating 200 cases in one transaction assigns all of them without hitting governor limits."],
              ["No overwrite", "Updating a case whose owner was changed manually does not re-run assignment."],
            ],
            spec: "| Component | Type | Notes |\n|---|---|---|\n| `Case_Routing__mdt` | Custom metadata | `Product_Line__c`, `Region__c`, `Queue_Developer_Name__c` |\n| `CaseTrigger` / `CaseTriggerHandler` | Apex trigger + handler | before insert |\n| `CaseRoutingService` | Apex service | Resolves queue Ids in bulk, one SOQL per object |",
            question: "Should cases from VIP accounts bypass the routing matrix and go straight to the Key Accounts queue?",
          },
        ],
      },
      {
        title: "SLA & escalation",
        category: "configuration",
        stories: [
          {
            title: "SLA milestones and escalation alerts",
            type: "story",
            category: "configuration",
            points: 5,
            moscow: "Must",
            user_story: "As a team lead, I want to be alerted before a case breaches its SLA, so that I can step in in time.",
            background: "Contracts promise a first response within 4 business hours and resolution within 3 business days. Breaches are currently discovered after the fact.",
            rules: ["First response: 4 business hours. Resolution: 3 business days.", "At 75 % of the first-response time the owner is notified; at breach the team lead is notified and the case is flagged *Escalated*."],
            acs: [
              ["Entitlement applied", "New cases for accounts with an active contract get the *Standard Support* entitlement and its milestones."],
              ["Warning at 75 %", "When 75 % of the first-response time has elapsed without a first response, the case owner receives an email and bell notification."],
              ["Escalation at breach", "At breach, `IsEscalated` = true, `Escalation_Level__c` = `Tier_2`, and the team lead is notified."],
            ],
            spec: "| Component | Type | Notes |\n|---|---|---|\n| Entitlement process *Standard Support* | Setup | Milestones: First Response (4h), Resolution (3d), business hours *Support Hours* |\n| `Case.Escalation_Level__c` | Picklist | Tier_1 / Tier_2 / Tier_3 |\n| `Case_AfterSave_Escalate` | Record-triggered flow (after save) | Entry: `IsEscalated` changed to true |",
            dependsOn: ["Email-to-Case with automatic categorisation"],
          },
          {
            title: "Escalation dashboard for team leads",
            type: "story",
            category: "reporting",
            points: 2,
            moscow: "Should",
            user_story: "As a team lead, I want a dashboard of open, at-risk and escalated cases, so that I can balance my team's workload.",
            background: "Team leads currently build this view by hand every morning.",
            rules: ["Dashboard runs as the viewing user (each lead sees their own team)."],
            acs: [
              ["Open cases by status", "A chart shows open cases grouped by status and owner."],
              ["At-risk cases", "A table lists cases with a milestone within 25 % of breach, oldest first."],
            ],
            spec: "| Component | Type | Notes |\n|---|---|---|\n| `Service_Reports/Open_Cases_By_Owner` | Report | Summary report on Cases |\n| `Service_Dashboards/Team_Lead_Overview` | Dashboard | Dynamic dashboard (run as logged-in user) |",
            dependsOn: ["SLA milestones and escalation alerts"],
          },
        ],
      },
    ],
  },
  {
    title: "Legacy data & integrations",
    background: "Customer history lives in a legacy CRM that is being retired, and order information lives in the ERP. Agents need both inside Salesforce.",
    features: [
      {
        title: "Legacy CRM migration",
        category: "data_migration",
        stories: [
          {
            title: "Migrate accounts and contacts from the legacy CRM",
            type: "story",
            category: "data_migration",
            points: 5,
            moscow: "Must",
            user_story: "As a service agent, I want every existing customer and contact available in Salesforce, so that I can see who I am talking to from day one.",
            background: "About 40,000 accounts and 95,000 contacts are exported from the legacy CRM as CSV. Duplicates exist and must be merged before load.",
            rules: ["Accounts and contacts are upserted on `Legacy_Id__c` so the load can be re-run.", "Contacts without an account are attached to the *Unassigned Customers* account."],
            acs: [
              ["Re-runnable load", "Running the load twice creates no duplicates: records are upserted on `Legacy_Id__c`."],
              ["Counts reconcile", "Record counts per object in Salesforce match the source extract minus documented rejects."],
              ["Relationships kept", "Every migrated contact is linked to its migrated account."],
            ],
            spec: "| Source | Target | Rule |\n|---|---|---|\n| `cust_id` | `Account.Legacy_Id__c` | External Id, unique |\n| `cust_name` | `Account.Name` | Trim |\n| `country` | `Account.BillingCountryCode` | ISO 3166 |\n| `contact_id` | `Contact.Legacy_Id__c` | External Id, unique |\n| `email` | `Contact.Email` | Lower-case, validated |",
            question: "Which legacy account statuses should be excluded from the migration (e.g. *Closed*, *Prospect*)?",
          },
          {
            title: "Migrate open cases with their history",
            type: "story",
            category: "data_migration",
            points: 5,
            moscow: "Should",
            user_story: "As a service agent, I want open legacy cases in Salesforce with their history, so that I can continue the conversation without asking the customer again.",
            background: "Only open cases and cases closed in the last 12 months are migrated.",
            rules: ["Case comments migrate as Case Comments in chronological order.", "Migrated cases are tagged with the migration batch for rollback."],
            acs: [
              ["Scope", "Only open cases and cases closed in the last 12 months are loaded."],
              ["History", "Each migrated case shows its legacy comments in the original order."],
            ],
            spec: "| Source | Target | Rule |\n|---|---|---|\n| `case_id` | `Case.Legacy_Id__c` | External Id |\n| `cust_id` | `Case.Account` (via `Account.Legacy_Id__c`) | Relationship by external id |\n| `batch` | `Case.Migration_Batch__c` | Rollback tag |",
            dependsOn: ["Migrate accounts and contacts from the legacy CRM", "Email-to-Case with automatic categorisation"],
          },
          {
            title: "Bulk-load automation bypass and reconciliation script",
            type: "task",
            category: "script",
            points: 2,
            moscow: "Must",
            user_story: "As the migration lead, I want automation bypassed during loads and a reconciliation report afterwards, so that loads are fast and verifiable.",
            background: "Triggers and flows must not fire for migrated records, but must stay active for users.",
            rules: ["Bypass is granted only to the migration user via a custom permission."],
            acs: [
              ["Bypass", "Records loaded by a user with `Bypass_Automation` do not fire case assignment or escalation automation."],
              ["Reconciliation", "The script prints source vs target counts per object and exits non-zero on mismatch."],
            ],
            spec: "| Component | Type | Notes |\n|---|---|---|\n| `Bypass_Automation` | Custom permission | Checked by triggers and flows |\n| `scripts/data/reconcile.sh` | Script | SOQL counts vs CSV line counts |",
          },
        ],
      },
      {
        title: "ERP order status integration",
        category: "integration",
        stories: [
          {
            title: "Show ERP order status on the case",
            type: "story",
            category: "integration",
            points: 8,
            moscow: "Should",
            user_story: "As a service agent, I want to see the live status of the customer's order on the case, so that I can answer delivery questions without opening the ERP.",
            background: "The ERP exposes a REST endpoint per order number. Agents ask about delivery status in roughly a third of all cases.",
            rules: ["Status is fetched when the case is opened and can be refreshed manually.", "If the ERP does not answer within 10 seconds, the last known status is shown with a warning."],
            acs: [
              ["Status shown", "When a case has an order number, the case page shows order status, expected delivery date and carrier."],
              ["Timeout handling", "If the ERP does not answer within 10 s, the last stored status is shown with the text *ERP not reachable — showing last known status*."],
              ["Errors logged", "Every failed call is logged with the order number and HTTP status."],
            ],
            spec: "| Component | Type | Notes |\n|---|---|---|\n| `ERP_Orders` | Named Credential | Base URL from ERP team, OAuth client credentials |\n| `ErpOrderClient` | Apex | `GET /orders/{orderNumber}`, timeout 10 000 ms |\n| `erpOrderStatus` | LWC | Case record page, refresh button |\n| `Case.Order_Number__c` | Text(20) | |",
            dependsOn: ["Email-to-Case with automatic categorisation"],
            failsQaOnce: "AC 2 — `ErpOrderClient` sets no request timeout and never falls back to the stored status; a slow ERP blocks the page for the default 120 s.",
          },
        ],
      },
      {
        title: "Access & security",
        category: "security",
        stories: [
          {
            title: "Service agent and team lead permission sets",
            type: "story",
            category: "security",
            points: 2,
            moscow: "Must",
            user_story: "As an administrator, I want one permission set per role, so that access is granted consistently and audited easily.",
            background: "Access is granted with permission sets only; profiles stay minimal.",
            rules: ["Agents can read and edit cases they own or their queue owns; team leads can also reassign and see the dashboard."],
            acs: [
              ["Agent access", "`Service_Agent_Access` grants read/edit on Case, read on Account/Contact and access to the ERP status component."],
              ["Lead access", "`Team_Lead_Access` adds reassign rights, the escalation dashboard and routing matrix maintenance."],
            ],
            spec: "| Component | Type | Notes |\n|---|---|---|\n| `Service_Agent_Access` | Permission set | Object + FLS + Apex class access |\n| `Team_Lead_Access` | Permission set | Agent access + reports/dashboards + `Case_Routing__mdt` |",
          },
        ],
      },
    ],
  },
];

const SAMPLE_PLAN: SimPlan = {
  source: "sample",
  docTitle: "Sample scenario — Service Cloud rollout",
  intro: "Service agents work cases from a shared mailbox and spreadsheets; customer history lives in a legacy CRM and order data in the ERP.",
  personas: ["service agent", "team lead", "migration lead", "administrator"],
  objects: ["Case", "Account", "Contact", "Entitlement"],
  systems: ["ERP"],
  nfrs: ["200-record bulk safety on every automation", "ERP calls time out after 10 s with graceful fallback"],
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
  return findSimStory(p, it.title)?.object ?? (parent ? findSimStory(p, parent.title)?.object : undefined) ?? detectObject(`${it.title} ${it.user_story} ${it.tech_spec}`, planFor(p).objects[0] ?? "Account");
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
      : `Couldn't find structured requirements in ${p.pdf_name ?? "the description"} (scanned PDF or too little text) — using the sample Service Cloud scenario instead.`,
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
${plan.intro || `Deliver the capabilities described in ${plan.docTitle} on Salesforce.`}

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
${plan.nfrs.length ? plan.nfrs.map((n) => `- ${n}`).join("\n") : "- 200-record bulk safety on every automation"}

## Assumptions
- The required Salesforce licences are available in the target org.
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
      await simTurn(ctx, o, st, [["consult_agent", { agent: "requirements", question: `For ${s.code}, is a read-only view of ${plan.systems[0] ?? "the external system"} data enough, or must users also change data there from Salesforce?`, item_code: s.code }]]);
    }
    const decision =
      s.category === "development" || s.category === "integration"
        ? "Code (Apex): bulk logic / callouts with timeout and retry control cannot be expressed declaratively."
        : s.category === "data_migration" || s.category === "script"
          ? "Bulk API 2.0 upserts on external ids, automation bypass via custom permission."
          : "Declarative: flows and configuration are sufficient and maintainable by admins.";
    await simTurn(ctx, o, st, [
      [
        "update_work_item",
        {
          code: s.code,
          tech_spec: `${s.tech_spec}\n\n#### Architecture decision\n${decision}\n\n#### Security\n- Access through role-based permission sets; no profile changes.\n\n#### Test approach\n- Unit tests: positive, negative and 200-record bulk.\n- Manual: one check per AC (see How to Test).`,
          state: s.state === "Requires additional information" ? "Requires additional information" : "Ready for Sprint",
        },
      ],
    ]);
  }
  const prev =
    findDoc(ctx.project.id, "solution_design", null)?.content ??
    `# Solution design — ${ctx.project.name}\n\n## Architecture overview\nSalesforce platform with ${plan.objects.slice(0, 5).map((x) => `\`${x}\``).join(", ")}${plan.systems.length ? `; integrations with ${plan.systems.join(", ")}` : ""}.\n\n## Key decisions\n| Decision | Reason | Alternatives |\n|---|---|---|\n| Clicks before code | Admin-maintainable, faster to change | Apex everywhere |\n| External ids on every migrated object | Re-runnable, relationship-safe loads | Salesforce Ids mapping tables |\n${plan.systems.length ? `| Transactional outbox for ${plan.systems[0]} | No lost messages, retries, error write-back | Synchronous callouts only |\n` : ""}\n## Components by area\n`;
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
  const xmlHead = '<?xml version="1.0" encoding="UTF-8"?>';
  const clsMeta = `${xmlHead}\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>62.0</apiVersion>\n    <status>Active</status>\n</ApexClass>\n`;
  const apexPair = (cls: string, body: string): [string, string][] => [
    [`force-app/main/default/classes/${cls}.cls`, body],
    [`force-app/main/default/classes/${cls}.cls-meta.xml`, clsMeta],
  ];
  const testClass = (cls: string, target: string) => `@IsTest
private class ${cls} {
    @TestSetup
    static void setup() {
        TestDataFactory.create${obj}Records(1, true);
    }

    @IsTest
    static void shouldProcessRecordsWhenInputIsValid() {
        List<${obj}> records = TestDataFactory.create${obj}Records(1, false);
        Test.startTest();
        ${target}.process(records);
        Test.stopTest();
        Assert.isFalse(records.isEmpty(), 'Records should be processed');
    }

    @IsTest
    static void shouldIgnoreEmptyInput() {
        Test.startTest();
        ${target}.process(new List<${obj}>());
        Test.stopTest();
        Assert.areEqual(0, Limits.getDmlStatements(), 'No DML expected for empty input');
    }

    @IsTest
    static void shouldHandleBulkOf200() {
        List<${obj}> records = TestDataFactory.create${obj}Records(200, false);
        Test.startTest();
        ${target}.process(records);
        Test.stopTest();
        Assert.areEqual(200, records.size(), 'All 200 records processed without limit errors');
    }
}
`;
  const field = (o: string, api: string, label: string, extra = "<type>Text</type>\n    <length>80</length>") => [
    `force-app/main/default/objects/${o}/fields/${api}.field-meta.xml`,
    `${xmlHead}\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>${api}</fullName>\n    <label>${label}</label>\n    ${extra}\n    <description>${it.code}: ${it.title}</description>\n</CustomField>\n`,
  ] as [string, string];
  switch (it.category) {
    case "development":
      return [
        ...apexPair(
          `${name}Service`,
          `/**
 * ${it.code} — ${it.title}
 */
public with sharing class ${name}Service {
    public static void process(List<${obj}> records) {
        if (records == null || records.isEmpty()) {
            return;
        }
        Set<Id> relatedIds = new Set<Id>();
        for (${obj} r : records) {
            if (r.Id != null) {
                relatedIds.add(r.Id);
            }
        }
${buggy ? `        for (${obj} r : records) {
            List<${obj}> prior = [SELECT Id, ${name}_Status__c FROM ${obj} WHERE Id = :r.Id LIMIT 1];
            r.${name}_Status__c = prior.isEmpty() ? 'New' : 'Updated';
        }` : `        Map<Id, ${obj}> existing = new Map<Id, ${obj}>(${name}Selector.byIds(relatedIds));
        for (${obj} r : records) {
            ${obj} prior = existing.get(r.Id);
            r.${name}_Status__c = prior == null ? 'New' : 'Updated';
        }`}
    }
}
`,
        ),
        ...apexPair(`${name}ServiceTest`, testClass(`${name}ServiceTest`, `${name}Service`)),
        [`force-app/main/default/triggers/${obj}Trigger.trigger`, `trigger ${obj}Trigger on ${obj} (before insert, before update) {\n    new ${obj}TriggerHandler().run();\n}\n`],
        [`force-app/main/default/triggers/${obj}Trigger.trigger-meta.xml`, `${xmlHead}\n<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>62.0</apiVersion>\n    <status>Active</status>\n</ApexTrigger>\n`],
        field(obj, `${name}_Status__c`, `${name} Status`),
      ];
    case "configuration":
      return [
        [
          `force-app/main/default/flows/${obj}_AfterSave_${name}.flow-meta.xml`,
          `${xmlHead}\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>62.0</apiVersion>\n    <description>${it.code}: ${it.title}</description>\n    <label>${obj} After Save ${name}</label>\n    <processType>AutoLaunchedFlow</processType>\n    <start>\n        <object>${obj}</object>\n        <recordTriggerType>CreateAndUpdate</recordTriggerType>\n        <triggerType>RecordAfterSave</triggerType>\n    </start>\n    <status>Active</status>\n</Flow>\n`,
        ],
        field(obj, `${name}_Status__c`, `${name} Status`),
      ];
    case "data_migration":
      return [
        [`scripts/data/${name}-mapping.md`, `# ${it.code} mapping\n\n${it.tech_spec}\n`],
        [`scripts/data/${name}-upsert.sh`, `#!/usr/bin/env bash\nset -euo pipefail\n# ${it.code}: ${it.title}\nORG=\${1:?usage: $0 <sandbox-alias>}\nsf data upsert bulk --sobject ${obj} --file scripts/data/templates/${name}.csv --external-id Legacy_Id__c -o "$ORG" --wait 30\n`],
        [`scripts/data/templates/${name}.csv`, `Legacy_Id__c,Name,Migration_Batch__c\n`],
        field(obj, "Legacy_Id__c", "Legacy Id", "<externalId>true</externalId>\n    <length>40</length>\n    <type>Text</type>\n    <unique>true</unique>"),
      ];
    case "script":
      return [
        [`scripts/apex/${name}.apex`, `// ${it.code}: ${it.title}\n// Idempotent — safe to run more than once.\nList<${obj}> records = [SELECT Id FROM ${obj} WHERE ${name}_Status__c = null LIMIT 10000];\nfor (${obj} r : records) {\n    r.${name}_Status__c = 'Processed';\n}\nupdate records;\nSystem.debug(LoggingLevel.INFO, records.size() + ' records updated');\n`],
        [`force-app/main/default/customPermissions/Bypass_Automation.customPermission-meta.xml`, `${xmlHead}\n<CustomPermission xmlns="http://soap.sforce.com/2006/04/metadata">\n    <label>Bypass Automation</label>\n    <description>${it.code}: granted only to the migration user</description>\n</CustomPermission>\n`],
      ];
    case "integration": {
      const cls = `${system.replace(/[^A-Za-z0-9]/g, "")}${name}Client`;
      return [
        ...apexPair(
          cls,
          `/**
 * ${it.code} — ${it.title}
 */
public with sharing class ${cls} {
    @TestVisible private static final Integer TIMEOUT_MS = 10000;

    public static HttpResponse send(String path, String body) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:${system.replace(/[^A-Za-z0-9]/g, "")}_API' + path);
        req.setMethod(body == null ? 'GET' : 'POST');
${buggy ? `        if (body != null) {
            req.setBody(body);
        }
        return new Http().send(req);` : `        req.setTimeout(TIMEOUT_MS);
        if (body != null) {
            req.setBody(body);
        }
        try {
            return new Http().send(req);
        } catch (CalloutException e) {
            ErrorLogger.log(e, '${cls}.send', path);
            IntegrationOutbox.enqueueRetry(path, body);
            return null;
        }`}
    }
}
`,
        ),
        ...apexPair(`${cls}Test`, testClass(`${cls}Test`, cls)),
      ];
    }
    case "security":
      return [
        [
          `force-app/main/default/permissionsets/${name}_Access.permissionset-meta.xml`,
          `${xmlHead}\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <label>${name} Access</label>\n    <description>${it.code}</description>\n    <hasActivationRequired>false</hasActivationRequired>\n    <objectPermissions>\n        <allowCreate>true</allowCreate>\n        <allowDelete>false</allowDelete>\n        <allowEdit>true</allowEdit>\n        <allowRead>true</allowRead>\n        <modifyAllRecords>false</modifyAllRecords>\n        <object>${obj}</object>\n        <viewAllRecords>false</viewAllRecords>\n    </objectPermissions>\n</PermissionSet>\n`,
        ],
      ];
    case "reporting":
      return [
        [`force-app/main/default/reports/${name}_Reports/${name}_Report.report-meta.xml`, `${xmlHead}\n<Report xmlns="http://soap.sforce.com/2006/04/metadata">\n    <name>${it.title.slice(0, 40)}</name>\n    <format>Summary</format>\n    <reportType>${obj}</reportType>\n    <scope>organization</scope>\n</Report>\n`],
      ];
    default:
      return [[`docs/${it.code}-notes.md`, `# ${it.code}\n\n${it.title}\n`]];
  }
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
    const parentFiles = parent ? all<{ path: string }>("SELECT path FROM files WHERE item_id = ? AND path LIKE '%.cls' AND path NOT LIKE '%Test.cls' ORDER BY path", parent.id) : [];
    const target = parentFiles[0]?.path;
    const [read] = target ? await simTurn(ctx, o, st, [["read_file", { path: target }]]) : [{ value: "" }];
    const original = typeof read.value === "string" ? read.value : "";
    const cls = target ? target.split("/").pop()!.replace(".cls", "") : `${pascal(it.title)}Fix`;
    files = [];
    if (target && original) {
      files.push([target, original.replace(/\{\n/, `{\n    // ${it.code}: ${it.title.replace(/\*\//g, "")} — guard added, see ${cls}RegressionTest.\n`)]);
    }
    files.push(
      [`force-app/main/default/classes/${cls}RegressionTest.cls`, `@IsTest\nprivate class ${cls}RegressionTest {\n    @IsTest\n    static void shouldNotReproduce${it.code.replace("-", "")}() {\n        // Steps from ${it.code}:\n${it.background.split("\n").filter(Boolean).map((l) => `        // ${l.replace(/^[-\d.\s]+/, "")}`).join("\n")}\n        Test.startTest();\n        ${cls.replace(/Test$/, "")}.process(new List<${obj}>());\n        Test.stopTest();\n        Assert.isTrue(true, 'Bug ${it.code} no longer reproduces');\n    }\n}\n`],
      [`force-app/main/default/classes/${cls}RegressionTest.cls-meta.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>62.0</apiVersion>\n    <status>Active</status>\n</ApexClass>\n`],
    );
  } else {
    const victim = findSimStory(ctx.project, it.title)?.failsQaOnce;
    // Use the external system this story talks about (e.g. SAP), not just the first one in the document.
    const system = plan.systems.find((x) => new RegExp(`\\b${x}\\b`, "i").test(`${it.title} ${it.user_story} ${it.business_rules}`)) ?? plan.systems[0] ?? "External";
    files = filesFor(it, obj, system, Boolean(victim) && iteration === 1 && !o.feedback);
    if ((iteration > 1 && !victim) || o.feedback || comments.length) {
      // Rework touches the main source file; add a note of what changed.
      const main = files.findIndex(([p]) => /\.(cls|flow-meta\.xml|sh|apex)$/.test(p) && !/Test\.cls$/.test(p));
      if (main >= 0) {
        const why = iteration > 1 ? "QA findings addressed" : o.feedback ? `Product owner feedback: ${o.feedback}` : `Comments addressed: ${comments.join(" / ")}`;
        const [p, c] = files[main];
        const marker = p.endsWith(".xml") ? `<!-- ${why.replace(/--/g, "—")} -->\n` : p.endsWith(".sh") ? `# ${why}\n` : `// ${why.replace(/\*\//g, "")}\n`;
        files[main] = [p, p.endsWith(".xml") ? c.replace("?>\n", `?>\n${marker}`) : p.endsWith(".sh") ? c.replace("\n", `\n${marker}`) : marker + c];
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
        solution_components:
          files
            .filter(([p]) => p.startsWith("force-app") && !p.endsWith("-meta.xml"))
            .map(([p]) => `- \`${p.split("/").pop()!.replace(/\.(cls|trigger|field-meta\.xml|flow-meta\.xml|permissionset-meta\.xml|report-meta\.xml|customPermission-meta\.xml|html|js)$/, "")}\` (${p.split("/")[3]})`)
            .filter((v, i, a) => a.indexOf(v) === i)
            .join("\n") ||
          files
            .filter(([p]) => !p.endsWith("-meta.xml"))
            .map(([p]) => `- \`${p}\``)
            .join("\n") ||
          "- Scripts under `scripts/`",
        how_to_test: isBug
          ? `## Unit Tests\n- [ ] Run the regression test for ${it.code}\n\n## Manual Testing\n- [ ] **Reproduce ${it.code}**\n  Follow the steps to reproduce.\n  **Verify:** the expected behaviour now happens.`
          : `## Unit Tests\n- [ ] Run: \`sf apex run test --class-names ${name}ServiceTest --code-coverage --synchronous\`\n\n## Manual Testing\n${acs.map((ac) => `- [ ] **${ac}**\n  Follow the AC in a sandbox with a test ${obj} record.\n  **Verify:** the outcome described in the AC.`).join("\n")}`,
        manual_steps: it.category === "configuration" ? `## Post-Deployment\n- [ ] **Activate the flow** \`${obj}_AfterSave_${name}\` if it was deployed inactive\n\n## Verification\n- [ ] Create a test ${obj} and check the result.` : it.category === "security" ? `## Post-Deployment\n- [ ] **Assign \`${name}_Access\`** to the users listed in the story.` : "",
      },
    ],
    ...(isBug ? [] : ([["write_file", { path: `docs/stories/${it.code}/manifest/${it.code}-package.xml`, content: `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <version>62.0</version>\n</Package>\n` }]] as [string, Record<string, unknown>][])),
  ]);
  const victim = findSimStory(ctx.project, it.title);
  const summary = isBug
    ? `Fixed ${it.code}: added a guard in the affected class and a regression test that reproduces the reported steps.`
    : iteration > 1
      ? victim?.category === "integration"
        ? "Fixed QA findings: added a 10 s timeout, retries through the integration outbox and a clear message for the user; tests cover the failure path."
        : "Fixed QA findings: moved the query out of the loop and added a 200-record bulk test."
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
        notes: fail ? failing! : `Verified in the delivered source: the behaviour required by ${ref} is implemented${i === 0 ? " and covered by the test class" : ""}.`,
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
      : `1. Log in as the test user with the story's permission set.\n2. Create or open an AI-TEST record for ${it.code}.\n3. Perform the action described in ${label.split(":")[0]} and check the outcome.`;
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
        : { code: it.code, verdict: "approved", findings: "All checks verified. Code follows the standards (bulk-safe, sharing declared, errors logged)." },
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
      ? `- **force-app/main/default/classes/${name}Service.cls** — the callout endpoint is a string literal in Apex.\n  Expected: use the Named Credential from the solution design (\`callout:...\`), so every org points to its own system.`
      : `- **force-app/main/default/classes/${name}Service.cls** — failures are swallowed in an empty catch block.\n  Expected: log the error with the record ids and rethrow a meaningful exception, as the checklist requires.`
    : "Design fit, checklist and security verified: sharing declared, no SOQL/DML in loops, errors logged, tests assert real outcomes.";
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
      : `\n## ${it.title}\n${it.user_story.replace(/^As an? [^,]+, /, "").replace(/^I want( to)?/, "You can")}\n\n**Steps**\n1. Open the record in Salesforce.\n2. ${it.category === "reporting" ? "Open the dashboard from the Dashboards tab." : "Work as usual — the behaviour described below happens automatically."}\n3. Check the result described below.\n\n${acs}\n`;
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
    architect: "I'd decide declarative vs code first, then specify every object, field and automation in the tech spec.",
    planner: "I'd size it in story points, check its dependencies and slot it into the first sprint with capacity.",
    developer: "I'd implement it as bulk-safe SFDX source with a test class covering positive, negative and 200-record cases.",
    qa: "I'd plan one check per acceptance criterion and give a ✅/❌/⛔ verdict with evidence — never softening a failure.",
    writer: "I'd document it task-first for end users, and update the technical overview and changelog.",
    release: "I'd include it in the manifest, validate check-only, smoke test it and add it to the release notes.",
  };
  return `${flavour[agent.role] ?? "I'll look into it."}\n\nIf you want me to actually change something, use **Re-run with feedback** on the work item${project ? "" : " inside a project"}.`;
}
