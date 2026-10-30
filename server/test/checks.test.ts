// The project's own checks: detected from package.json or configured, run for real only in live mode, stop at the
// first failure, and gate the hand-over to QA.
import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TMP } from "./setup.ts";

const { detectChecks, runChecks } = await import("../src/checks.ts");
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
