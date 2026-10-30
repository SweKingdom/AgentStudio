/**
 * Salesforce CLI bridge for agents: read the org's schema and data, deploy a task's source (check-only or real), run
 * Apex tests and anonymous Apex for smoke tests.
 *
 * Safety: SiroccoARM never stores Salesforce credentials and never reads the CLI's list of authorised orgs. It only
 * passes the alias you registered (Settings → Salesforce orgs) to `sf -o <alias>`; the CLI uses its own login. Calls
 * happen in live mode only. Production orgs (a Trailhead Playground is one) must be explicitly allowed when registered,
 * and even then agents only validate against them (check-only) — real deploys happen in the release step. In simulation
 * nothing is sent to Salesforce.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { effectiveMode } from "./settings.js";
import { describeTarget, resolveTargetOrg, type TargetOrg } from "./salesforce.js";
import type { Project } from "./store.js";

const pexec = promisify(execFile);

/** The CLI binary (`ARM_SF_BIN` lets tests use a stand-in CLI). */
const sfBin = () => process.env.ARM_SF_BIN || "sf";

export type SfAccess = { live: true; org: TargetOrg } | { live: false; reason: string; org: TargetOrg | null };

/** Whether this project may talk to Salesforce right now, and which org: the environment a release run works on,
 *  else the build environment / the project's target org. */
export function sfAccess(project: Project, env?: { name: string; org: string | null } | null): SfAccess {
  const org = env ? (env.org ? describeTarget(env.org, "environment", env.name) : null) : resolveTargetOrg(project);
  if (project.mode === "simulation" || effectiveMode() === "simulation") {
    return { live: false, org, reason: `Simulation mode — nothing is sent to Salesforce${org ? ` (target org ${org.alias}${org.environment ? `, ${org.environment} environment` : ""})` : ""}.` };
  }
  if (!org) {
    const envs = project.settings.environments?.length;
    return { live: false, org: null, reason: env ? `No org is mapped to the ${env.name} environment (Project settings → Environments).` : envs ? "No org is mapped to the build environment (Project settings → Environments)." : "No target Salesforce org is set for this project (Project settings → Deploy to)." };
  }
  if (!org.selectable) {
    return { live: false, org, reason: `Refused: ${org.alias} is ${org.type === "unknown" ? "not a registered org" : "a production org that isn't allowed as a target (Settings → Salesforce orgs)"}.` };
  }
  return { live: true, org };
}

export interface SfJson {
  status: number;
  result?: any;
  message?: string;
  name?: string;
  data?: any;
}

/** Run `sf … --json` and parse its JSON even when the command exits non-zero (deploy failures do). */
export async function sf(args: string[], cwd?: string, timeoutMs = 35 * 60_000): Promise<SfJson> {
  let stdout = "";
  try {
    ({ stdout } = await pexec(sfBin(), [...args, "--json"], { cwd, timeout: timeoutMs, maxBuffer: 50_000_000, env: { ...process.env, SF_DISABLE_TELEMETRY: "true", SF_AUTOUPDATE_DISABLE: "true" } }));
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message?: string; code?: string };
    if (x.code === "ENOENT") throw new Error("The Salesforce CLI (sf) is not installed on this computer.");
    stdout = x.stdout ?? "";
    if (!stdout.trim()) throw new Error(`sf ${args.slice(0, 3).join(" ")} failed: ${(x.stderr || x.message || "").split("\n")[0]}`);
  }
  try {
    // The CLI can print warnings before the JSON document.
    return JSON.parse(stdout.slice(stdout.indexOf("{"))) as SfJson;
  } catch {
    throw new Error(`Unexpected output from sf ${args.slice(0, 3).join(" ")}: ${stdout.slice(0, 300)}`);
  }
}

const arr = <T>(x: T | T[] | undefined | null): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

// ---------------------------------------------------------------- schema & data

export async function describeObject(alias: string, sobject: string) {
  if (!/^[A-Za-z][\w]*$/.test(sobject)) throw new Error(`Invalid object name: ${sobject}`);
  const r = await sf(["sobject", "describe", "--sobject", sobject, "--target-org", alias]);
  if (r.status !== 0 || !r.result) throw new Error(r.message ?? `Could not describe ${sobject}`);
  const d = r.result;
  return {
    name: d.name,
    label: d.label,
    custom: !!d.custom,
    recordTypes: arr(d.recordTypeInfos).filter((t: any) => !t.master).map((t: any) => t.developerName ?? t.name),
    fields: arr(d.fields).map((f: any) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      ...(f.length ? { length: f.length } : {}),
      ...(arr(f.referenceTo).length ? { referenceTo: arr(f.referenceTo) } : {}),
      ...(f.nillable === false && f.createable ? { required: true } : {}),
      ...(f.custom ? { custom: true } : {}),
      ...(arr(f.picklistValues).length ? { picklist: arr(f.picklistValues).filter((v: any) => v.active !== false).map((v: any) => v.value).slice(0, 50) } : {}),
    })),
  };
}

/** Read-only SOQL: a single SELECT, no DML, at most 200 rows returned. */
export async function query(alias: string, soql: string) {
  const q = soql.trim().replace(/;+\s*$/, "");
  if (!/^select\s/i.test(q)) throw new Error("Only SELECT queries are allowed.");
  if (/;/.test(q)) throw new Error("One query at a time.");
  const r = await sf(["data", "query", "--query", q, "--target-org", alias]);
  if (r.status !== 0 || !r.result) throw new Error(r.message ?? "Query failed");
  const records = arr(r.result.records).map(({ attributes: _a, ...rest }: any) => rest);
  return { totalSize: r.result.totalSize ?? records.length, records: records.slice(0, 200), truncated: records.length > 200 };
}

