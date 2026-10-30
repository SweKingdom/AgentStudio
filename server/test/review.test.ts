import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { TMP, fileUrl } from "./setup.ts";
import { createApp } from "../src/app.ts";
import { all } from "../src/db.ts";
import { listAgents } from "../src/agents/store.ts";
import { estimateProject } from "../src/estimate.ts";
import { codeReviewMode, needsCodeReview } from "../src/review.ts";

// PR comments go through the `gh` stand-in on a local bare repository (see pr.test.ts).
process.env.ARM_GH_BIN = path.resolve(import.meta.dirname, "fixtures/fake-gh.mjs");
process.env.ARM_FORCE_GITHUB = "1";

let server: Server;
let base = "";

async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function waitFor(pred: () => Promise<boolean>, what: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// Three stories: a configuration, a reporting and an integration story (the one that fails QA once).
const DESCRIPTION = "Service agents must create a case from an email automatically. Managers need a weekly report of open cases per team. Agents should see the customer's order status from the ERP API.";

async function run(key: string, codeReview: string, push = false) {
  const remote = path.join(TMP, `${key.toLowerCase()}-remote.git`);
  fs.mkdirSync(remote, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
  const state = path.join(TMP, `${key}-gh.json`);
  Object.assign(process.env, { ARM_FAKE_GH_REMOTE: remote, ARM_FAKE_GH_STATE: state, ARM_FAKE_GH_LOG: path.join(TMP, `${key}-gh.log`) });
  delete process.env.ARM_FAKE_GH_FAIL;
  const agents = await api<any[]>("GET", "/agents");
  const team = ["requirements", "architect", "developer", "qa", "writer"].map((role) => agents.find((a) => a.role === role)!.id);
  await api("POST", "/projects", {
    name: `Review ${key}`,
    key,
    description: DESCRIPTION,
    agentIds: team,
    settings: { gates: false, parallelism: 2, budgetUsd: 0, maxRework: 2, repo: { url: fileUrl(remote), branch: "main", push } },
  });
  await api("PATCH", `/projects/${key}`, { settings: { codeReview } });
  await api("POST", `/projects/${key}/start`);
  await waitFor(async () => {
    const p = await api("GET", `/projects/${key}`);
    return p.status === "completed" && !p.running && p.jobs.length === 0;
  }, `${key} to complete`);
  const items = (await api<any[]>("GET", `/projects/${key}/items`)).filter((i) => i.branch);
  const phases = all<{ item_id: string; phase: string; iteration: number; outcome: string | null }>(
    "SELECT ph.item_id, ph.phase, ph.iteration, ph.outcome FROM item_phases ph JOIN projects p ON p.id = ph.project_id WHERE p.key = ? AND ph.phase IN ('development', 'qa', 'review') ORDER BY ph.id",
    key,
  );
  const reviewRuns = all<{ n: number }>("SELECT COUNT(*) n FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.key = ? AND r.stage = 'review'", key)[0].n;
  const prs = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")).prs : [];
  return { items, phases, reviewRuns, prs, architect: agents.find((a) => a.role === "architect")! };
}

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "simulation", simulationSpeed: 0, dailyLimitUsd: 0, monthlyLimitUsd: 0 });
});

after(() => server.close());

test("which stories get a code review", () => {
  assert.equal(codeReviewMode(undefined), "off");
  assert.equal(codeReviewMode("bogus"), "off");
  const p = (codeReview: any) => ({ settings: { codeReview } }) as any;
  assert.equal(needsCodeReview(p("off"), { type: "story", category: "integration" }), false);
  assert.equal(needsCodeReview(p("complex"), { type: "story", category: "integration" }), true);
  assert.equal(needsCodeReview(p("complex"), { type: "story", category: "data_migration" }), true);
  assert.equal(needsCodeReview(p("complex"), { type: "story", category: "configuration" }), false);
  assert.equal(needsCodeReview(p("all"), { type: "bug", category: "configuration" }), true);
  assert.equal(needsCodeReview(p("all"), { type: "feature", category: "development" }), false);
});

