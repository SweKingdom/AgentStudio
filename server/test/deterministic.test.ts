// Deterministic first: checks proven on a git tree are reused until the code changes, a red result costs no review
// call (QA, release), and an objective failure gets a bounded fix. A scripted stand-in plays Claude; checks are real.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.ANTHROPIC_API_KEY = "test-key-never-sent";

const { createApp } = await import("../src/app.ts");
const { setAnthropicClientForTests } = await import("../src/agents/runner.ts");
const { createItem, getItem, getProject, workspaceDir } = await import("../src/store.ts");
const { verify } = await import("../src/attest.ts");
const { ensureRepo, commitWork } = await import("../src/git.ts");
const { all } = await import("../src/db.ts");

let n = 0;
const runs: string[] = [];
const reply = (content: any[]) => ({
  id: `msg_${++n}`,
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content,
  stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
const use = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `toolu_${++n}`, name, input });
const firstText = (params: any) => {
  const c = params.messages[0].content;
  return Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : String(c);
};

/** How the developer behaves: "sneaky" breaks the code after its checks passed; "fixer" repairs the flag file. */
let devMode: "sneaky" | "fixer" | "idle" = "sneaky";
const devRuns = new Map<string, number>();

function respond(params: any) {
  const tools: string[] = params.tools.map((t: any) => t.name);
  const turn = params.messages.filter((m: any) => m.role === "assistant").length;
  const text = firstText(params);
  const code = text.match(/(US-\d+)/)?.[1] ?? "";
  if (tools.includes("complete_development")) {
    if (turn === 0) {
      runs.push(`dev:${code || "base"}`);
      devRuns.set(code, (devRuns.get(code) ?? 0) + 1);
    }
    const first = devRuns.get(code) === 1;
    if (devMode === "idle") return reply([{ type: "text", text: "Can't fix it." }]);
    if (devMode === "fixer" || !first) {
      if (turn === 0) return reply([use("write_file", { path: "flag.txt", content: "ok" })]);
      if (turn === 1) return reply([use("run_checks", {})]);
      if (turn === 2 && code) return reply([use("complete_development", { code, summary: "Fixed." })]);
      return reply([{ type: "text", text: "Done." }]);
    }
    // First run, sneaky: green checks, then a change that breaks them, then the hand-over.
    if (turn === 0) return reply([use("write_file", { path: "flag.txt", content: "ok" })]);
    if (turn === 1) return reply([use("run_checks", {})]);
    if (turn === 2) return reply([use("write_file", { path: "flag.txt", content: "broken" })]);
    if (turn === 3) return reply([use("complete_development", { code, summary: "Built." })]);
    return reply([{ type: "text", text: "Handed over." }]);
  }
  if (tools.includes("submit_review")) {
    if (turn === 0) runs.push(`qa:${code}`);
    if (turn === 0) return reply([use("submit_review", { code, verdict: "approved", findings: "" })]);
    return reply([{ type: "text", text: "Approved." }]);
  }
  if (tools.includes("publish_release")) {
    if (turn === 0) runs.push("release");
    if (turn === 0) return reply([use("publish_release", { version: "1.0.0", notes: "# Release" })]);
    return reply([{ type: "text", text: "Released." }]);
  }
  return reply([{ type: "text", text: "Done." }]);
}

let server: Server;
let base = "";
async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
async function waitFor(pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The check fails while flag.txt says "broken". */
const FLAG_CHECK = { name: "flag", command: "node -e \"process.exit(require('fs').readFileSync('flag.txt','utf8')==='broken'?1:0)\"" };

async function newProject(key: string, roles: string[], flag: string) {
  const agents = await api<any[]>("GET", "/agents");
  const p = await api("POST", "/projects", {
    name: key,
    key,
    description: "x",
    agentIds: agents.filter((a) => roles.includes(a.role)).map((a) => a.id),
    settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 2, checks: { install: "off", commands: [FLAG_CHECK] }, repo: { url: `https://github.com/demo/${key.toLowerCase()}.git`, branch: "main" } },
  });
  const proj = getProject(p.id)!;
  await ensureRepo(proj);
  const dir = workspaceDir(proj);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: key.toLowerCase(), private: true }));
  fs.writeFileSync(path.join(dir, "flag.txt"), flag);
  await commitWork(proj, { author: "t", email: "t@t", message: "init" });
  return p;
}

