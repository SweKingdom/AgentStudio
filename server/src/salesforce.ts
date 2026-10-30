import { getSetting, setSetting } from "./db.js";
import { listAgents, updateAgent, type Agent } from "./agents/store.js";
import { listProjects, patchProject, type Project } from "./store.js";

export type OrgType = "sandbox" | "scratch" | "developer" | "production";

/** A registered deploy target. Holds no credentials — only what identifies the org. */
export interface SfOrg {
  alias: string;
  username: string | null;
  type: OrgType;
  instanceUrl: string | null;
  status: string | null;
  manual: boolean;
  /** Production orgs (a Trailhead Playground is one) are targets only when you allowed it when registering them. */
  allowProduction?: boolean;
  selectable: boolean;
}

export function isSelectable(type: OrgType, allowProduction = false) {
  return type !== "production" || allowProduction;
}

/**
 * The org registry is manual on purpose: SiroccoARM never reads the Salesforce CLI's authorised orgs or any stored
 * credentials. You register a target by alias, type and URL; nothing else is stored.
 */
export function listOrgs(): { orgs: SfOrg[] } {
  const rank: Record<OrgType, number> = { sandbox: 0, scratch: 1, developer: 2, production: 3 };
  const orgs = getSetting<SfOrg[]>("sfManualOrgs", []).map((o) => ({ ...o, manual: true, selectable: isSelectable(o.type, o.allowProduction) }));
  return { orgs: orgs.sort((x, y) => rank[x.type] - rank[y.type] || x.alias.localeCompare(y.alias)) };
}

export function addManualOrg(o: { alias: string; type: OrgType; instanceUrl?: string | null; allowProduction?: boolean }) {
  const alias = o.alias.trim();
  if (!alias) throw new Error("Alias is required");
  if (!/^[\w.@ -]+$/.test(alias)) throw new Error("The alias can only contain letters, digits, spaces and . _ - @");
  const allowProduction = o.type === "production" && o.allowProduction === true;
  const list = getSetting<SfOrg[]>("sfManualOrgs", []).filter((x) => x.alias !== alias);
  list.push({ alias, username: null, type: o.type, instanceUrl: o.instanceUrl?.trim() || null, status: null, manual: true, allowProduction, selectable: isSelectable(o.type, allowProduction) });
  setSetting("sfManualOrgs", list);
}

/** Allow (or stop allowing) a registered production org as a target — e.g. a Trailhead Playground for a demo. */
export function setAllowProduction(alias: string, allow: boolean) {
  const list = getSetting<SfOrg[]>("sfManualOrgs", []);
  const org = list.find((x) => x.alias === alias);
  if (!org) throw new Error(`Org ${alias} is not registered`);
  if (org.type !== "production") throw new Error("Only production orgs need to be allowed.");
  org.allowProduction = allow;
  org.selectable = isSelectable(org.type, allow);
  setSetting("sfManualOrgs", list);
}

/** The URL to log in through: the org's My Domain (a Lightning URL like …lightning.force.com/lightning/page/home
 *  becomes …my.salesforce.com), else the standard login host for its type. */
export function loginUrlFor(org: Pick<SfOrg, "instanceUrl" | "type">) {
  const fallback = org.type === "sandbox" ? "https://test.salesforce.com" : "https://login.salesforce.com";
  if (!org.instanceUrl) return fallback;
  try {
    const u = new URL(org.instanceUrl.trim());
    if (u.protocol !== "https:") return fallback;
    const host = u.hostname
      .replace(/\.lightning\.force\.com$/i, ".my.salesforce.com")
      .replace(/\.my\.site\.com$/i, ".my.salesforce.com")
      .replace(/\.visualforce\.com$/i, ".my.salesforce.com");
    if (!/\.(salesforce|force)\.com$/i.test(host)) return fallback;
    return `https://${host}`;
  } catch {
    return fallback;
  }
}

/** Removes an org and every reference to it (release agents' default, projects' override). */
export function removeManualOrg(alias: string) {
  setSetting("sfManualOrgs", getSetting<SfOrg[]>("sfManualOrgs", []).filter((x) => x.alias !== alias));
  const cleared: string[] = [];
  for (const a of listAgents().filter((x) => x.config?.targetOrg === alias)) {
    const { targetOrg: _t, ...rest } = a.config;
    updateAgent(a.id, { config: rest }, `Target org ${alias} removed`);
    cleared.push(a.name);
  }
  for (const p of listProjects().filter((x) => x.settings.targetOrg === alias || x.settings.environments?.some((e) => e.org === alias))) {
    const environments = p.settings.environments?.map((e) => (e.org === alias ? { ...e, org: null } : e));
    patchProject(p.id, { settings: { ...p.settings, targetOrg: p.settings.targetOrg === alias ? null : p.settings.targetOrg, ...(environments ? { environments } : {}) } });
    cleared.push(p.key);
  }
  return cleared;
}

export interface TargetOrg {
  alias: string;
  type: OrgType | "unknown";
  allowProduction?: boolean;
  instanceUrl: string | null;
  source: "project" | "agent" | "environment";
  /** The environment's name when `source` is "environment". */
  environment?: string;
  selectable: boolean;
}

/** What the registry knows about an alias (unknown aliases are never selectable). */
export function describeTarget(alias: string, source: TargetOrg["source"], environment?: string): TargetOrg {
  const org = listOrgs().orgs.find((o) => o.alias === alias || o.username === alias);
  return {
    alias,
    type: org?.type ?? "unknown",
    allowProduction: org?.allowProduction ?? false,
    instanceUrl: org?.instanceUrl ?? null,
    source,
    ...(environment ? { environment } : {}),
    selectable: org ? org.selectable : false,
  };
}

/** Where a project builds and deploys: with environments, the build environment's org (stories are developed and
 *  tested there); otherwise the project's override, else the release agent's default. Empty by default. */
export function resolveTargetOrg(project: Pick<Project, "settings" | "agent_ids">, releaseAgent?: Agent): TargetOrg | null {
  const build = project.settings.environments?.find((e) => e.purpose === "build");
  if (build) return build.org ? describeTarget(build.org, "environment", build.name) : null;
  const agent = releaseAgent ?? listAgents().find((a) => a.role === "release" && project.agent_ids.includes(a.id));
  const pick = project.settings.targetOrg
    ? { alias: project.settings.targetOrg, source: "project" as const }
    : agent?.config?.targetOrg
      ? { alias: agent.config.targetOrg, source: "agent" as const }
      : null;
  return pick ? describeTarget(pick.alias, pick.source) : null;
}
