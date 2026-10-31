/**
 * Team configuration that travels between machines: delivery conventions, the checks every story must pass, the
 * agents themselves and their custom knowledge — exported as one "team template" file and imported on another machine.
 *
 * What never travels: API keys, git credentials, spend limits and the simulation/live mode.
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

export interface CheckCommand {
  name: string;
  /** A terminal line run in the story's worktree, e.g. "npm test" or "make check". */
  command: string;
}

export interface ChecksSettings {
  /** Run in order on every story; empty = detect from package.json (typecheck, lint, test, build). */
  commands: CheckCommand[];
  timeoutMinutes: number;
  /** Installs the dependencies before the checks: "auto" (detected from the lockfile), "off", or a terminal line. */
  install: string;
}

export interface TeamSettings {
  conventions: Conventions;
  checks: ChecksSettings;
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
      "- Every acceptance criterion has a test that fails without the change",
      "- The project's checks pass (tests, build, typecheck, lint)",
      "- Inputs validated at the boundary; errors handled and shown to users in plain language",
      "- No hard-coded secrets, credentials or environment-specific URLs",
      "- No injection: queries parameterised, output escaped, shell arguments not built from input",
      "- Follows the existing code's structure, naming and style; no dead code",
      "- Docs and configuration updated for anything a user or operator sees",
    ].join("\n"),
    ado: { areaPath: "", iterationPrefix: "Sprint ", tags: "AgentStudio" },
  },
  checks: { commands: [], timeoutMinutes: 15, install: "auto" },
};

export function teamSettings(): TeamSettings {
  const s = getSetting<Partial<TeamSettings>>("team", {});
  return {
    conventions: { ...DEFAULT_TEAM.conventions, ...s.conventions, ado: { ...DEFAULT_TEAM.conventions.ado, ...s.conventions?.ado } },
    checks: { ...DEFAULT_TEAM.checks, ...s.checks },
  };
}

export function saveTeamSettings(patch: { conventions?: Partial<Conventions>; checks?: Partial<ChecksSettings> }) {
  const cur = teamSettings();
  const next: TeamSettings = {
    conventions: { ...cur.conventions, ...patch.conventions, ado: { ...cur.conventions.ado, ...patch.conventions?.ado } },
    checks: cleanChecks({ ...cur.checks, ...patch.checks }),
  };
  validateTeam(next);
  setSetting("team", next);
  return next;
}

function validateTeam(t: TeamSettings) {
  for (const p of [t.conventions.branchPattern, t.conventions.bugBranchPattern]) {
    if (!p.includes("{code}")) throw new Error("Branch patterns must contain {code} so every task gets its own branch");
    if (!/^[\w{}./-]+$/.test(p)) throw new Error(`Invalid characters in branch pattern ${p}`);
  }
}

function cleanChecks(o: Partial<ChecksSettings>): ChecksSettings {
  const raw = Array.isArray(o.commands) ? o.commands : [];
  const commands = raw
    .map((c) => ({ name: String(c?.name ?? "").trim(), command: String(c?.command ?? "").trim() }))
    .filter((c) => c.command);
  for (const c of commands) {
    if (!c.name) c.name = c.command.split(/\s+/).slice(0, 3).join(" ");
    if (c.command.length > 500 || /[\r\n]/.test(c.command)) throw new Error(`Check "${c.name}" must be one line of at most 500 characters.`);
  }
  if (commands.length > 10) throw new Error("At most 10 checks.");
  const timeoutMinutes = Number(o.timeoutMinutes ?? DEFAULT_TEAM.checks.timeoutMinutes);
  if (!(timeoutMinutes >= 1 && timeoutMinutes <= 120)) throw new Error("The check timeout must be between 1 and 120 minutes.");
  return { commands, timeoutMinutes, install: cleanInstall(o.install) || DEFAULT_TEAM.checks.install };
}

function cleanInstall(v: unknown) {
  const install = String(v ?? "").trim();
  if (install.length > 500 || /[\r\n]/.test(install)) throw new Error("The install command must be one line of at most 500 characters.");
  return install;
}

