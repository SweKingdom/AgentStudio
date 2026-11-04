// Build plan step 4: secrets are found and masked, the security scan can't be waived, and a story is merged only when
// its checks, scan and review attest the same code.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.ANTHROPIC_API_KEY = "test-key-never-sent";

const { findSecrets, redact } = await import("../src/secrets.ts");
const { scanBranch } = await import("../src/scan.ts");
const { createApp } = await import("../src/app.ts");
const { setAnthropicClientForTests } = await import("../src/agents/runner.ts");
const { createItem, getItem, getProject, logActivity, worktreeDir, workspaceDir } = await import("../src/store.ts");
const { commitWork, ensureItemBranch, ensureRepo } = await import("../src/git.ts");
const { all, insert, now } = await import("../src/db.ts");

// Fake but well-formed tokens, built at run time so this file doesn't contain them literally.
const ANTHROPIC = ["sk", "ant", "api03", "A".repeat(40)].join("-");
const GITHUB = `ghp_${"b".repeat(36)}`;

test("secrets: token formats and hard-coded values are found; placeholders and variables are not", () => {
  assert.deepEqual(findSecrets(`const key = "${ANTHROPIC}";`).map((h) => h.name), ["Anthropic API key"]);
  assert.ok(findSecrets(`token: ${GITHUB}`).some((h) => h.name === "GitHub token"));
  assert.ok(findSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----").some((h) => h.name === "private key"));
  assert.deepEqual(findSecrets('const password = "Summer2026!x";').map((h) => h.name), ["hard-coded password"]);
  assert.deepEqual(findSecrets("const password = process.env.SEED_ADMIN_PASSWORD;"), []);
  assert.deepEqual(findSecrets('SECRET_KEY="changeme"'), []);
  assert.deepEqual(findSecrets("apiKey: config.apiKey"), []);
});

test("redaction masks secrets in text and before anything is stored", () => {
  assert.equal(redact(`use ${ANTHROPIC} now`), "use [redacted: Anthropic API key] now");
  assert.equal(redact('db password = "Summer2026!x"'), 'db password = "[redacted]"');
  const ts = now();
  insert("projects", { id: "prj_RED", key: "RED", name: "RED", status: "ready", mode: "simulation", created_at: ts, updated_at: ts, settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1 } });
  logActivity({ projectId: "prj_RED", agentId: "agt_developer", type: "note", summary: `Configured the client with ${GITHUB}`, detail: `export TOKEN=${GITHUB}` });
  const row = all<{ summary: string; detail: string }>("SELECT summary, detail FROM activity WHERE project_id = 'prj_RED'")[0];
  assert.ok(!row.summary.includes(GITHUB) && !row.detail.includes(GITHUB));
  assert.match(row.summary, /\[redacted: GitHub token\]/);
});

async function storyRepo(key: string, settings: Record<string, unknown> = {}) {
  const ts = now();
  const p = { id: `prj_${key}`, key, name: key, mode: "live", settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1, ...settings } } as any;
  insert("projects", { id: p.id, key, name: key, status: "ready", mode: "live", created_at: ts, updated_at: ts, settings: p.settings });
  await ensureRepo(p);
  const story = createItem(p.id, { type: "story", title: "Payments" });
  const { branch } = await ensureItemBranch(p, story);
  return { p, code: story.code, wt: worktreeDir(p, story.code), branch };
}
const write = (dir: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};

test("the scan finds secrets, protected paths, other dependency sources and links out of the repository", async () => {
  const { p, code, wt } = await storyRepo("SCN", { protectedPaths: ["infra/prod/**"] });
  write(wt, "src/stripe.ts", `export const key = "${ANTHROPIC}";\n`);
  write(wt, ".env", "DATABASE_URL=postgres://x\n");
  write(wt, ".env.example", "DATABASE_URL=\n");
  write(wt, "certs/server.key", "x\n");
  write(wt, "infra/prod/main.tf", "x\n");
  write(wt, "package.json", JSON.stringify({ name: "a", dependencies: { left: "^1.0.0", evil: "git+https://example.com/evil.git", local: "file:../outside" } }, null, 2));
  write(wt, "package-lock.json", JSON.stringify({ packages: { "node_modules/x": { resolved: "https://mirror.example.com/x.tgz" }, "node_modules/y": { resolved: "https://registry.npmjs.org/y/-/y-1.0.0.tgz" } } }, null, 2));
  let linked = true;
  try {
    fs.symlinkSync("../../outside.txt", path.join(wt, "link.txt"));
  } catch {
    linked = false; // Windows without the symlink privilege: the link part isn't testable here.
  }
  const f = await scanBranch(p, code);
  const has = (kind: string, file: string) => f.some((x) => x.kind === kind && x.path === file);
  assert.ok(has("secret", "src/stripe.ts"));
  assert.ok(has("protected path", ".env"));
  assert.ok(!has("protected path", ".env.example"), "env templates are fine");
  assert.ok(has("protected path", "certs/server.key"));
  assert.ok(has("protected path", "infra/prod/main.tf"), "the project's own protected paths");
  assert.equal(f.filter((x) => x.kind === "dependency source" && x.path === "package.json").length, 2);
  assert.equal(f.filter((x) => x.kind === "dependency source" && x.path === "package-lock.json").length, 1, "the registry is fine, a mirror isn't");
  if (linked) assert.ok(has("symlink", "link.txt"));
  assert.ok(!f.some((x) => x.detail.includes(ANTHROPIC)), "a finding never repeats the secret");

  const clean = await storyRepo("SCC");
  write(clean.wt, "src/app.ts", "export const timeout = 5000;\n");
  assert.deepEqual(await scanBranch(clean.p, clean.code), []);
});

