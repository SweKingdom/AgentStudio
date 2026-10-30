/**
 * Team configuration that travels between machines: delivery conventions, Salesforce defaults, the agents themselves
 * and their custom knowledge — exported as one "team template" file and imported on another machine.
 *
 * What never travels: API keys, Salesforce logins and the org registry (aliases only mean something on the machine
 * whose Salesforce CLI is logged in), git credentials, spend limits and the simulation/live mode.
 */
import { getSetting, setSetting } from "./db.js";
import { listAgents, createAgent, updateAgent, defaultAgentFor, type Agent } from "./agents/store.js";
import { ROLES, type Role } from "./agents/roles.js";
import { listKnowledge, saveCustomKnowledge } from "./knowledge.js";
import { appSettings, saveAppSettings, type AppSettings } from "./settings.js";
import { models, type ModelPrice } from "./pricing.js";
import type { Project } from "./store.js";
import { cleanTemplate, customTemplates, importTemplates, planTemplateImport, type NetworkTemplate } from "./templates.js";

export interface Conventions {
  /** Language every deliverable is written in (documents, stories, code comments, release notes). */
  language: string;
  /** Placeholders: {code} {slug} {type} {title} */
  branchPattern: string;
  bugBranchPattern: string;
  /** Placeholders: {code} {stage} {summary} {agent} */
  commitPattern: string;
  /** Placeholders: {branch} {code} {title} */
  mergePattern: string;
  /** Merge-commit body (the PR description). Placeholders: {code} {title} {summary} {components} {tests} {how_to_test} {branch} */
  prTemplate: string;
  /** QA reviews every story against this list. */
  reviewChecklist: string;
  /** Azure DevOps import defaults. */
  ado: { areaPath: string; iterationPrefix: string; tags: string };
}

export type TestLevel = "NoTestRun" | "RunSpecifiedTests" | "RunLocalTests" | "RunAllTestsInOrg";

export interface SalesforceSettings {
  apiVersion: string;
  /** Minimum Apex coverage per class the story changes; QA can't approve below it. */
  coverageMin: number;
  /** Managed-package namespace, if any (goes into sfdx-project.json). */
  namespace: string;
  /** Prefix for new custom objects, fields, classes and components, e.g. "SRC_" (empty = none). */
  prefix: string;
  /** Tests run when a developer validates a story in the org. */
  devTestLevel: Extract<TestLevel, "RunSpecifiedTests" | "RunLocalTests">;
}

export interface TeamSettings {
  conventions: Conventions;
  salesforce: SalesforceSettings;
}

export const DEFAULT_TEAM: TeamSettings = {
  conventions: {
    language: "English",
    branchPattern: "feature/{code}-{slug}",
    bugBranchPattern: "bugfix/{code}-{slug}",
    commitPattern: "{code}: {stage} — {summary}",
    mergePattern: "Merge {branch}: {code} {title}",
    prTemplate: "## {code} — {title}\n\n{summary}\n\n### Components\n{components}\n\n### Tests\n{tests}\n\n### How to test\n{how_to_test}",
    reviewChecklist: [
      "- Bulk-safe: no SOQL or DML inside loops; tested with 200 records",
      "- Sharing declared on every class (with sharing unless justified)",
      "- CRUD/FLS respected (WITH USER_MODE / Security.stripInaccessible)",
      "- No hard-coded IDs, URLs or credentials (Named Credentials, Custom Metadata)",
      "- Test classes: positive, negative and bulk cases with assertions",
      "- Errors handled and shown to users in plain language",
      "- Permission sets updated for every new field, object and class",
      "- Names follow the project prefix and naming standards",
    ].join("\n"),
    ado: { areaPath: "", iterationPrefix: "Sprint ", tags: "SiroccoARM" },
  },
  salesforce: { apiVersion: "62.0", coverageMin: 75, namespace: "", prefix: "", devTestLevel: "RunSpecifiedTests" },
};

export function teamSettings(): TeamSettings {
  const s = getSetting<Partial<TeamSettings>>("team", {});
  return {
    conventions: { ...DEFAULT_TEAM.conventions, ...s.conventions, ado: { ...DEFAULT_TEAM.conventions.ado, ...s.conventions?.ado } },
    salesforce: { ...DEFAULT_TEAM.salesforce, ...s.salesforce },
  };
}

