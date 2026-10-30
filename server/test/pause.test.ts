import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { limitFromApiError } from "../src/pause.ts";
import { all } from "../src/db.ts";
import { autoResumeTick } from "../src/orchestrator.ts";

let server: Server;
let base = "";

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function waitFor(pred: () => Promise<boolean>, what: string, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const DESCRIPTION =
  "Service agents must create a case from an email automatically. Dispatchers must assign cases to a team by region. Managers need a weekly report of open cases per team. Legacy customers must be migrated from the old CRM. Agents should see the customer's order status from the ERP API.";

async function newProject(key: string, budgetUsd = 0) {
  const agents = await api<any[]>("GET", "/agents");
  await api("POST", "/projects", {
    name: `Pause ${key}`,
    key,
    description: DESCRIPTION,
    agentIds: agents.map((a) => a.id),
    settings: { gates: false, parallelism: 2, budgetUsd, maxRework: 2, repo: { url: `https://github.com/demo/${key.toLowerCase()}.git`, branch: "main" } },
    start: true,
  });
}

const project = (key: string) => api("GET", `/projects/${key}`);
const runningRuns = () => all<{ n: number }>("SELECT COUNT(*) n FROM runs WHERE status = 'running'")[0].n;

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "simulation", simulationSpeed: 0.02, dailyLimitUsd: 0, monthlyLimitUsd: 0 });
});

after(() => server.close());

test("graceful pause: running steps finish, nothing new starts, resume continues", async () => {
  await newProject("PGR");
  await waitFor(async () => (await project("PGR")).stage === "delivery" && runningRuns() > 0, "delivery to start");
  await api("POST", "/projects/PGR/pause", { mode: "graceful" });
  assert.equal((await project("PGR")).pausing, true);
  await waitFor(async () => !(await project("PGR")).running, "graceful pause to settle");
  const p = await project("PGR");
  assert.equal(p.status, "paused");
  assert.equal(runningRuns(), 0);
  assert.equal(all<{ n: number }>("SELECT COUNT(*) n FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.key = 'PGR' AND r.status = 'stopped'")[0].n, 0, "no agent step was cut off");
  await api("POST", "/projects/PGR/start");
  await waitFor(async () => (await project("PGR")).status === "completed", "completion after resume");
});

test("stop now cancels in-flight steps; they run again on resume", async () => {
  await newProject("PST");
  await waitFor(async () => (await project("PST")).stage === "delivery" && runningRuns() > 0, "delivery to start");
  await api("POST", "/projects/PST/pause", { mode: "now" });
  await waitFor(async () => !(await project("PST")).running, "stop");
  assert.ok(all<{ n: number }>("SELECT COUNT(*) n FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.key = 'PST' AND r.status = 'stopped'")[0].n > 0);
  await api("POST", "/projects/PST/start");
  await waitFor(async () => (await project("PST")).status === "completed", "completion after resume");
});

test("pause all blocks new work and resume all continues what was running", async () => {
  await newProject("PAL");
  await waitFor(async () => runningRuns() > 0, "work to start");
  await api("POST", "/pause-all", { mode: "graceful" });
  await waitFor(async () => !(await project("PAL")).running, "global pause");
  const meta = await api("GET", "/meta");
  assert.equal(meta.globalPause.kind, "user");
  assert.ok(meta.globalPause.projects.length >= 1);
  await assert.rejects(api("POST", "/projects/PAL/start"), /All work is paused/);
  const r = await api("POST", "/resume-all");
  assert.ok(r.resumed.includes("PAL"));
  assert.equal((await api("GET", "/meta")).globalPause, null);
  await waitFor(async () => (await project("PAL")).status === "completed", "completion after resume all");
});

test("reaching the daily spend limit pauses everything until it's raised", async () => {
  const spent = (await api("GET", "/meta")).spend.today;
  await api("PUT", "/settings", { dailyLimitUsd: spent + 0.05, autoResumeLimits: true });
  await newProject("PLM");
  await waitFor(async () => Boolean((await api("GET", "/meta")).globalPause), "limit pause");
  const meta = await api("GET", "/meta");
  assert.equal(meta.globalPause.kind, "daily_limit");
  assert.ok(meta.globalPause.resumeAt, "auto-resume time set (tomorrow)");
  assert.equal(meta.globalPause.autoResume, true);
  await waitFor(async () => !(await project("PLM")).running, "project paused");
  assert.match((await project("PLM")).error, /Daily spend limit/);
  // Still over the limit: resume is refused, and the auto-resume tick doesn't resume either.
  await assert.rejects(api("POST", "/resume-all"), /still reached/);
  autoResumeTick();
  assert.ok((await api("GET", "/meta")).globalPause);
  // Raise the limit → resume → finishes.
  await api("PUT", "/settings", { dailyLimitUsd: 0 });
  await api("POST", "/resume-all");
  await waitFor(async () => (await project("PLM")).status === "completed", "completion after raising the limit");
});

test("reaching the monthly spend limit pauses everything until it's raised", async () => {
  const spent = (await api("GET", "/meta")).spend.month;
  await api("PUT", "/settings", { monthlyLimitUsd: spent + 0.05, autoResumeLimits: true });
  await newProject("PLN");
  await waitFor(async () => Boolean((await api("GET", "/meta")).globalPause), "limit pause");
  const meta = await api("GET", "/meta");
  assert.equal(meta.globalPause.kind, "monthly_limit");
  assert.ok(meta.globalPause.resumeAt, "auto-resume time set (next month)");
  await waitFor(async () => !(await project("PLN")).running, "project paused");
  assert.match((await project("PLN")).error, /Monthly spend limit/);
  await assert.rejects(api("POST", "/resume-all"), /still reached/);
  await api("PUT", "/settings", { monthlyLimitUsd: 0 });
  await api("POST", "/resume-all");
  await waitFor(async () => (await project("PLN")).status === "completed", "completion after raising the limit");
});

test("a project's budget stops only that project until the budget is raised", async () => {
  await newProject("PLB", 0.05);
  await waitFor(async () => (await project("PLB")).status === "paused", "budget stop");
  const p = await project("PLB");
  assert.match(p.error, /Budget of \$0\.05 reached/);
  assert.equal((await api("GET", "/meta")).globalPause, null, "other projects keep running");
  assert.equal(runningRuns(), 0, "no agent keeps working past the budget");
  // Raising the budget (0 = no limit) and starting again lets the project finish.
  await api("PATCH", `/projects/${p.id}`, { settings: { budgetUsd: 0 } });
  await api("POST", `/projects/${p.id}/start`, {});
  await waitFor(async () => (await project("PLB")).status === "completed", "completion after raising the budget");
});

test("Claude API errors map to pause reasons", () => {
  const headers = { get: (k: string) => (k === "retry-after" ? "120" : null) };
  const rate = limitFromApiError({ status: 429, message: "rate_limit_error", headers })!;
  assert.equal(rate.kind, "rate_limit");
  assert.ok(new Date(rate.resumeAt!).getTime() - Date.now() > 100_000);
  assert.equal(limitFromApiError({ status: 529, message: "Overloaded" })!.kind, "overloaded");
  assert.equal(limitFromApiError({ status: 401, message: "invalid x-api-key" })!.kind, "auth");
  assert.equal(limitFromApiError({ status: 400, message: "Your credit balance is too low to access the Anthropic API." })!.kind, "credits");
  assert.equal(limitFromApiError({ message: "fetch failed", name: "APIConnectionError" })!.kind, "network");
  assert.equal(limitFromApiError({ status: 400, message: "messages: field required" }), null, "real request errors are not pauses");
});
