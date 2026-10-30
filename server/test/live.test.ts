// Live mode end to end, with stand-ins for Claude (scripted, calls the real tools) and the Salesforce CLI. Proves the
// live plumbing — requests, tools, guards, branches, org deploys, push, release — without network or spend.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { FIXTURE_PDF, TMP, fileUrl } from "./setup.ts";

process.env.ANTHROPIC_API_KEY = "test-key-never-sent";
process.env.ARM_SF_BIN = path.resolve(import.meta.dirname, "fixtures/fake-sf.mjs");
process.env.ARM_FAKE_SF_LOG = path.join(TMP, "sf-calls.jsonl");

const { createApp } = await import("../src/app.ts");
const { setAnthropicClientForTests } = await import("../src/agents/runner.ts");
const { listItems, getProject } = await import("../src/store.ts");

// ---------------------------------------------------------------- scripted Claude

const requests: any[] = [];
const events: string[] = [];
let n = 0;
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `toolu_${++n}`, name, input });
const reply = (content: any[], stop_reason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn") => ({
  id: `msg_${++n}`,
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
});
const text = (t: string) => ({ type: "text", text: t });

function firstText(params: any): string {
  const c = params.messages[0].content;
  return Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : String(c);
}
function lastResults(params: any): any[] {
  const last = params.messages[params.messages.length - 1];
  return Array.isArray(last.content) ? last.content.filter((b: any) => b.type === "tool_result") : [];
}
const codes = (s: string, prefix: string) => [...new Set(s.match(new RegExp(`${prefix}-\\d+`, "g")) ?? [])];