export function saveTeamSettings(patch: { conventions?: Partial<Conventions>; salesforce?: Partial<SalesforceSettings> }) {
  const cur = teamSettings();
  const next: TeamSettings = {
    conventions: { ...cur.conventions, ...patch.conventions, ado: { ...cur.conventions.ado, ...patch.conventions?.ado } },
    salesforce: { ...cur.salesforce, ...patch.salesforce },
  };
  validateTeam(next);
  setSetting("team", next);
  return next;
}

function validateTeam(t: TeamSettings) {
  if (!/^\d{2}\.0$/.test(t.salesforce.apiVersion)) throw new Error("API version must look like 62.0");
  if (!(t.salesforce.coverageMin >= 0 && t.salesforce.coverageMin <= 100)) throw new Error("Coverage must be between 0 and 100");
  if (t.salesforce.namespace && !/^[A-Za-z][A-Za-z0-9]{0,14}$/.test(t.salesforce.namespace)) throw new Error("Invalid namespace");
  if (t.salesforce.prefix && !/^[A-Za-z][A-Za-z0-9_]{0,9}$/.test(t.salesforce.prefix)) throw new Error("Invalid prefix");
  for (const p of [t.conventions.branchPattern, t.conventions.bugBranchPattern]) {
    if (!p.includes("{code}")) throw new Error("Branch patterns must contain {code} so every task gets its own branch");
    if (!/^[\w{}./-]+$/.test(p)) throw new Error(`Invalid characters in branch pattern ${p}`);
  }
}

/** Validate a project's overrides of the team's Salesforce settings; empty values mean "use the team default". */
export function cleanSalesforceOverride(o: Record<string, unknown> | null | undefined): Partial<SalesforceSettings> {
  const out: Partial<SalesforceSettings> = {};
  if (!o) return out;
  if (o.apiVersion) out.apiVersion = String(o.apiVersion).trim();
  if (o.coverageMin !== undefined && o.coverageMin !== null && o.coverageMin !== "") out.coverageMin = Number(o.coverageMin);
  if (o.namespace !== undefined && o.namespace !== null && o.namespace !== "") out.namespace = String(o.namespace).trim();
  if (o.prefix !== undefined && o.prefix !== null && o.prefix !== "") out.prefix = String(o.prefix).trim();
  if (o.devTestLevel === "RunLocalTests" || o.devTestLevel === "RunSpecifiedTests") out.devTestLevel = o.devTestLevel;
  validateTeam({ conventions: DEFAULT_TEAM.conventions, salesforce: { ...DEFAULT_TEAM.salesforce, ...out } });
  return out;
}

/** The project's Salesforce settings: team defaults with the project's own overrides. */
export function projectSalesforce(p: Pick<Project, "settings"> | null | undefined): SalesforceSettings {
  return { ...teamSettings().salesforce, ...(p?.settings.salesforce ?? {}) } as SalesforceSettings;
}

/** Fill {placeholders}; unknown ones are left as they are. */
export function fill(pattern: string, vars: Record<string, string | number | null | undefined>) {
  return pattern.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

export function sfdxProjectJson(p: Pick<Project, "settings"> | null | undefined) {
  const sf = projectSalesforce(p);
  return JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], name: "workspace", namespace: sf.namespace, sourceApiVersion: sf.apiVersion }, null, 2) + "\n";
}

// ---------------------------------------------------------------- team template (export / import)

/** Product decision (for now): no custom agents — the team is the built-in agents, which can be edited, reset and
 *  disabled. Imports update those agents and skip any other agent in the file. */
export const CUSTOM_AGENTS_ENABLED = false;

export const TEMPLATE_FORMAT = "siroccoarm-team";
export const TEMPLATE_VERSION = 1;

type PortableAgent = Pick<Agent, "name" | "name_story" | "role" | "title" | "description" | "system_prompt" | "model" | "effort" | "color" | "icon" | "knowledge" | "custom_knowledge" | "tools" | "max_turns" | "enabled"> & {
  config: Omit<Agent["config"], "targetOrg">;
};