test("write_file refuses a protected path when it's written, so it never costs a rework round", async () => {
  const { executeTool } = await import("../src/agents/tools.ts");
  const { defaultAgentFor } = await import("../src/agents/store.ts");
  const { p } = await storyRepo("WRP", { protectedPaths: ["infra/prod/**"] });
  const item = createItem(p.id, { type: "story", title: "Config" });
  const ctx = { project: getProject(p.id)!, agent: defaultAgentFor("developer"), item, runId: "run_wrp", iteration: 1, outcome: {} } as any;
  for (const bad of [".env", "./.env.local", "certs\\server.key", "infra/prod/main.tf"]) {
    const r = await executeTool("write_file", { path: bad, content: "x\n" }, ctx);
    assert.equal(r.ok, false, bad);
    assert.match(r.content, /is protected .* no agent may write it/, bad);
    assert.ok(!fs.existsSync(path.join(worktreeDir(p, item.code), bad.replace(/\\/g, "/"))), `${bad} wasn't written`);
  }
  for (const ok of [".env.example", "infra/staging/main.tf", "src/env.ts"]) assert.equal((await executeTool("write_file", { path: ok, content: "x\n" }, ctx)).ok, true, ok);
});

// ---------------------------------------------------------------- the merge gate, end to end

let n = 0;
let fixes = 0;
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
let fixesSecrets = true;

function respond(params: any) {
  const tools: string[] = params.tools.map((t: any) => t.name);
  const turn = params.messages.filter((m: any) => m.role === "assistant").length;
  const text = firstText(params);
  const code = text.match(/(US-\d+)/)?.[1] ?? "";
  if (tools.includes("complete_development")) {
    const fixing = /security scan/.test(text);
    if (turn === 0 && fixing) fixes++;
    const content = fixing && fixesSecrets ? "export const key = process.env.PAYMENT_KEY;\n" : `export const key = "${ANTHROPIC}";\n`;
    if (turn === 0) return reply([use("write_file", { path: "src/pay.ts", content })]);
    if (turn === 1) return reply([use("run_checks", {})]);
    if (turn === 2) return reply([use("complete_development", { code, summary: "Done." })]);
    return reply([{ type: "text", text: "Done." }]);
  }
  if (tools.includes("submit_review")) {
    if (turn === 0) return reply([use("submit_review", { code, verdict: "approved", findings: "" })]);
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

async function pipelineProject(key: string) {
  const agents = await api<any[]>("GET", "/agents");
  const p = await api("POST", "/projects", {
    name: key,
    key,
    description: "x",
    agentIds: agents.filter((a) => ["developer", "qa"].includes(a.role)).map((a) => a.id),
    settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1, checks: { install: "off", commands: [{ name: "ok", command: "node -e 0" }] }, repo: { url: `https://github.com/demo/${key.toLowerCase()}.git`, branch: "main" } },
  });
  const proj = getProject(p.id)!;
  await ensureRepo(proj);
  fs.writeFileSync(path.join(workspaceDir(proj), "package.json"), JSON.stringify({ name: key.toLowerCase(), private: true }));
  await commitWork(proj, { author: "t", email: "t@t", message: "init" });
  return p;
}

test("a secret in a story's code stops its merge: one bounded fix, then it merges; never fixed, it's Blocked", async () => {
  fixesSecrets = true;
  const p = await pipelineProject("SGT");
  const s = createItem(p.id, { type: "story", title: "Pay", state: "To Do", rank: 1, story_points: 3, acceptance_criteria: "### AC 1: Pays\nIt pays." });
  await api("POST", `/projects/${p.id}/start`);
  await waitFor(() => ["Release Ready", "Blocked"].includes(getItem(s.id)!.state), "the story to finish");
  assert.equal(getItem(s.id)!.state, "Release Ready");
  assert.equal(fixes, 1);
  assert.ok(all("SELECT 1 FROM activity WHERE item_id = ? AND summary LIKE '%Security scan%finding%'", s.id).length);
  assert.ok(all("SELECT 1 FROM activity WHERE item_id = ? AND summary LIKE '%attest the same code%'", s.id).length);

  fixesSecrets = false;
  fixes = 0;
  const q = await pipelineProject("SGB");
  const t = createItem(q.id, { type: "story", title: "Pay", state: "To Do", rank: 1, story_points: 3, acceptance_criteria: "### AC 1: Pays\nIt pays." });
  await api("POST", `/projects/${q.id}/start`);
  await waitFor(() => ["Release Ready", "Blocked"].includes(getItem(t.id)!.state), "the story to finish");
  assert.equal(getItem(t.id)!.state, "Blocked");
  assert.equal(fixes, 2, "at most two automatic fixes");
  const msg = all<{ content: string }>("SELECT content FROM messages WHERE item_id = ? AND kind = 'question' ORDER BY id DESC LIMIT 1", t.id)[0].content;
  assert.match(msg, /security scan/);
  assert.ok(!msg.includes(ANTHROPIC), "the secret isn't repeated in the message");
});
