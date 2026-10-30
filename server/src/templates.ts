/**
 * Agent-network templates: reusable project setups — which roles are on the team, the run settings and the
 * environment chain (slots without orgs: aliases only mean something on one machine, and each project maps its own).
 *
 * Built-in templates are read-only; custom ones live in the settings table under `networkTemplates` and travel in the
 * team template file (team.ts).
 */
import { getSetting, setSetting, uid } from "./db.js";
import { listAgents } from "./agents/store.js";
import { PIPELINE_ROLES, type Role } from "./agents/roles.js";
import { cleanEnvironments, type Environment } from "./environments.js";
import type { Project } from "./store.js";

export interface TemplateSettings {
  gates: boolean;
  parallelism: number;
  maxRework: number;
  budgetUsd: number;
}

export interface NetworkTemplate {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  /** Pipeline roles on the team; creating a project from the template selects the enabled agents with these roles. */
  roles: Role[];
  settings: TemplateSettings;
  /** Environment slots — `org` is always null here; the project maps each slot to an org. */
  environments: Environment[];
}

const KEY = "networkTemplates";

const env = (key: string, name: string, purpose: Environment["purpose"], approval: boolean, deployMode: Environment["deployMode"] = "deploy"): Environment => ({
  key,
  name,
  purpose,
  org: null,
  deployMode,
  testLevel: "RunLocalTests",
  approval,
});

export const BUILTIN_TEMPLATES: NetworkTemplate[] = [
  {
    id: "builtin-full",
    name: "Full Salesforce delivery",
    description: "The whole team from requirements to release: built and tested on Test, deployed to UAT after your approval, then to Production after your approval.",
    builtin: true,
    roles: ["requirements", "architect", "planner", "developer", "qa", "writer", "release"],
    settings: { gates: true, parallelism: 2, maxRework: 2, budgetUsd: 50 },
    environments: [env("test", "Test", "build", false), env("uat", "UAT", "stage", true), env("prod", "Production", "production", true)],
  },
  {
    id: "builtin-small",
    name: "Small change",
    description: "Developer, QA and release manager for a small, well-understood change: built on Test, deployed to Production after your approval.",
    builtin: true,
    roles: ["developer", "qa", "release"],
    settings: { gates: false, parallelism: 1, maxRework: 2, budgetUsd: 15 },
    environments: [env("test", "Test", "build", false), env("prod", "Production", "production", true)],
  },
  {
    id: "builtin-analysis",
    name: "Analysis & estimate only",
    description: "Analyst, architect and planner: backlog, technical refinement and a delivery plan with estimates. Nothing is built or deployed — the pipeline stops after planning.",
    builtin: true,
    roles: ["requirements", "architect", "planner"],
    settings: { gates: true, parallelism: 2, maxRework: 2, budgetUsd: 20 },
    environments: [],
  },
  {
    id: "builtin-migration",
    name: "Data migration",
    description: "Analyst, architect, developer, QA and release manager for a data migration: rehearsed on Test, run on Production after your approval.",
    builtin: true,
    roles: ["requirements", "architect", "developer", "qa", "release"],
    settings: { gates: true, parallelism: 1, maxRework: 2, budgetUsd: 40 },
    environments: [env("test", "Test", "build", false), env("prod", "Production", "production", true)],
  },
];

export function customTemplates(): NetworkTemplate[] {
  return getSetting<NetworkTemplate[]>(KEY, []).map((t) => ({ ...t, builtin: false }));
}

export function listTemplates(): NetworkTemplate[] {
  return [...BUILTIN_TEMPLATES, ...customTemplates()];
}

export function getTemplate(id: string) {
  return listTemplates().find((t) => t.id === id);
}