export interface TeamTemplate {
  format: typeof TEMPLATE_FORMAT;
  version: number;
  name: string;
  description: string;
  exportedAt: string;
  agents: PortableAgent[];
  knowledge: { id: string; title: string; summary: string; content: string }[];
  team: TeamSettings;
  defaults: Pick<AppSettings, "defaultGates" | "defaultParallelism" | "defaultBudgetUsd" | "maxRework" | "humanHourlyRateUsd" | "hoursPerStoryPoint" | "currency" | "usdToEur" | "refusalFallback">;
  models: ModelPrice[];
  /** Custom agent-network templates (optional; environment slots never carry org aliases). Added within format v1. */
  networkTemplates?: NetworkTemplate[];
}

export function exportTeam(meta: { name?: string; description?: string } = {}): TeamTemplate {
  const s = appSettings();
  const agents = listAgents();
  const usedCustom = new Set(agents.flatMap((a) => a.knowledge));
  return {
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    name: meta.name?.trim() || "SiroccoARM team",
    description: meta.description?.trim() || "",
    exportedAt: new Date().toISOString(),
    agents: agents.map((a) => {
      // Org aliases are machine-specific: they never travel.
      const { targetOrg: _t, ...config } = a.config ?? {};
      return {
        name: a.name, name_story: a.name_story, role: a.role, title: a.title, description: a.description, system_prompt: a.system_prompt, model: a.model, effort: a.effort,
        color: a.color, icon: a.icon, knowledge: a.knowledge, custom_knowledge: a.custom_knowledge, tools: a.tools, max_turns: a.max_turns, enabled: a.enabled, config,
      };
    }),
    knowledge: listKnowledge().filter((k) => k.custom && usedCustom.has(k.id)).map(({ id, title, summary, content }) => ({ id, title, summary, content })),
    team: teamSettings(),
    defaults: {
      defaultGates: s.defaultGates, defaultParallelism: s.defaultParallelism, defaultBudgetUsd: s.defaultBudgetUsd, maxRework: s.maxRework,
      humanHourlyRateUsd: s.humanHourlyRateUsd, hoursPerStoryPoint: s.hoursPerStoryPoint, currency: s.currency, usdToEur: s.usdToEur, refusalFallback: s.refusalFallback,
    },
    models: models(),
    networkTemplates: customTemplates().map((t) => ({ ...t, environments: t.environments.map((e) => ({ ...e, org: null })) })),
  };
}

export interface ImportPlan {
  agents: { name: string; role: string; action: "create" | "update" | "unchanged" | "skip"; changes: string[] }[];
  knowledge: { id: string; title: string; action: "create" | "update" }[];
  settings: string[];
  warnings: string[];
  /** Custom network templates in the file (matched by name). */
  templates?: { name: string; action: "create" | "update" }[];
}

const AGENT_FIELDS = ["name_story", "title", "description", "system_prompt", "model", "effort", "color", "icon", "knowledge", "custom_knowledge", "tools", "max_turns", "enabled", "config"] as const;

function checkTemplate(t: unknown): TeamTemplate {
  const x = t as TeamTemplate;
  if (!x || x.format !== TEMPLATE_FORMAT) throw new Error("This isn't a SiroccoARM team file.");
  if (x.version > TEMPLATE_VERSION) throw new Error(`This team file was made by a newer SiroccoARM (format v${x.version}). Update this app first.`);
  if (!Array.isArray(x.agents) || !x.agents.length) throw new Error("The team file has no agents.");
  for (const a of x.agents) {
    if (!a.name || !ROLES[a.role as Role]) throw new Error(`Agent "${a.name ?? "?"}" has an unknown role (${a.role}).`);
  }
  for (const k of x.knowledge ?? []) {
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(String(k.id))) throw new Error(`Invalid knowledge pack id "${k.id}".`);
  }
  if (x.networkTemplates !== undefined && !Array.isArray(x.networkTemplates)) throw new Error("networkTemplates must be a list.");
  // Fail before anything is applied, not halfway through the import.
  for (const nt of x.networkTemplates ?? []) {
    try {
      cleanTemplate(nt, "check");
    } catch (e) {
      throw new Error(`Network template "${(nt as { name?: string })?.name ?? "?"}": ${e instanceof Error ? e.message : e}`);
    }
  }
  return x;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What importing would change — shown before anything is applied. Agents match by role + name. */
