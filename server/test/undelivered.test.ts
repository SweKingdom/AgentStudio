// A project isn't done while items are left: blocked items hold their dependants, items with open questions wait, and
// the run stops at an "Undelivered items" gate where you continue with them or finish anyway.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { all, insert, now, run } from "../src/db.ts";

let server: Server;
let base = "";

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function waitFor(pred: () => Promise<boolean>, what: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const DESCRIPTION =
  "Service agents must create a case from an email automatically. Dispatchers must assign cases to a team by region. Managers need a weekly report of open cases per team. Legacy customers must be migrated from the old CRM. Agents should see the customer's order status from the ERP API.";

const project = (key: string) => api("GET", `/projects/${key}`);
const stories = (pid: string) => all<{ id: string; code: string; state: string }>("SELECT id, code, state FROM work_items WHERE project_id = ? AND type IN ('story', 'task') ORDER BY rank, code", pid);
const answerAll = (pid: string) => run("UPDATE questions SET answer = 'Use your judgement', answered_at = ? WHERE project_id = ? AND (answer IS NULL OR answer = '')", now(), pid);
const builtCount = (itemId: string) => all<{ n: number }>("SELECT COUNT(*) n FROM item_phases WHERE item_id = ? AND phase = 'development'", itemId)[0].n;

/** Approve every gate except the undelivered-items one, until the project completes or reaches that gate. */
async function runToEnd(key: string) {
  for (;;) {
    await waitFor(async () => {
      const p = await project(key);
      return !p.running && (p.status === "awaiting_approval" || p.status === "completed");
    }, `${key} to stop`);
    const p = await project(key);
    if (p.status === "completed" || p.stage === "open_items") return p;
    await api("POST", `/projects/${key}/approve`);
  }
}

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "simulation", simulationSpeed: 0.02, dailyLimitUsd: 0, monthlyLimitUsd: 0 });
});

after(() => server.close());

test("blocked and unanswered items stop the project at a gate; continuing delivers them", async () => {
  const agents = await api<any[]>("GET", "/agents");
  await api("POST", "/projects", {
    name: "Undelivered",
    key: "UND",
    description: DESCRIPTION,
    agentIds: agents.map((a) => a.id),
    settings: { gates: true, parallelism: 2, budgetUsd: 0, maxRework: 2, repo: { url: "https://github.com/demo/und.git", branch: "main" } },
    start: true,
  });
  await waitFor(async () => (await project("UND")).stage === "review_backlog", "the backlog review gate");
  const pid = (await project("UND")).id;
  answerAll(pid);
  const [blocked, dependant, asking] = stories(pid);
  await api("POST", "/projects/UND/approve");
  await waitFor(async () => (await project("UND")).stage === "approve_plan", "the plan gate");
  answerAll(pid);
  // `blocked` can't be built, `dependant` builds on it, `asking` still has a question for the product owner.
  run("UPDATE work_items SET depends_on = ? WHERE id = ?", JSON.stringify([blocked.code]), dependant.id);
  run("UPDATE work_items SET depends_on = '[]' WHERE id IN (?, ?)", blocked.id, asking.id);
  run("UPDATE work_items SET state = 'Blocked' WHERE id = ?", blocked.id);
  insert("questions", { project_id: pid, item_id: asking.id, question: "Which region is the default?", asked_by: "test", created_at: now() });

  let p = await runToEnd("UND");
  assert.equal(p.status, "awaiting_approval", "not completed while items are left");
  assert.equal(p.stage, "open_items");
  const reasons = Object.fromEntries(p.undelivered.map((i: any) => [i.code, i.reason]));
  assert.equal(reasons[blocked.code], "Blocked");
  assert.equal(reasons[dependant.code], `Waits for ${blocked.code}`);
  assert.match(reasons[asking.code], /open question/);
  assert.equal(builtCount(dependant.id), 0, "a story isn't built before the code it builds on is delivered");
  assert.equal(builtCount(asking.id), 0);
  assert.ok(all("SELECT 1 FROM activity WHERE item_id = ? AND summary LIKE ?", dependant.id, `%waits for ${blocked.code}%`).length);

  answerAll(pid);
  await api("POST", "/projects/UND/approve"); // continue
  for (let i = 0; i < 3 && (p = await runToEnd("UND")).status !== "completed"; i++) {
    answerAll(pid);
    await api("POST", "/projects/UND/approve");
  }
  assert.equal(p.status, "completed", `left: ${JSON.stringify(p.undelivered)}`);
  assert.deepEqual(p.undelivered, []);
  for (const s of [blocked, dependant, asking]) assert.ok(builtCount(s.id) > 0, `${s.code} was built`);
  assert.ok(!p.stages.some((s: any) => s.key === "open_items"));
});

test("finish anyway closes the project; reopen brings the gate back", async () => {
  const agents = await api<any[]>("GET", "/agents");
  await api("POST", "/projects", {
    name: "Finish anyway",
    key: "UNF",
    description: DESCRIPTION,
    agentIds: agents.map((a) => a.id),
    settings: { gates: true, parallelism: 2, budgetUsd: 0, maxRework: 2, repo: { url: "https://github.com/demo/unf.git", branch: "main" } },
    start: true,
  });
  await waitFor(async () => (await project("UNF")).stage === "review_backlog", "the backlog review gate");
  const pid = (await project("UNF")).id;
  answerAll(pid);
  const [left] = stories(pid);
  insert("questions", { project_id: pid, item_id: left.id, question: "Is this needed?", asked_by: "test", created_at: now() });

  let p = await runToEnd("UNF");
  assert.equal(p.stage, "open_items");
  await assert.rejects(api("POST", "/projects/UNF/reopen"), /409/);
  await api("POST", "/projects/UNF/finish");
  p = await project("UNF");
  assert.equal(p.status, "completed");
  assert.ok(p.undelivered.some((i: any) => i.code === left.code));
  assert.ok(all("SELECT 1 FROM activity WHERE project_id = ? AND summary LIKE '%of % items delivered%'", pid).length);

  await api("POST", "/projects/UNF/reopen");
  p = await project("UNF");
  assert.equal(p.status, "awaiting_approval");
  assert.equal(p.stage, "open_items");
  await assert.rejects(api("POST", "/projects/UNF/start"), /409/, "the gate is answered with continue or finish");
});
