// Rework that can't get anywhere stops early: QA isn't run on work the developer didn't hand over, and the same check
// failing the same way twice blocks the story. Installed dependencies stay out of file lists, and foundation tasks
// (the repository skeleton) come before every other item. A scripted stand-in plays Claude; the checks run for real.
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
const { createItem, getItem, listWorkspaceFiles, workspaceDir } = await import("../src/store.ts");
const { executeTool } = await import("../src/agents/tools.ts");
const { defaultAgentFor } = await import("../src/agents/store.ts");
const { dependenciesOf } = await import("../src/orchestrator.ts");
const { all } = await import("../src/db.ts");

let n = 0;
const roles: string[] = [];
const reply = (content: any[]) => ({
  id: `msg_${++n}`,
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content,
  stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

/** The developer runs the checks, sees them fail and stops without handing over; QA (if asked) would approve. */
function respond(params: any) {
  const tools: string[] = params.tools.map((t: any) => t.name);
  const turn = params.messages.filter((m: any) => m.role === "assistant").length;
  const role = tools.includes("complete_development") ? "developer" : tools.includes("submit_review") ? "qa" : "other";
  if (turn === 0) roles.push(role);
  if (role === "developer") {
    if (turn === 0) return reply([{ type: "tool_use", id: `toolu_${++n}`, name: "run_checks", input: {} }]);
    return reply([{ type: "text", text: "The lint config is missing, so I can't hand this over." }]);
  }
  if (role === "qa" && turn === 0) return reply([{ type: "tool_use", id: `toolu_${++n}`, name: "submit_review", input: { verdict: "approved", findings: "" } }]);
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

async function waitFor(pred: () => Promise<boolean> | boolean, what: string, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
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

test("a story that isn't handed over skips QA, and the same failure twice blocks it", async () => {
  const agents = await api<any[]>("GET", "/agents");
  const team = agents.filter((a) => a.role === "developer" || a.role === "qa").map((a) => a.id);
  const p = await api("POST", "/projects", {
    name: "Stuck rework",
    key: "STK",
    description: "Members book classes.",
    agentIds: team,
    settings: {
      gates: false,
      parallelism: 1,
      budgetUsd: 0,
      maxRework: 3,
      repo: { url: "https://github.com/demo/stk.git", branch: "main" },
      checks: { install: "off", commands: [{ name: "lint", command: "node -e \"console.error('eslint.config.js not found'); process.exit(1)\"" }] },
    },
  });
  const story = createItem(p.id, { type: "story", title: "Book a class", state: "To Do", story_points: 3, acceptance_criteria: "### AC 1: Booked\nA place is booked." });
  await api("POST", `/items/${story.id}/start`);
  await waitFor(() => getItem(story.id)!.state === "Blocked", "the story to be blocked");

  assert.deepEqual(roles, ["developer", "developer"], "two developer runs, no QA, then it stops (not 4 rounds of both)");
  const notes = all<{ summary: string }>("SELECT summary FROM activity WHERE item_id = ? ORDER BY id", story.id).map((a) => a.summary);
  assert.ok(notes.some((s) => /wasn't handed over — back to development, QA skipped/.test(s)));
  assert.ok(notes.some((s) => /stopped early: the same check failure twice/.test(s)));
  const msg = all<{ content: string }>("SELECT content FROM messages WHERE item_id = ? AND kind = 'question' ORDER BY id DESC LIMIT 1", story.id)[0].content;
  assert.match(msg, /same check the same way twice in a row \(lint\)/);
});

test("installed dependencies stay out of file lists, and long listings are capped", async () => {
  const p = { id: "prj_none", key: "LST", settings: {} } as any;
  const dir = workspaceDir(p);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "export {};");
  for (let i = 0; i < 400; i++) {
    const f = path.join(dir, "node_modules", `pkg${i}`, "index.js");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "");
  }
  assert.deepEqual(listWorkspaceFiles(p), ["src/app.ts"]);

  for (let i = 0; i < 350; i++) fs.writeFileSync(path.join(dir, "src", `m${i}.ts`), "");
  const dev = { ...defaultAgentFor("developer"), tools: ["list_files"] };
  const r = await executeTool("list_files", {}, { project: p, agent: dev, runId: "run_l", iteration: 1, outcome: {} } as never);
  const out = JSON.parse(r.content);
  assert.equal(out.files.length, 300);
  assert.equal(out.more, 51);
  assert.match(out.hint, /prefix/);
});

test("foundation tasks come before every other item", () => {
  const item = (code: string, type: string, category: string, depends_on: string[] = []) => ({ id: code, code, type, category, depends_on }) as any;
  const skeleton = item("TK-1", "task", "devops");
  const stripe = item("TK-2", "task", "configuration");
  const story = item("US-3", "story", "development", ["TK-2"]);
  const monitoring = item("TK-4", "task", "devops", ["US-3"]);
  const items = [skeleton, stripe, story, monitoring];
  assert.deepEqual(dependenciesOf(skeleton, items), [], "the foundation itself waits for nothing");
  assert.deepEqual(dependenciesOf(stripe, items), ["TK-1"]);
  assert.deepEqual(dependenciesOf(story, items).sort(), ["TK-1", "TK-2"]);
  assert.deepEqual(dependenciesOf(monitoring, items).sort(), ["TK-1", "US-3"], "a DevOps task with dependencies isn't a foundation");
});
