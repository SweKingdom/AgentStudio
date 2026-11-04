// edit_file: the developer changes only the lines that change, instead of resending the whole file with write_file.
import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { executeTool } = await import("../src/agents/tools.ts");
const { defaultAgentFor } = await import("../src/agents/store.ts");
const { createItem, getProject, readWorkspaceFile, worktreeDir } = await import("../src/store.ts");
const { ensureRepo, ensureItemBranch } = await import("../src/git.ts");
const { all, insert, now } = await import("../src/db.ts");

async function story(key: string) {
  const ts = now();
  insert("projects", { id: `prj_${key}`, key, name: key, status: "ready", mode: "simulation", created_at: ts, updated_at: ts, settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1 } });
  const p = getProject(`prj_${key}`)!;
  await ensureRepo(p);
  const item = createItem(p.id, { type: "story", title: "Orders" });
  await ensureItemBranch(p, item);
  const ctx = { project: p, agent: defaultAgentFor("developer"), item, runId: `run_${key}`, iteration: 1, outcome: {} } as any;
  const run = (name: string, input: Record<string, unknown>) => executeTool(name, input, ctx);
  return { p, item, run, read: (rel: string) => readWorkspaceFile(p, rel, item.code) };
}

test("edit_file replaces exactly one match and records a new version", async () => {
  const { p, run, read } = await story("EDT");
  await run("write_file", { path: "src/orders.ts", content: "export const limit = 10;\nexport const name = 'orders';\n" });
  const r = await run("edit_file", { path: "src/orders.ts", old_string: "limit = 10", new_string: "limit = 25" });
  assert.equal(r.ok, true, r.content);
  assert.equal(read("src/orders.ts"), "export const limit = 25;\nexport const name = 'orders';\n");
  assert.deepEqual(all<{ version: number }>("SELECT version FROM file_versions WHERE project_id = ? AND path = 'src/orders.ts' ORDER BY version", p.id).map((v) => v.version), [1, 2]);
  assert.equal(all("SELECT 1 FROM activity WHERE project_id = ? AND summary LIKE 'Edited src/orders.ts%'", p.id).length, 1);
  const del = await run("edit_file", { path: "src/orders.ts", old_string: "export const name = 'orders';\n", new_string: "" });
  assert.equal(del.ok, true, "an empty new_string deletes the text");
  assert.equal(read("src/orders.ts"), "export const limit = 25;\n");
});

test("edit_file refuses what it can't do safely, and leaves the file as it was", async () => {
  const { run, read } = await story("EDR");
  await run("write_file", { path: "src/a.ts", content: "x = 1;\nx = 1;\n" });
  const twice = await run("edit_file", { path: "src/a.ts", old_string: "x = 1;", new_string: "x = 2;" });
  assert.equal(twice.ok, false);
  assert.match(twice.content, /appears 2 times/);
  const missing = await run("edit_file", { path: "src/a.ts", old_string: "y = 1;", new_string: "y = 2;" });
  assert.match(missing.content, /wasn't found/);
  assert.match((await run("edit_file", { path: "src/none.ts", old_string: "a", new_string: "b" })).content, /File not found.*write_file/);
  assert.match((await run("edit_file", { path: ".env", old_string: "a", new_string: "b" })).content, /is protected/);
  assert.equal(read("src/a.ts"), "x = 1;\nx = 1;\n");
  const all2 = await run("edit_file", { path: "src/a.ts", old_string: "x = 1;", new_string: "x = 2;", replace_all: true });
  assert.equal(all2.ok, true);
  assert.equal(read("src/a.ts"), "x = 2;\nx = 2;\n");
});

test("edit_file matches a file with Windows line endings when the agent copied plain newlines", async () => {
  const { p, item, run, read } = await story("EDC");
  const file = path.join(worktreeDir(p, item.code), "src", "crlf.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "a();\r\nb();\r\n");
  const r = await run("edit_file", { path: "src/crlf.ts", old_string: "a();\nb();", new_string: "a();\nc();" });
  assert.equal(r.ok, true, r.content);
  assert.equal(read("src/crlf.ts"), "a();\r\nc();\r\n");
});

test("agents that write files get edit_file, also when they were saved before it existed", async () => {
  const { withProjectTools } = await import("../src/agents/runner.ts");
  const { ROLES } = await import("../src/agents/roles.ts");
  assert.ok(ROLES.developer.tools.includes("edit_file"));
  const { p } = await story("EDG");
  const saved = (role: "developer" | "writer", tools: string[]) => withProjectTools(defaultAgentFor(role, { tools }), p).tools;
  assert.ok(saved("developer", ["read_file", "write_file"]).includes("edit_file"), "a developer saved without it");
  assert.ok(saved("writer", ["write_file"]).includes("edit_file"), "any agent that writes files");
  assert.ok(!saved("writer", ["write_document"]).includes("edit_file"), "not agents that don't write files");
});
