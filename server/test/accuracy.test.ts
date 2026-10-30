import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { FIXTURE_PDF } from "./setup.ts";
import { createApp } from "../src/app.ts";
import { api as router } from "../src/api.ts";
import { all } from "../src/db.ts";
import { registerAccuracy } from "../src/routes/accuracy.ts";
import { unionMs } from "../src/accuracy.ts";

let server: Server;
let base = "";

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await fetch(`${base}/api${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

async function waitFor(pred: () => Promise<boolean>, what: string, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const repo = (name: string) => ({ url: `https://github.com/sirocco-demo/${name}.git`, branch: "main" });

before(async () => {
  // Registered here so the test doesn't depend on the coordinator's wiring in api.ts (a second registration is never reached).
  registerAccuracy(router);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "simulation", simulationSpeed: 0 });
});

after(() => server.close());

test("interval union counts overlapping time once and ignores empty intervals", () => {
  assert.equal(unionMs([]), 0);
  assert.equal(unionMs([{ start: 0, end: 10 }]), 10);
  // Overlap: [0,10] ∪ [5,15] = 15; nested [2,4] adds nothing; disjoint [20,30] adds 10.
  assert.equal(unionMs([{ start: 5, end: 15 }, { start: 20, end: 30 }, { start: 0, end: 10 }, { start: 2, end: 4 }]), 25);
  // Touching intervals merge without double counting; reversed/zero-length ones are ignored.
  assert.equal(unionMs([{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 50, end: 40 }, { start: 60, end: 60 }]), 20);
  // A long run that covers several short parallel ones.
  assert.equal(unionMs([{ start: 0, end: 100 }, { start: 10, end: 20 }, { start: 30, end: 90 }, { start: 95, end: 120 }]), 120);
});

test("no up-front estimate → not available", async () => {
  const agents = await api<any[]>("GET", "/agents");
  await api("POST", "/projects", {
    name: "No estimate",
    key: "NOEST",
    agentIds: agents.map((a) => a.id),
    description: "Agents must log calls against the account. Managers need a weekly report of calls per region.",
    settings: { gates: true, parallelism: 2, budgetUsd: 0, maxRework: 2, repo: repo("no-estimate") },
  });
  const r = await api("GET", "/projects/NOEST/accuracy");
  assert.equal(r.available, false);
  assert.match(r.reason, /estimate/i);
});

