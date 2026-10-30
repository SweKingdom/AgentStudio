/**
 * Salesforce environments per project: an ordered chain such as Test (build) → UAT (stage) → Production.
 *
 * - The **build** environment is where stories are developed, validated and peer-tested (dev/QA tools use its org).
 * - The release walks the **stage** and **production** environments in order: validate (and deploy when the
 *   environment says so), smoke test, and pause first for the human where `approval` is on. A production environment
 *   that deploys gets a check-only validation before the approval and the deploy of that validated release after it.
 * - Release notes and the git tag are published once, after the last environment.
 *
 * Projects without environments keep the single target org and single release step. Orgs are aliases only — no
 * credentials are ever stored (see salesforce.ts).
 */
import { listOrgs } from "./salesforce.js";
import type { StageState } from "./store.js";
import type { TestLevel } from "./team.js";

export type EnvPurpose = "build" | "stage" | "production";
export type DeployMode = "validate" | "deploy";

export interface Environment {
  /** Short stable id used in stage keys (`release:uat`). */
  key: string;
  name: string;
  purpose: EnvPurpose;
  /** Registered org alias, or null (static validation only / slot of a template). */
  org: string | null;
  deployMode: DeployMode;
  testLevel: TestLevel;
  /** Pause for the human before this environment (a gate). */
  approval: boolean;
}

/** The environment a release-agent run is working on (passed through RunOptions → ToolContext). */
export interface ReleaseEnvironment extends Environment {
  /** "validate": check-only before the approval (production); "deploy": the environment's normal step. */
  phase: "validate" | "deploy";
  /** The last step of the chain: this run publishes the release notes and tag. */
  final: boolean;
  index: number;
  total: number;
}

export const ENV_PURPOSES: EnvPurpose[] = ["build", "stage", "production"];
const TEST_LEVELS: TestLevel[] = ["NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg"];
const MAX_ENVIRONMENTS = 8;

export function envKeyFrom(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "env";
}

type Settings = { environments?: Environment[] | null } | null | undefined;

export function environmentsOf(settings: Settings): Environment[] {
  return Array.isArray(settings?.environments) ? settings!.environments! : [];
}

export function usesEnvironments(settings: Settings) {
  return environmentsOf(settings).length > 0;
}

export function buildEnvironment(settings: Settings) {
  return environmentsOf(settings).find((e) => e.purpose === "build");
}

/** Environments the release walks, in order. With only a build environment, the release goes there. */
export function releaseEnvironments(settings: Settings): Environment[] {
  const envs = environmentsOf(settings);
  const rel = envs.filter((e) => e.purpose !== "build");
  return rel.length ? rel : envs.filter((e) => e.purpose === "build");
}

/** Production deploys are validated check-only first; the deploy of that validated release follows the approval. */
function twoStep(e: Environment) {
  return e.purpose === "production" && e.approval && e.deployMode === "deploy";
}

/**
 * Validate environments sent by the web (project create/PATCH, templates).
 * - `undefined`/`null` → undefined (leave the project as it is); `[]` → no environments (legacy single release).
 * - keys unique, purposes known, at most one build environment (first) and at most one production (last).
 * - `requireOrgs`: orgs must be registered and selectable — an org kept unchanged from `previous` is accepted even if
 *   its registration changed since (it's re-checked when the release runs). Templates pass `slots: true` (orgs dropped).
 */
