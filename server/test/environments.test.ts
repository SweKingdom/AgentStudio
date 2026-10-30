import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { api as apiRouter } from "../src/api.ts";
import { registerTemplates } from "../src/routes/templates.ts";
import { all } from "../src/db.ts";
import { addManualOrg } from "../src/salesforce.ts";
import { sfAccess } from "../src/sf.ts";
import { buildStages } from "../src/orchestrator.ts";
import { cleanEnvironments } from "../src/environments.ts";
import { exportTeam, planImport, applyImport } from "../src/team.ts";
import { validateWorkspace } from "../src/agents/tools.ts";
import { envStep } from "../src/environments.ts";
import { saveAppSettings } from "../src/settings.ts";
import { TMP } from "./setup.ts";
import { getProject, patchProject } from "../src/store.ts";

let server: Server;
let base = "";

async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function waitFor(pred: () => Promise<boolean>, what: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const DESCRIPTION =
  "Service agents must create a case from an email automatically. Dispatchers must assign cases to a team by region. Managers need a weekly report of open cases per team.";

const project = (key: string) => api("GET", `/projects/${key}`);
const releaseRuns = (pid: string) =>
  all<{ summary: string }>("SELECT summary FROM activity WHERE project_id = ? AND type = 'run_started' AND summary LIKE '% started release%' ORDER BY id", pid).map((r) => r.summary);
const releases = (pid: string) => all<{ version: string }>("SELECT version FROM releases WHERE project_id = ?", pid);
const deliverables = (pid: string) => all<{ code: string; state: string }>("SELECT code, state FROM work_items WHERE project_id = ? AND type IN ('story','task','bug')", pid);
const activity = (pid: string) => all<{ summary: string }>("SELECT summary FROM activity WHERE project_id = ? ORDER BY id", pid).map((r) => r.summary);

/** True once the coordinator calls cleanEnvironments from the project routes in api.ts. */
const apiWired = fs.readFileSync(path.resolve(import.meta.dirname, "../src/api.ts"), "utf8").includes("cleanEnvironments");

const CHAIN = [
  { key: "test", name: "Test", purpose: "build", org: "ENV-TEST", deployMode: "deploy", approval: false },
  { key: "uat", name: "UAT", purpose: "stage", org: "ENV-UAT", deployMode: "deploy", approval: true },
  { key: "prod", name: "Production", purpose: "production", org: "ENV-PROD", deployMode: "deploy", approval: true },
];

async function newProject(key: string, extra: Record<string, unknown> = {}, agentIds?: string[]) {
  const agents = await api<any[]>("GET", "/agents");
  return api("POST", "/projects", {
    name: `Env ${key}`,
    key,
    description: DESCRIPTION,
    agentIds: agentIds ?? agents.filter((a) => a.role !== "specialist").map((a) => a.id),
    settings: { gates: false, parallelism: 2, budgetUsd: 0, maxRework: 1, repo: { url: `https://github.com/demo/${key.toLowerCase()}.git`, branch: "main" }, ...extra },
  });
}

/** Gives a project environments the way the PATCH route will (validated), independent of the api.ts wiring. */
function setEnvironments(id: string, raw: unknown) {
  const p = getProject(id)!;
  const settings = { ...p.settings, environments: cleanEnvironments(raw)! };
  patchProject(id, { settings, stages: buildStages({ agent_ids: p.agent_ids, settings }) });
}

before(async () => {
  registerTemplates(apiRouter);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "simulation", simulationSpeed: 0.02, dailyLimitUsd: 0, monthlyLimitUsd: 0 });
  addManualOrg({ alias: "ENV-TEST", type: "sandbox" });
  addManualOrg({ alias: "ENV-UAT", type: "sandbox" });
  addManualOrg({ alias: "ENV-PROD", type: "production", allowProduction: true });
  addManualOrg({ alias: "ENV-LOCKED", type: "production" });
});

after(() => server.close());