// ---------------------------------------------------------------- deploy & tests

export interface DeployReport {
  ok: boolean;
  checkOnly: boolean;
  status: string;
  components: number;
  componentErrors: { file: string; line?: number; column?: number; type?: string; problem: string }[];
  tests: { run: number; failures: { name: string; method: string; message: string; stack?: string }[] };
  coverage: { name: string; percent: number }[];
  message?: string;
}

export function parseDeploy(r: SfJson, checkOnly: boolean): DeployReport {
  const res = r.result ?? r.data ?? {};
  const details = res.details ?? {};
  const rtr = details.runTestResult ?? {};
  const componentErrors = arr(details.componentFailures).map((f: any) => ({
    file: f.fileName ?? f.fullName ?? "?",
    line: f.lineNumber != null ? Number(f.lineNumber) : undefined,
    column: f.columnNumber != null ? Number(f.columnNumber) : undefined,
    type: f.componentType,
    problem: String(f.problem ?? f.error ?? "Unknown error"),
  }));
  const failures = arr(rtr.failures).map((f: any) => ({ name: f.name, method: f.methodName, message: String(f.message ?? ""), stack: f.stackTrace ?? undefined }));
  const coverage = arr(rtr.codeCoverage).map((c: any) => {
    const total = Number(c.numLocations) || 0;
    const missed = Number(c.numLocationsNotCovered) || 0;
    return { name: c.name, percent: total ? Math.round(((total - missed) / total) * 100) : 100 };
  });
  const status = String(res.status ?? (r.status === 0 ? "Succeeded" : "Failed"));
  const ok = r.status === 0 && res.success !== false && componentErrors.length === 0 && failures.length === 0;
  return {
    ok,
    checkOnly,
    status,
    components: Number(res.numberComponentsDeployed ?? res.numberComponentsTotal ?? 0),
    componentErrors,
    tests: { run: Number(rtr.numTestsRun ?? res.numberTestsCompleted ?? 0), failures },
    coverage,
    message: ok ? undefined : r.message,
  };
}

/** Deploy part of the workspace (a task's files) to the org: check-only by default, with the given test classes. */
export async function deploySource(o: { alias: string; cwd: string; paths: string[]; checkOnly: boolean; tests?: string[]; testLevel?: "RunSpecifiedTests" | "RunLocalTests" }): Promise<DeployReport> {
  if (!o.paths.length) throw new Error("Nothing to deploy: the task has no Salesforce metadata yet.");
  const args = ["project", "deploy", "start", "--target-org", o.alias, "--wait", "30"];
  for (const p of o.paths) args.push("--source-dir", p);
  if (o.checkOnly) args.push("--dry-run");
  if (o.testLevel === "RunLocalTests") {
    args.push("--test-level", "RunLocalTests");
  } else if (o.tests?.length) {
    args.push("--test-level", "RunSpecifiedTests");
    for (const t of o.tests) args.push("--tests", t);
  } else {
    args.push("--test-level", "NoTestRun");
  }
  return parseDeploy(await sf(args, o.cwd), o.checkOnly);
}

/** Anonymous Apex for smoke tests (sandboxes only — production is refused before this is ever called). */
export async function runAnonymousApex(alias: string, code: string) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arm-apex-")), "smoke.apex");
  fs.writeFileSync(file, code);
  try {
    const r = await sf(["apex", "run", "--file", file, "--target-org", alias]);
    const x = r.result ?? {};
    return {
      ok: r.status === 0 && x.success !== false && x.compiled !== false,
      compiled: x.compiled !== false,
      problem: x.compileProblem || x.exceptionMessage || r.message || null,
      stack: x.exceptionStackTrace || null,
      debug: String(x.logs ?? "").split("\n").filter((l: string) => l.includes("USER_DEBUG")).slice(0, 40).join("\n"),
    };
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

/** Human-readable deploy summary for agents and the activity feed. */
export function formatDeploy(d: DeployReport, where: string) {
  const lines = [`${d.checkOnly ? "Check-only deploy (validation)" : "Deploy"} to ${where}: ${d.ok ? "✅ Succeeded" : "❌ Failed"} · status ${d.status} · ${d.components} component(s) · ${d.tests.run} test(s) run`];
  if (d.componentErrors.length) {
    lines.push("", "Component errors:");
    for (const e of d.componentErrors.slice(0, 40)) lines.push(`- ${e.file}${e.line ? `:${e.line}${e.column ? `:${e.column}` : ""}` : ""}${e.type ? ` (${e.type})` : ""} — ${e.problem}`);
  }
  if (d.tests.failures.length) {
    lines.push("", "Test failures:");
    for (const f of d.tests.failures.slice(0, 40)) lines.push(`- ${f.name}.${f.method}: ${f.message}${f.stack ? `\n  ${f.stack.split("\n")[0]}` : ""}`);
  }
  if (d.coverage.length) lines.push("", `Coverage: ${d.coverage.map((c) => `${c.name} ${c.percent}%`).join(", ")}`);
  if (d.message) lines.push("", d.message);
  return lines.join("\n");
}