/** Validate a project's checks; an empty command list means "use the team default". */
export function cleanChecksOverride(o: Record<string, unknown> | null | undefined): Partial<ChecksSettings> {
  if (!o) return {};
  const out: Partial<ChecksSettings> = {};
  const clean = cleanChecks({ commands: o.commands as CheckCommand[], timeoutMinutes: (o.timeoutMinutes as number) || undefined });
  if (clean.commands.length) out.commands = clean.commands;
  if (o.timeoutMinutes) out.timeoutMinutes = clean.timeoutMinutes;
  const install = cleanInstall(o.install);
  if (install) out.install = install;
  return out;
}

/** The project's checks: team defaults with the project's own overrides. */
export function projectChecks(p: Pick<Project, "settings"> | null | undefined): ChecksSettings {
  const own = p?.settings.checks ?? {};
  const team = teamSettings().checks;
  return { commands: own.commands?.length ? own.commands : team.commands, timeoutMinutes: own.timeoutMinutes ?? team.timeoutMinutes, install: own.install || team.install || "auto" };
}

/** Fill {placeholders}; unknown ones are left as they are. */
export function fill(pattern: string, vars: Record<string, string | number | null | undefined>) {
  return pattern.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

// ---------------------------------------------------------------- team template (export / import)

/** Product decision (for now): no custom agents — the team is the built-in agents, which can be edited, reset and
 *  disabled. Imports update those agents and skip any other agent in the file. */
export const CUSTOM_AGENTS_ENABLED = false;

export const TEMPLATE_FORMAT = "agentstudio-team";
export const TEMPLATE_VERSION = 1;

type PortableAgent = Pick<Agent, "name" | "name_story" | "role" | "title" | "description" | "system_prompt" | "model" | "effort" | "color" | "icon" | "knowledge" | "custom_knowledge" | "tools" | "max_turns" | "enabled" | "config">;

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
    name: meta.name?.trim() || "AgentStudio team",
    description: meta.description?.trim() || "",
    exportedAt: new Date().toISOString(),
    agents: agents.map((a) => ({
      name: a.name, name_story: a.name_story, role: a.role, title: a.title, description: a.description, system_prompt: a.system_prompt, model: a.model, effort: a.effort,
      color: a.color, icon: a.icon, knowledge: a.knowledge, custom_knowledge: a.custom_knowledge, tools: a.tools, max_turns: a.max_turns, enabled: a.enabled, config: a.config ?? {},
    })),
    knowledge: listKnowledge().filter((k) => k.custom && usedCustom.has(k.id)).map(({ id, title, summary, content }) => ({ id, title, summary, content })),
    team: teamSettings(),
    defaults: {
      defaultGates: s.defaultGates, defaultParallelism: s.defaultParallelism, defaultBudgetUsd: s.defaultBudgetUsd, maxRework: s.maxRework,
      humanHourlyRateUsd: s.humanHourlyRateUsd, hoursPerStoryPoint: s.hoursPerStoryPoint, currency: s.currency, usdToEur: s.usdToEur, refusalFallback: s.refusalFallback,
    },
    models: models(),
    networkTemplates: customTemplates(),
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
  if (!x || x.format !== TEMPLATE_FORMAT) throw new Error("This isn't an AgentStudio team file.");
  if (x.version > TEMPLATE_VERSION) throw new Error(`This team file was made by a newer AgentStudio (format v${x.version}). Update this app first.`);
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
    const changes = AGENT_FIELDS.filter((f) => !same(cur[f], a[f]));
    return { name: a.name, role: a.role, action: changes.length ? ("update" as const) : ("unchanged" as const), changes: [...changes] };
  });
  const knowledge = (t.knowledge ?? []).map((k) => ({ id: k.id, title: k.title, action: known.has(k.id) ? ("update" as const) : ("create" as const) }));
  const cur = teamSettings();
  const settings = [
    !same(cur.conventions, { ...cur.conventions, ...t.team?.conventions }) ? "Team conventions" : "",
    !same(cur.checks, { ...cur.checks, ...t.team?.checks }) ? "Checks" : "",
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
