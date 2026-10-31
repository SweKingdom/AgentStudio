// An empty repository is set up by one story before the others start: parallel stories would each invent their own
// project skeleton, fail their checks and conflict. A scripted stand-in plays Claude; the checks run for real.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.ANTHROPIC_API_KEY = "test-key-never-sent";

const { createApp } = await import("../src/app.ts");
const { setAnthropicClientForTests } = await import("../src/agents/runner.ts");
const { createItem, getItem } = await import("../src/store.ts");
const { baseNeedsSetup } = await import("../src/checks.ts");
const { all } = await import("../src/db.ts");

let n = 0;
const tasks: { code: string; text: string }[] = [];
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

/** Developers write their module (and, on the first story, the project with a passing test script); QA approves. */
function respond(params: any) {
  const tools: string[] = params.tools.map((t: any) => t.name);
  const turn = params.messages.filter((m: any) => m.role === "assistant").length;
  const text = firstText(params);
  const code = text.match(/Implement (US-\d+)/)?.[1] ?? text.match(/Peer-test (US-\d+)/)?.[1] ?? "";
  if (tools.includes("complete_development")) {
    if (turn === 0) {
      tasks.push({ code, text });
      const files = [use("write_file", { path: `src/${code.toLowerCase()}.js`, content: `export const ${code.replace("-", "_")} = 1;\n` })];
      if (/First story on this repository/.test(text)) files.push(use("write_file", { path: "package.json", content: JSON.stringify({ name: "app", private: true, scripts: { test: "node -e 0" } }) }));
      return reply(files);
    }
    if (turn === 1) return reply([use("run_checks", {})]);
    if (turn === 2) return reply([use("complete_development", { code, summary: `${code} built.` })]);
    return reply([{ type: "text", text: "Handed over." }]);
  }
  if (tools.includes("submit_review")) {
    if (turn === 0) return reply([use("run_checks", {})]);
    if (turn === 1) return reply([use("submit_review", { verdict: "approved", findings: "" })]);
    return reply([{ type: "text", text: "Approved." }]);
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
async function waitFor(pred: () => boolean, what: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return;
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

test("an empty repository: one story sets the project up, then the others run in parallel", async () => {
  const agents = await api<any[]>("GET", "/agents");
  const team = agents.filter((a) => a.role === "developer" || a.role === "qa").map((a) => a.id);
  const p = await api("POST", "/projects", {
    name: "Empty repo",
    key: "EMP",
    description: "A small app.",
    agentIds: team,
    settings: { gates: false, parallelism: 2, budgetUsd: 0, maxRework: 1, checks: { install: "off" }, repo: { url: "https://github.com/demo/emp.git", branch: "main" } },
  });
  const project = () => api("GET", `/projects/${p.id}`);
  assert.equal(baseNeedsSetup(await project()), true, "no package.json, no checks");
  const stories = ["Sign in", "Book a class", "Cancel a booking"].map((title, i) => createItem(p.id, { type: "story", title, state: "To Do", rank: i + 1, story_points: 3, acceptance_criteria: "### AC 1: Works\nIt works." }));

  await api("POST", `/projects/${p.id}/start`);
  await waitFor(() => stories.every((s) => ["Release Ready", "Blocked"].includes(getItem(s.id)!.state)), "every story to finish");
  for (const s of stories) assert.equal(getItem(s.id)!.state, "Release Ready", `${s.code} delivered`);

  const at = (code: string, pattern: string) =>
    all<{ created_at: string }>("SELECT a.created_at FROM activity a JOIN work_items w ON w.id = a.item_id WHERE w.code = ? AND w.project_id = ? AND a.summary LIKE ? ORDER BY a.id LIMIT 1", code, p.id, pattern)[0]?.created_at;
  const [first, second, third] = stories.map((s) => s.code);
  const firstMerged = at(first, "Merged %");
  assert.ok(firstMerged, "the first story was merged");
  assert.ok(at(second, "%started development%")! >= firstMerged!, "the second story waited for the project to exist");
  assert.ok(at(third, "%started development%")! >= firstMerged!);
  // Once the project exists, the remaining stories share the two lanes.
  assert.ok(at(third, "%started development%")! < at(second, "Merged %")!, "the other two ran in parallel");

  assert.match(tasks.find((t) => t.code === first)!.text, /First story on this repository/, "the first developer is told to set the project up");
  assert.doesNotMatch(tasks.find((t) => t.code === second)!.text, /First story on this repository/);
  assert.equal(baseNeedsSetup(await project()), false);
  assert.ok(all("SELECT 1 FROM activity WHERE project_id = ? AND summary LIKE '%has no project or checks yet%'", p.id).length);
});