before(async () => {
  setAnthropicClientForTests({
    beta: { messages: { stream: (params: any) => ({ finalMessage: async () => respond(params) }) } },
    messages: { create: async () => reply([{ type: "text", text: "ok" }]), countTokens: async () => ({ input_tokens: 10 }) },
  });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "live", backend: "api" });
});
after(async () => {
  await api("PUT", "/settings", { mode: "simulation", backend: "auto" });
  server.close();
});

test("checks proven on a tree are reused until the code changes", async () => {
  const p = await newProject("VRF", ["developer"], "ok");
  const proj = getProject(p.id)!;
  const first = await verify(proj, null, "first");
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  const again = await verify(proj, null, "again");
  assert.equal(again.reused, true, "same code: nothing runs");
  fs.writeFileSync(path.join(workspaceDir(proj), "flag.txt"), "broken");
  const changed = await verify(proj, null, "changed");
  assert.equal(changed.reused, false, "changed code: the checks run again");
  assert.equal(changed.ok, false);
  assert.match(changed.failure, /flag/);
});

test("code broken after the developer's green checks goes back without a QA call", async () => {
  devMode = "sneaky";
  const p = await newProject("PRE", ["developer", "qa"], "ok");
  const s = createItem(p.id, { type: "story", title: "Booking", state: "To Do", rank: 1, story_points: 3, acceptance_criteria: "### AC 1: Works\nIt works." });
  await api("POST", `/projects/${p.id}/start`);
  await waitFor(() => ["Release Ready", "Blocked"].includes(getItem(s.id)!.state), "the story to finish");
  assert.equal(getItem(s.id)!.state, "Release Ready");
  assert.deepEqual(runs.filter((r) => r.endsWith(s.code)), [`dev:${s.code}`, `dev:${s.code}`, `qa:${s.code}`], "QA ran once, on the fixed code");
  assert.ok(all("SELECT 1 FROM activity WHERE item_id = ? AND summary LIKE '%checks fail before QA%'", s.id).length);
});

test("a red base branch gets a bounded fix before the release; still red, the release manager isn't called", async () => {
  devMode = "fixer";
  const fixed = await newProject("RLF", ["developer", "release"], "broken");
  const a = createItem(fixed.id, { type: "story", title: "Done work", state: "Release Ready" });
  await api("POST", `/projects/${fixed.id}/release-now`, { itemIds: [a.id] });
  await waitFor(() => getItem(a.id)!.state === "Deployed (Done)", "the release after the fix");
  assert.ok(runs.includes("dev:base") && runs.includes("release"));
  const rel = all<{ validation: string }>("SELECT validation FROM releases WHERE project_id = ?", fixed.id)[0];
  assert.equal(JSON.parse(rel.validation).ok, true, "the release records the checks it rests on");

  devMode = "idle";
  runs.length = 0;
  const stuck = await newProject("RLS", ["developer", "release"], "broken");
  const b = createItem(stuck.id, { type: "story", title: "Done work", state: "Release Ready" });
  await api("POST", `/projects/${stuck.id}/release-now`, { itemIds: [b.id] });
  await waitFor(() => all("SELECT 1 FROM activity WHERE project_id = ? AND summary LIKE '%Release not started%'", stuck.id).length > 0, "the release to be stopped");
  assert.equal(runs.filter((r) => r === "dev:base").length, 2, "two bounded fix attempts");
  assert.ok(!runs.includes("release"), "no release call on a red base");
  assert.equal(getItem(b.id)!.state, "Release Ready");
});