export function planImport(raw: unknown): ImportPlan {
  const t = checkTemplate(raw);
  const existing = listAgents();
  const known = new Set(listKnowledge().map((k) => k.id));
  const modelIds = new Set([...models(), ...(t.models ?? [])].map((m) => m.id));
  const warnings: string[] = [];
  const agents = t.agents.map((a) => {
    const cur = existing.find((e) => e.role === a.role && e.name.toLowerCase() === a.name.toLowerCase());
    if (!modelIds.has(a.model)) warnings.push(`${a.name} uses ${a.model}, which has no price on this machine.`);
    for (const k of a.knowledge) if (!known.has(k) && !t.knowledge?.some((x) => x.id === k)) warnings.push(`${a.name} uses knowledge pack "${k}", which isn't included or installed.`);
    if (!cur) {
      if (!CUSTOM_AGENTS_ENABLED) {
        warnings.push(`${a.name} (${a.role}) isn't one of this team's agents and will be skipped — custom agents are turned off.`);
        return { name: a.name, role: a.role, action: "skip" as const, changes: [] };
      }
      return { name: a.name, role: a.role, action: "create" as const, changes: [] };
    }
    const changes = AGENT_FIELDS.filter((f) => f !== "config" ? !same(cur[f], a[f]) : !same({ ...cur.config, targetOrg: undefined }, { ...a.config, targetOrg: undefined }));
    return { name: a.name, role: a.role, action: changes.length ? ("update" as const) : ("unchanged" as const), changes: [...changes] };
  });
  const knowledge = (t.knowledge ?? []).map((k) => ({ id: k.id, title: k.title, action: known.has(k.id) ? ("update" as const) : ("create" as const) }));
  const cur = teamSettings();
  const settings = [
    !same(cur.conventions, { ...cur.conventions, ...t.team?.conventions }) ? "Team conventions" : "",
    !same(cur.salesforce, { ...cur.salesforce, ...t.team?.salesforce }) ? "Salesforce settings" : "",
    t.defaults ? "Project defaults" : "",
    t.models?.length ? "Model prices" : "",
  ].filter(Boolean);
  const templates = Array.isArray(t.networkTemplates) ? planTemplateImport(t.networkTemplates) : [];
  if (templates.length) settings.push(`Network templates (${templates.length})`);
  return { agents, knowledge, settings, warnings, ...(templates.length ? { templates } : {}) };
}

/** Apply a team file. Existing agents (same role + name) get a new version — restorable from their history. */
export function applyImport(raw: unknown) {
  const t = checkTemplate(raw);
  const plan = planImport(t);
  for (const k of t.knowledge ?? []) saveCustomKnowledge({ id: k.id, title: k.title, summary: k.summary ?? "", content: k.content });
  const existing = listAgents();
  for (const a of t.agents) {
    const cur = existing.find((e) => e.role === a.role && e.name.toLowerCase() === a.name.toLowerCase());
    const patch: Partial<Agent> = {};
    for (const f of AGENT_FIELDS) (patch as Record<string, unknown>)[f] = a[f];
    if (cur) {
      // Keep this machine's org choice on the agent.
      patch.config = { ...a.config, ...(cur.config?.targetOrg ? { targetOrg: cur.config.targetOrg } : {}) };
      updateAgent(cur.id, patch, `Imported from team file "${t.name}"`);
    } else if (CUSTOM_AGENTS_ENABLED) {
      createAgent(defaultAgentFor(a.role as Role, { ...patch, name: a.name } as Partial<Agent>));
    }
  }
  if (t.team) saveTeamSettings(t.team);
  if (t.defaults) saveAppSettings(t.defaults);
  if (t.models?.length) setSetting("models", t.models);
  if (Array.isArray(t.networkTemplates) && t.networkTemplates.length) importTemplates(t.networkTemplates);
  return plan;
}