export function cleanEnvironments(raw: unknown, opts: { previous?: Environment[] | null; slots?: boolean } = {}): Environment[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("Environments must be a list.");
  if (raw.length > MAX_ENVIRONMENTS) throw new Error(`At most ${MAX_ENVIRONMENTS} environments.`);
  const orgs = opts.slots ? [] : listOrgs().orgs;
  const out: Environment[] = [];
  for (const [i, r] of raw.entries()) {
    const x = (r ?? {}) as Record<string, unknown>;
    const name = String(x.name ?? "").trim();
    if (!name) throw new Error(`Environment ${i + 1} needs a name.`);
    if (name.length > 40) throw new Error(`Environment name "${name.slice(0, 20)}…" is too long (40 characters max).`);
    const key = x.key ? String(x.key).trim().toLowerCase() : envKeyFrom(name);
    if (!/^[a-z][a-z0-9_-]{0,19}$/.test(key)) throw new Error(`Invalid environment key "${key}" — use lowercase letters, digits, - or _ (max 20).`);
    if (out.some((e) => e.key === key)) throw new Error(`Two environments use the key "${key}".`);
    const purpose = String(x.purpose ?? "stage") as EnvPurpose;
    if (!ENV_PURPOSES.includes(purpose)) throw new Error(`Environment ${name}: purpose must be build, stage or production.`);
    const deployMode: DeployMode = x.deployMode === "deploy" ? "deploy" : x.deployMode === undefined || x.deployMode === "validate" ? "validate" : (() => { throw new Error(`Environment ${name}: deploy mode must be validate or deploy.`); })();
    const testLevel = (x.testLevel ?? "RunLocalTests") as TestLevel;
    if (!TEST_LEVELS.includes(testLevel)) throw new Error(`Environment ${name}: unknown test level ${String(x.testLevel)}.`);
    const approval = typeof x.approval === "boolean" ? x.approval : purpose === "production";
    let org: string | null = opts.slots || !x.org ? null : String(x.org).trim() || null;
    if (org) {
      const kept = opts.previous?.some((p) => p.key === key && p.org === org);
      const reg = orgs.find((o) => o.alias === org);
      if (!kept && !reg) throw new Error(`Environment ${name}: org ${org} is not registered (Settings → Salesforce orgs).`);
      if (!kept && reg && !reg.selectable) throw new Error(`Environment ${name}: ${org} is a production org that isn't allowed as a target (Settings → Salesforce orgs).`);
    }
    out.push({ key, name, purpose, org, deployMode, testLevel, approval });
  }
  const builds = out.filter((e) => e.purpose === "build");
  if (builds.length > 1) throw new Error("Only one build environment — it's where stories are developed and tested.");
  if (builds.length && out[0].purpose !== "build") throw new Error("The build environment comes first: stories are built there before any release.");
  const prods = out.filter((e) => e.purpose === "production");
  if (prods.length > 1) throw new Error("Only one production environment.");
  if (prods.length && out[out.length - 1].purpose !== "production") throw new Error("Production comes last in the chain.");
  return out;
}

/** The release part of the pipeline for a project with environments (replaces approve_release + release). */
export function environmentStages(settings: Settings, present: boolean): StageState[] {
  const envs = releaseEnvironments(settings);
  const st = (key: string, label: string, gate = false): StageState => ({ key, role: gate ? "human" : "release", label, gate, status: present ? "pending" : "skipped" });
  return envs.flatMap((e, i) => {
    const last = i === envs.length - 1;
    const steps: StageState[] = [];
    if (twoStep(e)) steps.push(st(`validate:${e.key}`, `Validate · ${e.name}`));
    if (e.approval) steps.push(st(`approve:${e.key}`, `Approve ${e.name}`, true));
    steps.push(st(`release:${e.key}`, `${e.deployMode === "deploy" ? "Deploy" : "Validate"} · ${e.name}${last ? " · Release" : ""}`));
    return steps;
  });
}

export function parseEnvStage(key: string): { kind: "validate" | "approve" | "release"; envKey: string } | null {
  const m = /^(validate|approve|release):(.+)$/.exec(key);
  return m ? { kind: m[1] as "validate" | "approve" | "release", envKey: m[2] } : null;
}

/** The environment step a stage key stands for, or null (not an environment stage / environment removed). */
export function envStep(settings: Settings, key: string): ReleaseEnvironment | null {
  const m = parseEnvStage(key);
  if (!m || m.kind === "approve") return null;
  const envs = releaseEnvironments(settings);
  const index = envs.findIndex((e) => e.key === m.envKey);
  if (index < 0) return null;
  return { ...envs[index], phase: m.kind === "validate" ? "validate" : "deploy", final: index === envs.length - 1 && m.kind === "release", index, total: envs.length };
}