const num = (v: unknown, fallback: number, min: number, max: number, what: string) => {
  const n = v === undefined || v === null || v === "" ? fallback : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${what} must be between ${min} and ${max}.`);
  return n;
};

/** Validate a template sent by the web or found in a team file. Orgs are always dropped. */
export function cleanTemplate(raw: unknown, id: string): NetworkTemplate {
  const x = (raw ?? {}) as Record<string, any>;
  const name = String(x.name ?? "").trim();
  if (!name) throw new Error("The template needs a name.");
  if (name.length > 60) throw new Error("Template names are at most 60 characters.");
  const roles = [...new Set(Array.isArray(x.roles) ? x.roles.map(String) : [])] as Role[];
  if (!roles.length) throw new Error("A template needs at least one role.");
  const unknown = roles.filter((r) => !PIPELINE_ROLES.includes(r));
  if (unknown.length) throw new Error(`Unknown role(s): ${unknown.join(", ")}.`);
  const s = (x.settings ?? {}) as Record<string, unknown>;
  return {
    id,
    name,
    description: String(x.description ?? "").trim().slice(0, 500),
    builtin: false,
    roles: PIPELINE_ROLES.filter((r) => roles.includes(r)),
    settings: {
      gates: s.gates === undefined ? true : s.gates === true,
      parallelism: num(s.parallelism, 2, 1, 8, "Parallel lanes"),
      maxRework: num(s.maxRework, 2, 0, 5, "Max QA rework"),
      budgetUsd: num(s.budgetUsd, 50, 0, 100_000, "Budget"),
    },
    environments: cleanEnvironments(x.environments ?? [], { slots: true }) ?? [],
  };
}

function checkName(name: string, exceptId?: string) {
  if (listTemplates().some((t) => t.id !== exceptId && t.name.toLowerCase() === name.toLowerCase())) throw new Error(`A template named "${name}" already exists.`);
}

export function createTemplate(raw: unknown): NetworkTemplate {
  const t = cleanTemplate(raw, uid("tpl"));
  checkName(t.name);
  setSetting(KEY, [...customTemplates(), t]);
  return t;
}

export function updateTemplate(id: string, raw: unknown): NetworkTemplate {
  if (BUILTIN_TEMPLATES.some((t) => t.id === id)) throw new Error("Built-in templates can't be changed — save a copy instead.");
  const list = customTemplates();
  const at = list.findIndex((t) => t.id === id);
  if (at < 0) throw new Error("Template not found");
  const t = cleanTemplate({ ...list[at], ...(raw as object) }, id);
  checkName(t.name, id);
  list[at] = t;
  setSetting(KEY, list);
  return t;
}

export function deleteTemplate(id: string) {
  if (BUILTIN_TEMPLATES.some((t) => t.id === id)) throw new Error("Built-in templates can't be deleted.");
  const list = customTemplates();
  if (!list.some((t) => t.id === id)) throw new Error("Template not found");
  setSetting(KEY, list.filter((t) => t.id !== id));
}

/** "Save as template": the project's team roles, run settings and environment slots (orgs left out). */
export function templateFromProject(p: Project, meta: { name?: string; description?: string }) {
  const agents = listAgents();
  const roles = [...new Set(p.agent_ids.map((id) => agents.find((a) => a.id === id)?.role).filter((r): r is Role => Boolean(r && PIPELINE_ROLES.includes(r))))];
  return createTemplate({
    name: meta.name?.trim() || `${p.name} setup`,
    description: meta.description ?? `Saved from project ${p.key}.`,
    roles,
    settings: { gates: p.settings.gates, parallelism: p.settings.parallelism, maxRework: p.settings.maxRework, budgetUsd: p.settings.budgetUsd },
    environments: (p.settings.environments ?? []).map((e) => ({ ...e, org: null })),
  });
}

/** What creating a project from the template pre-selects: enabled agents by role, settings and environment slots. */
export function resolveTemplate(id: string) {
  const t = getTemplate(id);
  if (!t) throw new Error("Template not found");
  const agents = listAgents().filter((a) => a.enabled && t.roles.includes(a.role));
  const missingRoles = t.roles.filter((r) => !agents.some((a) => a.role === r));
  return { template: t, agentIds: agents.map((a) => a.id), missingRoles, settings: t.settings, environments: t.environments };
}

/** Team-file import: custom templates are matched by name (case-insensitive) and replaced, or added. */
export function importTemplates(raw: unknown[]): { created: string[]; updated: string[] } {
  const list = customTemplates();
  const created: string[] = [];
  const updated: string[] = [];
  for (const r of raw) {
    const name = String((r as { name?: unknown })?.name ?? "").trim().toLowerCase();
    if (BUILTIN_TEMPLATES.some((b) => b.name.toLowerCase() === name)) continue;
    const at = list.findIndex((t) => t.name.toLowerCase() === name);
    const t = cleanTemplate(r, at >= 0 ? list[at].id : uid("tpl"));
    if (at >= 0) {
      list[at] = t;
      updated.push(t.name);
    } else {
      list.push(t);
      created.push(t.name);
    }
  }
  setSetting(KEY, list);
  return { created, updated };
}

/** Preview for the team-file import (no changes). */
export function planTemplateImport(raw: unknown[]): { name: string; action: "create" | "update" }[] {
  const list = customTemplates();
  return raw
    .map((r) => String((r as { name?: unknown })?.name ?? "").trim())
    .filter((name) => name && !BUILTIN_TEMPLATES.some((b) => b.name.toLowerCase() === name.toLowerCase()))
    .map((name) => ({ name, action: list.some((t) => t.name.toLowerCase() === name.toLowerCase()) ? ("update" as const) : ("create" as const) }));
}
