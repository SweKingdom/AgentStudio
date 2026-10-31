import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TMP } from "./setup.ts";

const { seedAgents, listAgents, updateAgent } = await import("../src/agents/store.ts");
const team = await import("../src/team.ts");
const git = await import("../src/git.ts");
const { workspaceDir, worktreeDir } = await import("../src/store.ts");
const { saveCustomKnowledge } = await import("../src/knowledge.ts");
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

test("checks: team defaults with validated project overrides", () => {
  team.saveTeamSettings({ checks: { commands: [{ name: "test", command: "npm test" }], timeoutMinutes: 20 } });
  const proj = { settings: { checks: team.cleanChecksOverride({ commands: [{ name: "", command: "make check" }] }) } } as any;
  assert.deepEqual(team.projectChecks(proj), { commands: [{ name: "make check", command: "make check" }], timeoutMinutes: 20, install: "auto" });
  const own = { settings: { checks: team.cleanChecksOverride({ install: "pnpm install --frozen-lockfile" }) } } as any;
  assert.equal(team.projectChecks(own).install, "pnpm install --frozen-lockfile", "the project's own install command wins");
  assert.throws(() => team.cleanChecksOverride({ install: "npm i\nnpm run build" }), /one line/);
  assert.deepEqual(team.projectChecks({ settings: {} } as any).commands, [{ name: "test", command: "npm test" }], "no override: the team's checks");
  assert.throws(() => team.cleanChecksOverride({ commands: [{ name: "x", command: "a\nb" }] }), /one line/);
  assert.throws(() => team.saveTeamSettings({ checks: { timeoutMinutes: 0 } }), /timeout/);
  team.saveTeamSettings({ checks: team.DEFAULT_TEAM.checks });
});

test("team template: export, then import previews and versions the changes", () => {
  saveCustomKnowledge({ id: "acme-standards", title: "ACME standards", summary: "House rules", content: "Always use SRC_ prefix." });
  const forge = listAgents().find((a) => a.role === "developer")!;
  updateAgent(forge.id, { knowledge: [...forge.knowledge, "acme-standards"], effort: "medium" });

  const t = team.exportTeam({ name: "ACME team" });
  assert.equal(t.format, "agentstudio-team");
  assert.equal(t.agents.length, listAgents().length);
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
  assert.throws(() => team.planImport({ hello: 1 }), /isn't an AgentStudio team file/);
  assert.throws(() => team.planImport({ ...t, version: 99 }), /newer AgentStudio/);
  assert.throws(() => team.planImport({ ...t, knowledge: [{ id: "../../etc/x", title: "x", summary: "", content: "" }] }), /Invalid knowledge pack id/);
  assert.throws(() => team.planImport({ ...t, agents: [{ ...t.agents[0], role: "hacker" }] }), /unknown role/);
});

test("system check reports this machine without spending anything", async () => {
  const checks = await runChecks();
  const by = (id: string) => checks.find((c) => c.id === id);
  assert.equal(by("node")?.status, "ok");
  assert.equal(by("data")?.status, "ok");
  assert.equal(by("git")?.status, "ok");
  assert.equal(by("api-key")?.status, "warn", "no key in tests → simulation");
  assert.ok(!checks.some((c) => c.id === "sf" || c.id.startsWith("org-")), "no Salesforce checks");
  assert.ok(fs.existsSync(TMP));
});