test("estimate vs actual after a simulated run", async () => {
  const fd = new FormData();
  fd.append("pdf", new Blob([fs.readFileSync(FIXTURE_PDF)], { type: "application/pdf" }), "field-service-requirements.pdf");
  const agents = await api<any[]>("GET", "/agents");
  fd.append("agentIds", JSON.stringify(agents.map((a) => a.id)));
  const est = await api("POST", "/projects/estimate", fd);
  const created = await api("POST", "/projects", {
    name: "Accuracy check",
    key: "ACC",
    agentIds: agents.map((a) => a.id),
    uploadId: est.uploadId,
    pdfName: "field-service-requirements.pdf",
    pdfPages: est.pdfPages,
    estimate: est.estimate,
    settings: { gates: false, parallelism: 3, budgetUsd: 0, maxRework: 2, repo: repo("accuracy-check") },
  });

  // Created but not started: nothing to compare yet.
  const before = await api("GET", "/projects/ACC/accuracy");
  assert.equal(before.available, false);
  assert.match(before.reason, /activity/i);

  await api("POST", `/projects/${created.id}/start`);
  await waitFor(async () => (await api("GET", "/projects/ACC")).status === "completed", "project completion");

  const r = await api("GET", "/projects/ACC/accuracy");
  assert.equal(r.available, true);
  assert.equal(r.status.state, "final");

  // Totals are exactly the recorded model calls.
  const sums = all<{ c: number; n: number; t: number }>(
    "SELECT SUM(cost_usd) c, COUNT(*) n, SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) t FROM llm_calls WHERE project_id = ?",
    created.id,
  )[0];
  assert.ok(Math.abs(r.totals.actual.costUsd - sums.c) < 1e-9, "actual cost = Σ llm_calls.cost_usd");
  assert.equal(r.totals.actual.calls, sums.n);
  assert.equal(r.totals.actual.tokens, sums.t);
  assert.equal(r.totals.estimated.expected, est.estimate.totalUsd);
  assert.equal(r.totals.estimated.low, est.estimate.lowUsd);
  assert.equal(r.totals.estimated.high, est.estimate.highUsd);
  assert.equal(r.totals.withinRange, sums.c >= est.estimate.lowUsd && sums.c <= est.estimate.highUsd);

  // A row for every agent in the estimate and every agent that made a call; their actuals add up to the total.
  const calledAgents = all<{ agent_id: string }>("SELECT DISTINCT agent_id FROM llm_calls WHERE project_id = ?", created.id).map((x) => x.agent_id);
  for (const id of [...est.estimate.agents.map((a: any) => a.agentId), ...calledAgents]) {
    assert.ok(r.agents.some((a: any) => a.agentId === id), `row for ${id}`);
  }
  for (const a of est.estimate.agents) {
    const row = r.agents.find((x: any) => x.agentId === a.agentId);
    assert.equal(row.estimated.costUsd, a.costUsd);
    assert.ok(row.actual.runs > 0, `${row.name} ran`);
  }
  assert.ok(Math.abs(r.agents.reduce((n: number, a: any) => n + a.actual.costUsd, 0) - sums.c) < 1e-9);
  assert.ok(r.agents.filter((a: any) => a.miss).length <= 2);

  // Stages: every estimated pipeline stage is listed, actuals add up to the total.
  for (const s of ["requirements", "architecture", "planning", "development", "qa", "documentation", "release"]) {
    assert.ok(r.stages.some((x: any) => x.stage === s && x.estimatedUsd > 0), `stage ${s}`);
  }
  assert.ok(Math.abs(r.stages.reduce((n: number, s: any) => n + s.actualUsd, 0) - sums.c) < 1e-9);

  // Scope: the backlog the analyst built vs the document analysis.
  assert.equal(r.scope.estimated.stories, est.estimate.stories);
  assert.equal(r.scope.actual.stories, 19);
  assert.ok(r.scope.byCategory.some((c: any) => c.category === "integration" && c.estimatedStories >= 1 && c.actualStories >= 1));

  // Time: union of run intervals never exceeds the sum of runs nor the elapsed time.
  assert.ok(r.time.aiWallClockMs > 0);
  assert.ok(r.time.aiWallClockMs <= r.time.elapsedMs, "wall-clock ≤ elapsed");
  assert.ok(r.time.aiWallClockMs <= r.time.agentMs + 1, "wall-clock ≤ sum of run durations");
  assert.ok(r.time.estimatedMinutes > 0);

  assert.match(r.verdict, /^Actual cost \$/);
  assert.match(r.verdict, /range/);
});

test("older estimates without detail/breakdown/detected still work", async () => {
  const agents = await api<any[]>("GET", "/agents");
  const fd = new FormData();
  fd.append("pdf", new Blob([fs.readFileSync(FIXTURE_PDF)], { type: "application/pdf" }), "field-service-requirements.pdf");
  fd.append("agentIds", JSON.stringify(agents.map((a) => a.id)));
  const est = await api("POST", "/projects/estimate", fd);
  // Strip what earlier versions didn't store.
  const legacy = { ...est.estimate, detected: undefined, breakdown: undefined, lowUsd: undefined, highUsd: undefined, minutes: undefined, agents: est.estimate.agents.map(({ detail, minutes, ...a }: any) => a) };
  const created = await api("POST", "/projects", {
    name: "Legacy estimate",
    key: "LEG",
    agentIds: agents.map((a) => a.id),
    uploadId: est.uploadId,
    pdfName: "field-service-requirements.pdf",
    pdfPages: est.pdfPages,
    estimate: legacy,
    settings: { gates: false, parallelism: 3, budgetUsd: 0, maxRework: 2, repo: repo("legacy-estimate") },
    start: true,
  });
  await waitFor(async () => (await api("GET", "/projects/LEG")).status === "completed", "legacy project completion");
  const r = await api("GET", `/projects/${created.id}/accuracy`);
  assert.equal(r.available, true);
  assert.ok(Math.abs(r.totals.estimated.low - legacy.totalUsd * 0.6) < 1e-9, "default range when none was stored");
  assert.equal(r.time.estimatedMinutes, null);
  assert.ok(r.scope.byCategory.every((c: any) => c.estimatedStories === null));
  assert.ok(r.verdict.length > 20);
});
