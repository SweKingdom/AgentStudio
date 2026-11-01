// Allowed commands: a developer agent runs only what the project allows, in its story's worktree, and can keep generated
// files .gitignore would exclude. What it can't do becomes a manual step with exact commands and the worktree path.
import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.ANTHROPIC_API_KEY = "test-key-never-sent";

const { cleanAllowedCommands, commandRefusal } = await import("../src/commands.ts");
const { executeTool } = await import("../src/agents/tools.ts");
const { defaultAgentFor } = await import("../src/agents/store.ts");
const { saveAppSettings } = await import("../src/settings.ts");
const { createItem, getItem, worktreeDir } = await import("../src/store.ts");
const { commitWork, ensureItemBranch, ensureRepo } = await import("../src/git.ts");
const { all, insert, now } = await import("../src/db.ts");

after(() => {
  saveAppSettings({ mode: "simulation", backend: "auto" });
  delete process.env.ANTHROPIC_API_KEY;
});

test("allowed commands: whole-word prefixes, never shell operators", () => {
  assert.deepEqual(cleanAllowedCommands(["  dotnet   ef migrations add ", "dotnet ef migrations add", "npm run seed"]), ["dotnet ef migrations add", "npm run seed"]);
  assert.throws(() => cleanAllowedCommands(["npm run seed && rm -rf /"]), /can't contain/);
  const allowed = ["dotnet ef migrations add", "dotnet run -- --seed-only"];
  assert.equal(commandRefusal("dotnet ef migrations add AddBookings", allowed), null);
  assert.equal(commandRefusal("dotnet run -- --seed-only", allowed), null);
  assert.match(commandRefusal("dotnet efx migrations add", allowed)!, /Not an allowed command/);
  assert.match(commandRefusal("dotnet ef migrations add X; del newtons.db", allowed)!, /can't contain/);
  assert.match(commandRefusal("dotnet ef migrations add $(whoami)", allowed)!, /can't contain/);
  assert.match(commandRefusal("dotnet run", allowed)!, /Not an allowed command/, "a shorter command isn't the allowed one");
});

function liveProject(key: string, commands: string[]) {
  process.env.ANTHROPIC_API_KEY = "test-key-never-sent";
  saveAppSettings({ mode: "live", backend: "api" });
  const ts = now();
  const settings = { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1, commands, repo: null };
  insert("projects", { id: `prj_${key}`, key, name: key, status: "ready", mode: "live", created_at: ts, updated_at: ts, settings });
  return { id: `prj_${key}`, key, name: key, mode: "live", settings } as any;
}

test("run_command runs an allowed command in the story's worktree; kept files are committed despite .gitignore", async () => {
  const p = liveProject("CMD", ["node scripts/seed.mjs"]);
  await ensureRepo(p);
  const story = createItem(p.id, { type: "story", title: "Seed the database", state: "In Progress" });
  const { branch } = await ensureItemBranch(p, story);
  const wt = worktreeDir(p, story.code);
  fs.mkdirSync(path.join(wt, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".gitignore"), "*.db\nnode_modules/\n");
  fs.writeFileSync(path.join(wt, "scripts/seed.mjs"), "import fs from 'node:fs';\nfs.writeFileSync('app.db', 'seeded');\nconsole.log('seeded', process.env.ANTHROPIC_API_KEY ?? 'no key');\n");
  const dev = { ...defaultAgentFor("developer"), tools: ["run_command"] };
  const ctx = { project: p, agent: dev, runId: "run_cmd", item: { ...story, branch }, iteration: 1, outcome: {} } as any;

  const refused = await executeTool("run_command", { command: "node -e 1" }, ctx);
  assert.equal(refused.ok, false);
  assert.match(refused.content, /Not an allowed command/);

  const r = await executeTool("run_command", { command: "node scripts/seed.mjs", keep: ["app.db"] }, ctx);
  assert.equal(r.ok, true, r.content);
  assert.match(r.content, /exit 0/);
  assert.match(r.content, /seeded no key/, "AgentStudio's keys aren't passed to the command");
  assert.match(r.content, /Kept despite \.gitignore: app\.db/);
  await commitWork(p, { author: "Dev", email: "dev@x", message: "seed", itemCode: story.code });
  assert.match(execFileSync("git", ["ls-files"], { cwd: wt, encoding: "utf8" }), /app\.db/, "the generated database is committed");
});

test("request_manual_step asks the product owner with the exact commands and the worktree path", async () => {
  const p = liveProject("MAN", []);
  await ensureRepo(p);
  const story = createItem(p.id, { type: "story", title: "Publish to the store", state: "In Progress" });
  const { branch } = await ensureItemBranch(p, story);
  const dev = defaultAgentFor("developer");
  const ctx = { project: p, agent: { ...dev, tools: [...dev.tools, "request_manual_step"] }, runId: "run_man", item: { ...story, branch }, iteration: 1, outcome: {} } as any;
  const r = await executeTool("request_manual_step", { code: story.code, title: "Generate the seed database", why: "dotnet isn't an allowed command.", commands: ["dotnet run -- --seed-only", "git add -f newtons.db"] }, ctx);
  assert.equal(r.ok, true, r.content);
  const q = all<{ question: string }>("SELECT question FROM questions WHERE item_id = ?", story.id)[0].question;
  assert.match(q, /Manual step for/);
  assert.ok(q.includes(worktreeDir(p, story.code)), "the worktree path is in the question");
  assert.match(q, /dotnet run -- --seed-only[\s\S]*git add -f newtons\.db/);
  assert.equal(getItem(story.id)!.state, "In Progress");
});