function respond(params: any) {
  requests.push(params);
  const tools: string[] = params.tools.map((t: any) => t.name);
  const turn = params.messages.filter((m: any) => m.role === "assistant").length;
  const task = firstText(params);
  const results = lastResults(params);
  const resultText = results.map((r: any) => String(r.content)).join("\n");
  for (const r of results) if (r.is_error) events.push(`error:${String(r.content).slice(0, 60)}`);

  if (tools.includes("create_work_item")) {
    if (turn === 0)
      return reply([
        toolUse("write_document", { kind: "project_brief", title: "Project brief", content: "# Brief\nService agents need cases from email." }),
        toolUse("describe_object", { object: "Case" }),
        toolUse("create_work_item", { type: "epic", title: "Case management", category: "configuration" }),
      ]);
    if (turn === 1) return reply([toolUse("create_work_item", { type: "feature", title: "Case intake", category: "configuration", parent_code: codes(resultText, "EP")[0] })]);
    if (turn === 2) {
      const ft = codes(resultText, "FT")[0];
      return reply([
        toolUse("create_work_item", { type: "story", title: "Create a case from an email", category: "development", parent_code: ft, user_story: "As an agent, I want cases from emails, so that nothing is lost.", acceptance_criteria: "### AC 1: Case created\nAn email creates a case." }),
        toolUse("create_work_item", { type: "story", title: "Route cases by region", category: "development", parent_code: ft, user_story: "As a dispatcher, I want routing, so that teams get their cases.", acceptance_criteria: "### AC 1: Routed\nA case goes to its region's queue." }),
      ]);
    }
    return reply([text("Backlog ready: 1 epic, 1 feature, 2 stories.")]);
  }
  if (tools.includes("plan_item")) {
    if (turn === 0) return reply([toolUse("list_items", {})]);
    if (turn === 1)
      return reply([
        ...codes(resultText, "US").map((c, i) => toolUse("plan_item", { code: c, story_points: 3, moscow: "Must", priority: 1, sprint: 1, rank: i + 1, wsjf: 5 })),
        toolUse("write_document", { kind: "delivery_plan", title: "Delivery plan", content: "# Plan\nSprint 1: both stories." }),
      ]);
    return reply([text("Planned.")]);
  }
  if (tools.includes("deploy_story")) {
    const code = codes(task, "US")[0];
    const cls = `CaseSvc${code.replace("-", "")}`;
    const dir = "force-app/main/default/classes";
    const meta = `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n`;
    if (turn === 0)
      return reply([
        toolUse("write_file", { path: `${dir}/${cls}.cls`, content: `public class ${cls} {\n  public static Integer run() {\n    return COMPILE_ERROR;\n  }\n}\n` }),
        toolUse("write_file", { path: `${dir}/${cls}.cls-meta.xml`, content: meta }),
        toolUse("write_file", { path: `${dir}/${cls}Test.cls`, content: `@IsTest\nprivate class ${cls}Test {\n  @IsTest static void testIt() { System.assertEquals(1, ${cls}.run()); }\n}\n` }),
        toolUse("write_file", { path: `${dir}/${cls}Test.cls-meta.xml`, content: meta }),
        toolUse("complete_development", { code, summary: "Done (too early)." }),
      ]);
    if (turn === 1) return reply([toolUse("deploy_story", {})]);
    if (turn === 2) {
      events.push(`dev-saw:${code}:${/❌ Failed/.test(resultText) ? "failure" : "success"}`);
      return reply([toolUse("write_file", { path: `${dir}/${cls}.cls`, content: `public class ${cls} {\n  public static Integer run() {\n    return 1;\n  }\n}\n` }), toolUse("deploy_story", {})]);
    }
    if (turn === 3) {
      events.push(`dev-saw:${code}:${/✅ Succeeded/.test(resultText) ? "success" : "failure"}`);
      return reply([toolUse("complete_development", { code, summary: "Case service with tests; validated in the org." })]);
    }
    return reply([text(`${code} implemented.`)]);
  }
  if (tools.includes("run_apex_tests")) {
    const code = codes(task, "US")[0];
    if (turn === 0) return reply([toolUse("submit_review", { code, verdict: "approved", findings: "Too early." }), toolUse("run_apex_tests", {})]);
    if (turn === 1)
      return reply([
        toolUse("record_test_result", { code, ac_ref: "AC 1", result: "pass", notes: "Apex tests passed in the org." }),
        toolUse("submit_review", { code, verdict: "approved", findings: "All checks pass." }),
      ]);
    return reply([text("Approved.")]);
  }
  if (tools.includes("publish_release")) {
    if (turn === 0) return reply([toolUse("build_manifest", {}), toolUse("validate_deployment", {})]);
    if (turn === 1) return reply([toolUse("run_anonymous_apex", { code: "System.debug('smoke');" }), toolUse("run_soql", { soql: "SELECT Id, Subject FROM Case LIMIT 5" })]);
    if (turn === 2) return reply([toolUse("publish_release", { version: "1.0.0", notes: "# Release 1.0.0\nTarget org: trailhead." })]);
    return reply([text("Released.")]);
  }
  if (tools.includes("update_work_item") && !tools.includes("write_file")) {
    if (turn === 0) return reply([toolUse("write_document", { kind: "solution_design", title: "Solution design", content: "# Design\nCase + routing." })]);
    return reply([text("Design ready.")]);
  }
  // writer
  const code = codes(task, "US")[0];
  if (turn === 0 && code) return reply([toolUse("write_document", { kind: "task_doc", title: `${code} task document`, item_code: code, content: `# ${code}\nHow it works.` })]);
  return reply([text("Documented.")]);
}

const fakeClient = {
  beta: { messages: { stream: (params: any) => ({ finalMessage: async () => respond(params) }) } },
  messages: {
    create: async () => reply([text("Answer from a consulted agent.")]),
    countTokens: async () => ({ input_tokens: 4321 }),
  },
};

// ---------------------------------------------------------------- app