test("code review off: no review runs", async () => {
  const r = await run("RVO", "off");
  assert.ok(r.items.length >= 3);
  assert.equal(r.reviewRuns, 0);
  assert.ok(!r.phases.some((x) => x.phase === "review"));
  for (const it of r.items) assert.equal(it.state, "Release Ready");
});

test("complex: only complex stories are reviewed; changes requested loop back to dev, QA, then review", async () => {
  const r = await run("RVC", "complex", true);
  const reviewedIds = new Set(r.phases.filter((x) => x.phase === "review").map((x) => x.item_id));
  for (const it of r.items) {
    assert.equal(it.state, "Release Ready", `${it.code} delivered`);
    assert.equal(reviewedIds.has(it.id), ["integration", "development", "data_migration"].includes(it.category), `${it.code} (${it.category}) reviewed only if complex`);
  }
  const story = r.items.find((i) => i.category === "integration")!;
  const seq = r.phases.filter((x) => x.item_id === story.id).map((x) => `${x.phase}:${x.outcome}`);
  assert.deepEqual(seq, ["development:done", "qa:changes_requested", "development:done", "qa:approved", "review:changes_requested", "development:done", "qa:approved", "review:approved"]);
  assert.equal(story.rework_count, 2, "QA and the code review each sent it back once");
  assert.equal(r.reviewRuns, 2);
  const detail = await api("GET", `/items/${story.id}`);
  assert.ok(detail.comments.some((c: any) => c.author_id === r.architect.id && /^Code review \(iteration \d+\): ❌ changes requested/.test(c.content)));
  assert.ok(detail.messages.some((m: any) => m.kind === "rework" && new RegExp(`^Code review of ${story.code} requested changes`).test(m.content)), "the developer got the findings");
  assert.ok(detail.activity.some((a: any) => a.summary === `${r.architect.name} code review of ${story.code}: ✅ approved`));
  // The review is on the story's PR, signed by the architect.
  const pr = r.prs.find((p: any) => p.headRefName === story.branch);
  assert.ok(pr, "the story has a PR");
  const reviews = pr.comments.filter((c: string) => c.startsWith(`### ${r.architect.name} (architect) — code review:`));
  assert.equal(reviews.length, 2);
  assert.match(reviews[0], /❌ changes requested/);
  assert.match(reviews[1], /✅ approved/);
  assert.match(reviews[1], new RegExp(`— ${r.architect.name} \\(architect\\)$`));
  assert.equal(pr.state, "MERGED");
});

test("all: every story is reviewed", async () => {
  const r = await run("RVA", "all");
  const reviewedIds = new Set(r.phases.filter((x) => x.phase === "review").map((x) => x.item_id));
  for (const it of r.items) assert.ok(reviewedIds.has(it.id), `${it.code} reviewed`);
});

test("the estimate counts the architect's review runs", () => {
  const agents = listAgents().filter((a) => ["requirements", "architect", "developer", "qa", "writer"].includes(a.role));
  const stories = [
    { title: "A", category: "integration", points: 5 },
    { title: "B", category: "configuration", points: 2 },
    { title: "C", category: "development", points: 3 },
  ];
  const input = { agents, pdfPages: null, pdfTokens: null, descriptionChars: 500, stories, parallelism: 2, maxRework: 2 };
  const off = estimateProject(input);
  const complex = estimateProject({ ...input, codeReview: "complex" });
  const everything = estimateProject({ ...input, codeReview: "all" });
  const arch = (e: typeof off) => e.agents.find((a) => a.role === "architect")!;
  assert.equal(off.breakdown.codeReview.stories, 0);
  assert.equal(arch(off).detail.review, undefined);
  assert.equal(complex.breakdown.codeReview.stories, 2);
  assert.equal(everything.breakdown.codeReview.stories, 3);
  assert.ok(arch(complex).runs > arch(off).runs);
  assert.ok(arch(complex).costUsd > arch(off).costUsd && arch(everything).costUsd > arch(complex).costUsd);
  assert.ok(Math.abs(arch(complex).costUsd - arch(off).costUsd - arch(complex).detail.review!.costUsd) < 1e-9, "review cost is part of the architect's total");
  assert.ok(complex.totalUsd > off.totalUsd);
  assert.ok(complex.assumptions.some((a) => /Architect code review on 2 stories/.test(a)));
});
