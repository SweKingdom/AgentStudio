// The project's own checks: detected from package.json or configured, run for real only in live mode, stop at the
// first failure, and gate the hand-over to QA.
import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TMP } from "./setup.ts";

const checksModule = await import("../src/checks.ts");
const { detectChecks, runChecks, formatChecks } = checksModule;
const { executeTool } = await import("../src/agents/tools.ts");
const { defaultAgentFor } = await import("../src/agents/store.ts");
const { saveAppSettings } = await import("../src/settings.ts");
const { workspaceDir } = await import("../src/store.ts");
const { insert, now } = await import("../src/db.ts");

after(() => {
  saveAppSettings({ mode: "simulation", backend: "auto" });
  delete process.env.ANTHROPIC_API_KEY;
});

test("checks are detected from package.json scripts, cheap ones first, npm's placeholder test left out", () => {
  const dir = path.join(TMP, "detect");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "node --test", lint: "eslint .", start: "node ." } }));
  assert.deepEqual(detectChecks(dir).map((c) => c.name), ["lint", "test", "build"]);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.deepEqual(detectChecks(dir), []);
  assert.deepEqual(detectChecks(path.join(TMP, "nothing-here")), []);
});

/** A real project row (tools log activity against it) with its own checks. */
function project(key: string, mode: "live" | "simulation", commands: { name: string; command: string }[]) {
  const ts = now();
  const settings = { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1, checks: { commands } };
  insert("projects", { id: `prj_${key}`, key, name: key, status: "ready", mode, created_at: ts, updated_at: ts, settings });
  return { id: `prj_${key}`, key, name: key, mode, settings } as any;
}

test("simulation never runs a command", async () => {
  const r = await runChecks(project("CSIM", "simulation", [{ name: "boom", command: "exit 1" }]));
  assert.equal(r.ok, true);
  assert.equal(r.simulated, true);
});

test("live: runs each check in the workspace and stops at the first failure", async () => {
  // Live mode needs a usable backend; the API backend with a dummy key is enough — nothing here calls Claude.
  process.env.ANTHROPIC_API_KEY = "test-key-never-sent";
  saveAppSettings({ mode: "live", backend: "api" });
  const p = project("CLIVE", "live", [
    { name: "first", command: "node -e \"process.stdout.write('ok-1')\"" },
    { name: "second", command: "node -e \"console.error('broken here'); process.exit(3)\"" },
    { name: "third", command: "node -e \"require('fs').writeFileSync('third-ran','x')\"" },
  ]);
  fs.mkdirSync(workspaceDir(p), { recursive: true });
  const r = await runChecks(p);
  assert.equal(r.ok, false);
  assert.deepEqual(r.results.map((x) => [x.name, x.exitCode]), [["first", 0], ["second", 3]]);
  assert.match(r.results[1].output, /broken here/);
  assert.ok(!fs.existsSync(path.join(workspaceDir(p), "third-ran")), "stops at the first failure");

  // complete_development refuses until run_checks passes in the same run.
  const dev = defaultAgentFor("developer");
  const ctx = { project: p, agent: dev, runId: "run_c", iteration: 1, outcome: {} } as any;
  const before = await executeTool("complete_development", { code: "US-1", summary: "done" }, ctx);
  assert.equal(before.ok, false);
  assert.match(before.content, /run_checks/);
  const failed = await executeTool("run_checks", {}, ctx);
  assert.equal(failed.ok, true, "the tool itself works; the checks failed");
  assert.match(failed.content, /❌ second/);
  assert.equal((await executeTool("complete_development", { code: "US-1", summary: "done" }, ctx)).ok, false);

  p.settings.checks.commands = [{ name: "first", command: "node -e \"0\"" }];
  assert.match((await executeTool("run_checks", {}, ctx)).content, /✅ first/);
  assert.equal((await executeTool("complete_development", { code: "US-1", summary: "done" }, ctx)).ok, true);
});

test("the install command is detected from the lockfile; npm writes one when there is none", () => {
  const { detectInstall } = checksModule;
  const dir = path.join(TMP, "detect-install");
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(detectInstall(dir), null, "no package.json, nothing to install");
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  assert.match(detectInstall(dir)!, /^npm install/);
  fs.writeFileSync(path.join(dir, "yarn.lock"), "");
  assert.equal(detectInstall(dir), "yarn install");
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  assert.equal(detectInstall(dir), "pnpm install");
});

test("live: dependencies are installed before the checks, once, and the lockfile is written", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key-never-sent";
  saveAppSettings({ mode: "live", backend: "api" });
  const p = project("CINS", "live", [{ name: "deps", command: "node -e \"require('fs').accessSync('package-lock.json')\"" }]);
  const dir = workspaceDir(p);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "cins", version: "1.0.0", private: true }));

  const first = await runChecks(p);
  assert.equal(first.ok, true, JSON.stringify(first.results));
  assert.deepEqual(first.results.map((r) => [r.name, r.ok]), [["install", true], ["deps", true]]);
  assert.match(first.results[0].command, /^npm install/);
  assert.ok(fs.existsSync(path.join(dir, "package-lock.json")), "npm wrote the lockfile the story commits");

  const second = await runChecks(p);
  assert.equal(second.results[0].skipped, true, "unchanged dependencies aren't installed again");
  assert.match(formatChecks(second), /✅ install .* Dependencies are up to date/);

  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "cins", version: "1.0.1", private: true }));
  assert.ok(!(await runChecks(p)).results[0].skipped, "a changed package.json installs again");

  p.settings.checks.install = "node -e \"console.error('no such package'); process.exit(1)\"";
  const failed = await runChecks(p);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.results.map((r) => r.name), ["install"], "a failed install stops before the checks");
  assert.match(formatChecks(failed), /no such package/);

  p.settings.checks.install = "off";
  assert.deepEqual((await runChecks(p)).results.map((r) => r.name), ["deps"]);
});

test("installed dependencies are never committed, whatever the repository's .gitignore says", async () => {
  const { ensureRepo, commitWork } = await import("../src/git.ts");
  const { execFileSync } = await import("node:child_process");
  const p = { key: "CGIT", settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1 } } as any;
  await ensureRepo(p);
  const dir = workspaceDir(p);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".DS_Store\n"); // a repository without node_modules in .gitignore
  fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;");
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
  await commitWork(p, { author: "Dev", email: "dev@example.com", message: "work" });
  const files = execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" });
  assert.match(files, /package-lock\.json/);
  assert.doesNotMatch(files, /node_modules/);
});