let server: Server;
let base = "";
async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await fetch(`${base}/api${p}`, init);
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${t}`);
  return (t ? JSON.parse(t) : null) as T;
}
async function waitFor(pred: () => Promise<boolean>, what: string, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const remote = path.join(TMP, "live-remote.git");
const sfCalls = () => fs.readFileSync(process.env.ARM_FAKE_SF_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l).args as string[]);

before(async () => {
  setAnthropicClientForTests(fakeClient);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "live" });
  fs.mkdirSync(remote, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
});
after(() => server.close());

test("repository connection check reads and dry-run pushes without changing the remote", async () => {
  const r = await api("POST", "/repo/test", { url: fileUrl(remote) });
  assert.equal(r.read, true);
  assert.equal(r.write, true, r.output);
  assert.equal(execFileSync("git", ["for-each-ref"], { cwd: remote, encoding: "utf8" }).trim(), "", "nothing was pushed");
  const bad = await api("POST", "/repo/test", { url: fileUrl(path.join(TMP, "missing.git")) });
  assert.equal(bad.read, false);
});

// The scripted Claude below still drives the Salesforce tools (deploy_story, run_apex_tests, validate_deployment) that
// AgentStudio removed. Skipped until it is rewritten around run_checks (docs/BUILD-PLAN.md, step 2b).
test.skip("live pipeline: PDF → backlog → build with org fix loop → QA in org → merge & push → release", async () => {
  const fd = new FormData();
  fd.append("pdf", new Blob([fs.readFileSync(FIXTURE_PDF)], { type: "application/pdf" }), "requirements.pdf");
  const agents = await api<any[]>("GET", "/agents");
  fd.append("agentIds", JSON.stringify(agents.map((a) => a.id)));
  const est = await api("POST", "/projects/estimate", fd);
  await api("POST", "/projects", {
    name: "Live Demo",
    key: "LIV",
    agentIds: agents.map((a) => a.id),
    uploadId: est.uploadId,
    pdfName: "requirements.pdf",
    pdfPages: est.pdfPages,
    estimate: est.estimate,
    settings: { gates: false, parallelism: 2, budgetUsd: 0, maxRework: 2, targetOrg: "trailhead", repo: { url: fileUrl(remote), branch: "main", push: true } },
    start: true,
  });
  await waitFor(async () => ["completed", "failed"].includes((await api("GET", "/projects/LIV")).status), "live project to finish");
  const p = await api("GET", "/projects/LIV");
  assert.equal(p.status, "completed", p.error ?? "");
  assert.equal(p.mode, "live");

  // Requests are well-formed live calls: PDF attached for the analyst, adaptive thinking, effort, caching, eager tools.
  const analyst = requests.find((r) => r.tools.some((t: any) => t.name === "create_work_item"));
  assert.ok(analyst.messages[0].content.some((b: any) => b.type === "document" && b.source.media_type === "application/pdf"), "PDF attached");
  assert.deepEqual(analyst.thinking, { type: "adaptive" });
  assert.ok(analyst.output_config.effort);
  assert.equal(analyst.system[0].cache_control.type, "ephemeral");
  assert.ok(analyst.tools.every((t: any) => t.eager_input_streaming === true));
  assert.match(analyst.system[0].text, /Knowledge/, "knowledge packs in the system prompt");
  const dev = requests.find((r) => r.tools.some((t: any) => t.name === "deploy_story"));
  assert.match(firstText(dev), /## Salesforce org[\s\S]*trailhead \(production — validate only/, "agents are told about the org");
  // Efficient context: the developer starts with its story card (no get_item round trip), not the whole brief; the
  // project block carries its own cache breakpoint; QA gets the developer's hand-over and the files the story changed.
  const devText = firstText(dev);
  assert.match(devText, /## US-\d+ — /, "story card in the first message");
  assert.match(devText, /### Acceptance criteria/);
  assert.match(devText, /## Files on your branch/);
  assert.doesNotMatch(devText, /## Project brief/, "no full brief for the developer");
  assert.equal(dev.messages[0].content.filter((b: any) => b.cache_control).length, 1, "project block is cached");
  const qa = requests.find((r) => r.tools.some((t: any) => t.name === "run_apex_tests"));
  assert.match(firstText(qa), /## Developer's hand-over/);
  assert.match(firstText(qa), /## Files US-\d+ changed on its branch[\s\S]*CaseSvc/);
  const names = (r: any) => r.tools.map((t: any) => t.name);
  const writer = requests.find((r) => names(r).includes("update_document_section") && !names(r).includes("update_work_item") && !names(r).includes("publish_release"));
  assert.match(firstText(writer), /update_document_section/);
  assert.match(firstText(writer), /## What was built \(developer\)/);

  // The PDF became a backlog through tool calls.
  const items = listItems(getProject("LIV")!.id);
  assert.deepEqual(items.map((i) => i.type).sort(), ["epic", "feature", "story", "story"]);
  const stories = items.filter((i) => i.type === "story");
  for (const s of stories) {
    assert.equal(s.state, "Deployed (Done)", `${s.code} released`);
    assert.match(s.branch ?? "", new RegExp(`^feature/${s.code}-`));
    assert.match(s.acceptance_criteria, /AC 1/);
  }

  // Guards: no hand-over before the org validates; no approval before the org tests run.
  assert.ok(events.some((e) => e.startsWith("error:Validate the story in the org first")));
  assert.ok(events.some((e) => e.startsWith("error:Run the story's Apex tests in the org")));
  // Fix loop: the developer saw the org's compile error, fixed it, then saw success.
  for (const s of stories) {
    assert.ok(events.includes(`dev-saw:${s.code}:failure`), `${s.code} saw the compile error`);
    assert.ok(events.includes(`dev-saw:${s.code}:success`), `${s.code} validated after the fix`);
  }
  // Salesforce CLI calls: check-only on production, the story's tests, release validation, no anonymous Apex on prod.
  const calls = sfCalls();
  const storyDeploys = calls.filter((a) => a[0] === "project" && a[2] === "start" && a.includes("--source-dir"));
  assert.ok(storyDeploys.length >= stories.length * 3, "dev validates (twice) and QA runs tests per story");
  assert.ok(storyDeploys.every((a) => a.includes("--dry-run")), "never a real per-story deploy on production");
  assert.ok(storyDeploys.every((a) => a[a.indexOf("--target-org") + 1] === "trailhead"));
  assert.ok(storyDeploys.some((a) => a.includes("--tests") && a.includes("RunSpecifiedTests")));
  assert.ok(calls.some((a) => a[0] === "project" && a[2] === "validate" && a.includes("--manifest")), "release validation");
  assert.ok(!calls.some((a) => a[0] === "apex" && a[1] === "run"), "anonymous Apex refused on production");
  assert.ok(calls.some((a) => a[0] === "sobject" && a[1] === "describe"), "the analyst read the real data model");

  // Git: pushed branches, merged main, release tag on the remote.
  const refs = execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: remote, encoding: "utf8" });
  assert.match(refs, /refs\/heads\/main/);
  for (const s of stories) assert.ok(refs.includes(`refs/heads/${s.branch}`), `${s.branch} pushed`);
  assert.match(refs, /refs\/tags\/v1\.0\.0/);
  const log = execFileSync("git", ["log", "--format=%s", "main"], { cwd: remote, encoding: "utf8" });
  for (const s of stories) assert.ok(log.includes(`Merge ${s.branch}`), `${s.branch} merged into main on the remote`);
  const fixed = execFileSync("git", ["show", `main:force-app/main/default/classes/CaseSvc${stories[0].code.replace("-", "")}.cls`], { cwd: remote, encoding: "utf8" });
  assert.match(fixed, /return 1;/, "the fixed code is what reached main");

  // Real (not simulated) costs: exactly the usage Claude reported × the official price of the model that answered.
  const costs = await api("GET", "/costs?projectId=LIV");
  assert.ok(costs.totals.calls > 10);
  assert.equal(costs.totals.simulatedUsd, 0);
  assert.equal(costs.totals.inputTokens, costs.totals.calls * 1200);
  assert.equal(costs.totals.outputTokens, costs.totals.calls * 300);
  assert.equal(costs.totals.cacheReadTokens, costs.totals.calls * 800);
  const perCall = (1200 * 4 + 300 * 20 + 800 * 0.2) / 1e6; // Opus 5.5: $4 in, $20 out, $0.20 cache read per MTok
  assert.ok(Math.abs(costs.totals.costUsd - costs.totals.calls * perCall) < 1e-9, `${costs.totals.costUsd} vs ${costs.totals.calls * perCall}`);
  assert.ok(costs.totals.busyMs >= 0);
});

test("official prices, including Haiku 5.5's long-prompt rate card", async () => {
  const { costOf } = await import("../src/pricing.ts");
  const u = (i: number, o: number, r = 0, w = 0) => ({ input_tokens: i, output_tokens: o, cache_read_tokens: r, cache_write_tokens: w });
  assert.equal(costOf("claude-opus-5-5", u(1e6, 1e6, 1e6, 1e6)), 4 + 20 + 0.2 + 5);
  assert.equal(costOf("claude-sonnet-5-5", u(1e6, 1e6, 1e6, 1e6)), 2 + 10 + 0.2 + 2.5);
  assert.equal(costOf("claude-fable-5-1", u(1e6, 1e6, 1e6, 1e6)), 10 + 50 + 0.25 + 12.5);
  assert.ok(Math.abs(costOf("claude-haiku-5-5", u(100_000, 1e6)) - (0.01 + 0.5)) < 1e-12, "≤100K prompt: $0.10/$0.50");
  assert.ok(Math.abs(costOf("claude-haiku-5-5", u(100_001, 1e6)) - (100_001 * 0.5 / 1e6 + 2.5)) < 1e-12, ">100K prompt: $0.50/$2.50");
});