test("environments are validated: registered orgs, one build env first, production last", () => {
  assert.equal(cleanEnvironments(undefined), undefined);
  assert.deepEqual(cleanEnvironments([]), []);
  const envs = cleanEnvironments([{ name: "Test", purpose: "build", org: "ENV-TEST" }, { name: "Pre Prod", purpose: "stage" }, { name: "Production", purpose: "production", org: "ENV-PROD" }])!;
  assert.deepEqual(envs.map((e) => [e.key, e.purpose, e.org, e.deployMode, e.approval]), [
    ["test", "build", "ENV-TEST", "validate", false],
    ["pre-prod", "stage", null, "validate", false],
    ["production", "production", "ENV-PROD", "validate", true],
  ]);
  assert.throws(() => cleanEnvironments([{ name: "Test", purpose: "build", org: "NOPE" }]), /not registered/);
  assert.throws(() => cleanEnvironments([{ name: "Prod", purpose: "production", org: "ENV-LOCKED" }]), /isn't allowed/);
  assert.throws(() => cleanEnvironments([{ name: "A", purpose: "build" }, { name: "B", purpose: "build" }]), /Only one build/);
  assert.throws(() => cleanEnvironments([{ name: "UAT", purpose: "stage" }, { name: "Test", purpose: "build" }]), /comes first/);
  assert.throws(() => cleanEnvironments([{ name: "Prod", purpose: "production" }, { name: "UAT", purpose: "stage" }]), /Production comes last/);
  assert.throws(() => cleanEnvironments([{ name: "UAT", purpose: "qa" }]), /purpose/);
  assert.throws(() => cleanEnvironments([{ name: "UAT" }, { name: "uat" }]), /Two environments/);
  // A PATCH may keep an org whose registration changed since; a new one must be allowed.
  assert.equal(cleanEnvironments([{ key: "prod", name: "Prod", purpose: "production", org: "ENV-LOCKED" }], { previous: [{ key: "prod", org: "ENV-LOCKED" } as any] })![0].org, "ENV-LOCKED");
  // Template slots never carry orgs.
  assert.equal(cleanEnvironments([{ name: "Test", purpose: "build", org: "NOPE" }], { slots: true })![0].org, null);
});

test("Test → UAT (approval) → Production (approval): pauses per environment, one release at the end", async () => {
  const created = await newProject("ENV");
  setEnvironments(created.id, CHAIN);
  const keys = getProject(created.id)!.stages.map((s) => s.key);
  assert.deepEqual(keys.slice(-5), ["approve:uat", "release:uat", "validate:prod", "approve:prod", "release:prod"]);
  assert.ok(!keys.includes("approve_release") && !keys.includes("release"));
  // Dev/QA tools target the build environment's org.
  assert.equal(sfAccess(getProject(created.id)!).org?.alias, "ENV-TEST");
  assert.match((sfAccess(getProject(created.id)!) as { reason: string }).reason, /ENV-TEST, Test environment/);

  await api("POST", "/projects/ENV/start");
  await waitFor(async () => (await project("ENV")).status === "awaiting_approval", "the UAT approval");
  let p = await project("ENV");
  assert.equal(p.stage, "approve:uat");
  assert.deepEqual(releaseRuns(p.id), [], "nothing is released before the approval");
  assert.ok(activity(p.id).some((s) => s === "Stories are built and tested against the Test environment (org ENV-TEST)"));
  assert.ok(deliverables(p.id).some((i) => i.state === "Release Ready"));

  await api("POST", "/projects/ENV/approve");
  await waitFor(async () => (await project("ENV")).status === "awaiting_approval" && (await project("ENV")).stage === "approve:prod", "the Production approval");
  p = await project("ENV");
  assert.deepEqual(releaseRuns(p.id).map((s) => s.replace(/^\S+ /, "")), ["started release (UAT)", "started release (Production, check-only)"]);
  assert.equal(releases(p.id).length, 0, "no release notes before the last environment");
  assert.ok(deliverables(p.id).every((i) => i.state !== "Deployed (Done)"), "nothing is Deployed before the last environment");
  assert.ok(deliverables(p.id).some((i) => i.state === "Smoke Testing"));
  const acts = activity(p.id);
  assert.ok(acts.some((s) => /simulated deploy → ENV-UAT \(UAT\)/.test(s)), "UAT validated and deployed against its org");
  assert.ok(acts.some((s) => /simulated check-only → ENV-PROD \(Production\)/.test(s)), "Production validated check-only before the approval");
  assert.ok(acts.some((s) => /^✅ UAT: deployed and smoke-tested \(org ENV-UAT\)/.test(s)));
  assert.ok(all("SELECT 1 FROM test_results WHERE project_id = ? AND kind = 'smoke' AND ac_ref LIKE 'Smoke (UAT)%'", p.id).length > 0, "smoke-tested on UAT");

  await api("POST", "/projects/ENV/approve");
  await waitFor(async () => (await project("ENV")).status === "completed", "completion");
  p = await project("ENV");
  assert.equal(releaseRuns(p.id).length, 3);
  assert.match(releaseRuns(p.id)[2], /started release \(Production\)$/);
  assert.equal(releases(p.id).length, 1, "notes and tag published once");
  const ready = deliverables(p.id).filter((i) => !["Blocked", "Cancelled"].includes(i.state));
  assert.ok(ready.length > 0 && ready.every((i) => i.state === "Deployed (Done)"));
  assert.ok(activity(p.id).some((s) => /simulated deploy → ENV-PROD \(Production\)/.test(s)));
  const notes = all<{ content: string }>("SELECT content FROM documents WHERE project_id = ? AND kind = 'release_notes'", p.id)[0]?.content ?? "";
  assert.match(notes, /Test \(ENV-TEST\) → UAT \(ENV-UAT\) → Production \(ENV-PROD\)|UAT \(ENV-UAT\) → Production \(ENV-PROD\)/);
  assert.ok(p.stages.every((s: any) => s.status === "done" || s.status === "skipped"));
});

test("a project without environments keeps the single target org and release", async () => {
  const p = await newProject("LEG", { targetOrg: "ENV-UAT" });
  const keys = p.stages.map((s: any) => s.key);
  assert.deepEqual(keys.slice(-2), ["approve_release", "release"]);
  assert.ok(!keys.some((k: string) => k.includes(":")));
  assert.equal(p.settings.environments, undefined);
  assert.equal(p.targetOrg.alias, "ENV-UAT");
  assert.equal(p.targetOrg.source, "project");
  assert.equal(sfAccess(getProject(p.id)!).org?.alias, "ENV-UAT");
});

test("network templates: built-ins are read-only, custom ones support CRUD and save-as-template", async () => {
  const list = await api<any[]>("GET", "/templates");
  assert.deepEqual(list.filter((t) => t.builtin).map((t) => t.name), ["Full Salesforce delivery", "Small change", "Analysis & estimate only", "Data migration"]);
  const full = list.find((t) => t.id === "builtin-full");
  assert.equal(full.roles.length, 7);
  assert.deepEqual(full.environments.map((e: any) => [e.name, e.purpose, e.approval, e.org]), [["Test", "build", false, null], ["UAT", "stage", true, null], ["Production", "production", true, null]]);
  await assert.rejects(api("DELETE", "/templates/builtin-full"), /400.*can't be deleted/);
  await assert.rejects(api("PUT", "/templates/builtin-small", { name: "Mine" }), /400/);

  const t = await api("POST", "/templates", { name: "Hotfix", description: "One dev, straight to prod", roles: ["developer", "release"], settings: { gates: false, parallelism: 1, maxRework: 1, budgetUsd: 5 }, environments: [{ name: "Dev", purpose: "build", org: "ENV-TEST" }, { name: "Prod", purpose: "production", approval: true }] });
  assert.equal(t.builtin, false);
  assert.equal(t.environments[0].org, null, "templates never keep org aliases");
  await assert.rejects(api("POST", "/templates", { name: "hotfix", roles: ["developer"] }), /already exists/);
  await assert.rejects(api("POST", "/templates", { name: "Bad", roles: ["wizard"] }), /Unknown role/);
  const renamed = await api("PUT", `/templates/${t.id}`, { name: "Hotfix lane" });
  assert.equal(renamed.name, "Hotfix lane");
  assert.equal(renamed.environments.length, 2);
  const resolved = await api("GET", `/templates/${t.id}/resolve`);
  const agents = await api<any[]>("GET", "/agents");
  assert.deepEqual(resolved.agentIds.sort(), agents.filter((a) => a.enabled && ["developer", "release"].includes(a.role)).map((a) => a.id).sort());

  // Save as template from a project: roles, settings and environment slots without orgs.
  const src = await newProject("SAV");
  setEnvironments(src.id, CHAIN);
  const saved = await api("POST", `/projects/${src.id}/save-template`, { name: "From SAV" });
  assert.equal(saved.roles.length, 7);
  assert.deepEqual(saved.environments.map((e: any) => [e.key, e.org]), [["test", null], ["uat", null], ["prod", null]]);
  assert.equal(saved.settings.gates, false);

  // Custom templates travel in the team file (format v1, optional field).
  const file = exportTeam({ name: "T" });
  assert.equal(file.version, 1);
  assert.deepEqual(file.networkTemplates!.map((x) => x.name).sort(), ["From SAV", "Hotfix lane"]);
  await api("DELETE", `/templates/${t.id}`);
  assert.ok(!(await api<any[]>("GET", "/templates")).some((x) => x.id === t.id));
  const plan = planImport(file);
  assert.deepEqual(plan.templates, [{ name: "Hotfix lane", action: "create" }, { name: "From SAV", action: "update" }]);
  applyImport(file);
  assert.ok((await api<any[]>("GET", "/templates")).some((x) => x.name === "Hotfix lane" && !x.builtin));
  const { networkTemplates: _n, ...older } = file;
  assert.equal(planImport(older).templates, undefined, "older team files without templates still import");
});

test("'Analysis & estimate only' creates a project that stops after planning", async () => {
  const r = await api("GET", "/templates/builtin-analysis/resolve");
  assert.deepEqual(r.environments, []);
  const p = await newProject("ANA", { ...r.settings, gates: false }, r.agentIds);
  const st = Object.fromEntries(p.stages.map((s: any) => [s.key, s.status]));
  assert.equal(st.delivery, "skipped");
  assert.equal(st.release, "skipped");
  await api("POST", "/projects/ANA/start");
  await waitFor(async () => (await project("ANA")).status === "completed", "completion after planning");
  const done = await project("ANA");
  assert.ok(done.counts.stories > 0);
  assert.equal(releaseRuns(done.id).length, 0);
  assert.equal(all("SELECT 1 FROM runs WHERE project_id = ? AND stage IN ('development','qa','release')", done.id).length, 0);
});

test("project creation from a template maps each environment slot to an org", { skip: !apiWired && "api.ts doesn't call cleanEnvironments yet (coordinator wiring)" }, async () => {
  const r = await api("GET", "/templates/builtin-small/resolve");
  const orgs: Record<string, string> = { test: "ENV-TEST", prod: "ENV-PROD" };
  const environments = r.environments.map((e: any) => ({ ...e, org: orgs[e.key] }));
  const p = await newProject("TPL", { ...r.settings, environments }, r.agentIds);
  assert.deepEqual(p.settings.environments.map((e: any) => e.org), ["ENV-TEST", "ENV-PROD"]);
  assert.deepEqual(p.stages.map((s: any) => s.key).slice(-3), ["validate:prod", "approve:prod", "release:prod"]);
  assert.equal(p.targetOrg.alias, "ENV-TEST");
  await assert.rejects(newProject("TPX", { environments: [{ name: "Prod", purpose: "production", org: "ENV-LOCKED" }] }), /400/);
  // PATCH rebuilds the release stages when the environments change.
  const patched = await api("PATCH", `/projects/${p.id}`, { settings: { environments: [] } });
  assert.deepEqual(patched.stages.map((s: any) => s.key).slice(-2), ["approve_release", "release"]);
});

test("live: each environment step targets its own org; production deploys the release validated before the approval", async () => {
  // Stand-ins only: the fake sf CLI and a dummy key that is never sent (validateWorkspace doesn't call Claude).
  const log = path.join(TMP, "env-sf-calls.jsonl");
  process.env.ARM_SF_BIN = path.resolve(import.meta.dirname, "fixtures/fake-sf.mjs");
  process.env.ARM_FAKE_SF_LOG = log;
  process.env.ANTHROPIC_API_KEY = "test-key-never-sent";
  saveAppSettings({ mode: "live" });
  try {
    const p = { ...getProject("ENV")!, mode: "live" as const };
    const calls = () =>
      fs.readFileSync(log, "utf8").trim().split("\n").map((l) => {
        const a = (JSON.parse(l) as { args: string[] }).args;
        return `${a.slice(0, 3).join(" ")} → ${a[a.indexOf("--target-org") + 1]}`;
      });
    const uat = await validateWorkspace(p, undefined, envStep(p.settings, "release:uat")!);
    assert.equal(uat.ok, true, uat.output);
    assert.equal(uat.org?.alias, "ENV-UAT");
    assert.deepEqual(calls(), ["project deploy validate → ENV-UAT", "project deploy start → ENV-UAT"]);
    fs.writeFileSync(log, "");
    const check = await validateWorkspace(p, undefined, envStep(p.settings, "validate:prod")!);
    assert.equal(check.ok, true, check.output);
    assert.deepEqual(calls(), ["project deploy validate → ENV-PROD"], "check-only before the approval");
    fs.writeFileSync(log, "");
    const deploy = await validateWorkspace(p, undefined, envStep(p.settings, "release:prod")!);
    assert.equal(deploy.ok, true, deploy.output);
    assert.match(deploy.mode, /quick deploy/);
    assert.deepEqual(calls(), ["project deploy quick → ENV-PROD"]);
    // Dev/QA tools use the build environment's org.
    assert.deepEqual(sfAccess(p).org?.alias, "ENV-TEST");
    assert.equal(sfAccess(p).live, true);
  } finally {
    saveAppSettings({ mode: "simulation" });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ARM_SF_BIN;
    delete process.env.ARM_FAKE_SF_LOG;
  }
});
