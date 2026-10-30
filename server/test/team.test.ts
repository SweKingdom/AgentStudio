import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TMP } from "./setup.ts";

process.env.ARM_SF_BIN = path.resolve(import.meta.dirname, "fixtures/fake-sf.mjs");
const { seedAgents, listAgents, updateAgent } = await import("../src/agents/store.ts");
const team = await import("../src/team.ts");
const git = await import("../src/git.ts");
const { workspaceDir, worktreeDir } = await import("../src/store.ts");
const { buildPackageXml } = await import("../src/agents/tools.ts");
const { saveCustomKnowledge } = await import("../src/knowledge.ts");
const { addManualOrg } = await import("../src/salesforce.ts");
const { runChecks } = await import("../src/doctor.ts");

seedAgents();
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

test("conventions drive branch names, merge commits and the PR description", async () => {
  team.saveTeamSettings({ conventions: { branchPattern: "story/{code}", mergePattern: "{code}: merge {branch}", prTemplate: "## {code}\n{summary}\nTests: {tests}" } });
  assert.equal(git.branchNameFor({ code: "US-7", title: "Anything", type: "story" }), "story/US-7");
  assert.equal(git.branchNameFor({ code: "BG-8", title: "Fix the thing", type: "bug" }), "bugfix/BG-8-fix-the-thing", "bugs keep their own pattern");
  assert.throws(() => team.saveTeamSettings({ conventions: { branchPattern: "feature/{slug}" } }), /\{code\}/);
  assert.throws(() => team.saveTeamSettings({ conventions: { branchPattern: "feature/{code} x" } }), /Invalid characters/);

  const p = { key: "TCV", settings: { repo: { url: "https://github.com/x/y.git", branch: "main" } } } as any;
  await git.ensureRepo(p);
  const it = { code: "US-7", title: "Anything", type: "story" as const, branch: null };
  const { branch } = await git.ensureItemBranch(p, it);
  fs.mkdirSync(path.join(worktreeDir(p, "US-7"), "force-app"), { recursive: true });
  fs.writeFileSync(path.join(worktreeDir(p, "US-7"), "force-app/a.txt"), "a\n");
  await git.commitWork(p, { author: "Forge", email: "f@x", message: "US-7: dev", itemCode: "US-7" });
  const m = await git.mergeItemBranch(p, { ...it, branch, body: "## US-7\nBuilt it\nTests: ✅ 3 passed" });
  assert.ok(m.merged);
  assert.equal(sh(workspaceDir(p), "log", "-1", "--format=%s"), "US-7: merge story/US-7");
  assert.match(sh(workspaceDir(p), "log", "-1", "--format=%b"), /## US-7\nBuilt it\nTests: ✅ 3 passed/);
  team.saveTeamSettings({ conventions: team.DEFAULT_TEAM.conventions });
});

test("Salesforce settings: team defaults with validated project overrides", () => {
  team.saveTeamSettings({ salesforce: { apiVersion: "63.0", coverageMin: 85 } });
  const proj = { settings: { salesforce: team.cleanSalesforceOverride({ apiVersion: "64.0", prefix: "SRC_", coverageMin: "" }) } } as any;
  assert.deepEqual(team.projectSalesforce(proj), { apiVersion: "64.0", coverageMin: 85, namespace: "", prefix: "SRC_", devTestLevel: "RunSpecifiedTests" });
  assert.equal(JSON.parse(team.sfdxProjectJson(proj)).sourceApiVersion, "64.0");
  assert.match(buildPackageXml(["force-app/main/default/classes/A.cls"], "64.0"), /<version>64\.0<\/version>/);
  assert.throws(() => team.cleanSalesforceOverride({ apiVersion: "sixty" }), /API version/);
  assert.throws(() => team.cleanSalesforceOverride({ coverageMin: 120 }), /Coverage/);
  assert.throws(() => team.cleanSalesforceOverride({ prefix: "bad prefix" }), /prefix/);
  team.saveTeamSettings({ salesforce: team.DEFAULT_TEAM.salesforce });
});

test("team template: export travels without org aliases; import previews, then versions the changes", () => {
  addManualOrg({ alias: "MY-SANDBOX", type: "sandbox" });
  const helm = listAgents().find((a) => a.role === "release")!;
  updateAgent(helm.id, { config: { ...helm.config, targetOrg: "MY-SANDBOX", deployMode: "deploy" } });
  saveCustomKnowledge({ id: "acme-standards", title: "ACME standards", summary: "House rules", content: "Always use SRC_ prefix." });
  const forge = listAgents().find((a) => a.role === "developer")!;
  updateAgent(forge.id, { knowledge: [...forge.knowledge, "acme-standards"], effort: "medium" });

  const t = team.exportTeam({ name: "ACME team" });
  assert.equal(t.format, "siroccoarm-team");
  assert.equal(t.agents.length, listAgents().length);
  assert.ok(!JSON.stringify(t).includes("MY-SANDBOX"), "org aliases never travel");
  assert.equal(t.agents.find((a) => a.role === "release")!.config.deployMode, "deploy", "the rest of the config does");
  assert.deepEqual(t.knowledge.map((k) => k.id), ["acme-standards"]);
  assert.ok(!JSON.stringify(t).match(/api[_-]?key|sk-ant/i));

  // Another machine changed Forge; importing the file shows it, then restores the exported version.
  updateAgent(forge.id, { effort: "max", max_turns: 99 });
  const plan = team.planImport(t);
  const f = plan.agents.find((a) => a.role === "developer")!;
  assert.equal(f.action, "update");
  assert.deepEqual(f.changes.sort(), ["effort", "max_turns"]);
  assert.equal(listAgents().find((a) => a.id === forge.id)!.effort, "max", "preview changes nothing");
  const before = listAgents().find((a) => a.id === forge.id)!.version;
  team.applyImport(t);
  const after = listAgents().find((a) => a.id === forge.id)!;
  assert.equal(after.effort, "medium");
  assert.equal(after.version, before + 1, "a new, restorable version");
  assert.equal(listAgents().find((a) => a.role === "release")!.config.targetOrg, "MY-SANDBOX", "this machine keeps its org choice");

  // A new agent in the file is created; bad files are refused.
  // Custom agents are off: an agent that isn't on this team is skipped (with a warning), never created.
  const withNew = { ...t, agents: [...t.agents, { ...t.agents.find((a) => a.role === "qa")!, name: "Vixen" }] };
  const planNew = team.planImport(withNew);
  assert.equal(planNew.agents.find((a) => a.name === "Vixen")!.action, "skip");
  assert.ok(planNew.warnings.some((w) => /Vixen/.test(w)));
  const count = listAgents().length;
  team.applyImport(withNew);
  assert.ok(!listAgents().some((a) => a.name === "Vixen"));
  assert.equal(listAgents().length, count);
  assert.throws(() => team.planImport({ hello: 1 }), /isn't a SiroccoARM team file/);
  assert.throws(() => team.planImport({ ...t, version: 99 }), /newer SiroccoARM/);
  assert.throws(() => team.planImport({ ...t, knowledge: [{ id: "../../etc/x", title: "x", summary: "", content: "" }] }), /Invalid knowledge pack id/);
  assert.throws(() => team.planImport({ ...t, agents: [{ ...t.agents[0], role: "hacker" }] }), /unknown role/);
});

test("system check reports this machine without spending anything", async () => {
  const checks = await runChecks();
  const by = (id: string) => checks.find((c) => c.id === id);
  assert.equal(by("node")?.status, "ok");
  assert.equal(by("data")?.status, "ok");
  assert.equal(by("git")?.status, "ok");
  assert.equal(by("sf")?.status, "ok");
  assert.equal(by("api-key")?.status, "warn", "no key in tests → simulation");
  assert.ok(checks.some((c) => c.id === "org-MY-SANDBOX" && c.status === "info"), "orgs listed; connections tested only in the full check");
  assert.ok(fs.existsSync(TMP));
});
