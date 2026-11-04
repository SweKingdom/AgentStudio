// Story owners: AgentStudio builds only its own items. Someone else's are never built, don't keep the project open, and
// AgentStudio's stories that depend on them wait until that person's work is delivered.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { all, now, run } from "../src/db.ts";

let server: Server;
let base = "";

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "content-type": "application/json" } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await call(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}
async function waitFor(pred: () => Promise<boolean>, what: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const project = (key: string) => api("GET", `/projects/${key}`);
/** The first test's stories, by id: planning reorders the backlog, so position doesn't identify them. */
let ids = { anna: "", mine: "" };
const stories = (pid: string) => all<{ id: string; code: string; state: string }>("SELECT id, code, state FROM work_items WHERE project_id = ? AND type IN ('story', 'task') ORDER BY rank, code", pid);
const builtCount = (itemId: string) => all<{ n: number }>("SELECT COUNT(*) n FROM item_phases WHERE item_id = ? AND phase = 'development'", itemId)[0].n;
const answerAll = (pid: string) => run("UPDATE questions SET answer = 'Use your judgement', answered_at = ? WHERE project_id = ? AND (answer IS NULL OR answer = '')", now(), pid);

async function runToEnd(key: string) {
  for (;;) {
    await waitFor(async () => {
      const p = await project(key);
      return !p.running && (p.status === "awaiting_approval" || p.status === "completed");
    }, `${key} to stop`);
    const p = await project(key);
    if (p.status === "completed" || p.stage === "open_items") return p;
    answerAll(p.id);
    await api("POST", `/projects/${key}/approve`);
  }
}

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "simulation", simulationSpeed: 0.02, dailyLimitUsd: 0, monthlyLimitUsd: 0 });
});

after(() => server.close());

test("someone else's story isn't built; AgentStudio's story on top of it waits until it is delivered", async () => {
  const agents = await api<any[]>("GET", "/agents");
  await api("POST", "/projects", {
    name: "Owners",
    key: "OWN",
    description: "Members book classes. Members cancel a booking. Trainers see who booked their class.",
    agentIds: agents.map((a) => a.id),
    settings: { gates: true, parallelism: 2, budgetUsd: 0, maxRework: 2, repo: { url: "https://github.com/demo/own.git", branch: "main" } },
    start: true,
  });
  await waitFor(async () => (await project("OWN")).stage === "review_backlog", "the backlog review gate");
  const pid = (await project("OWN")).id;
  answerAll(pid);
  await api("POST", "/projects/OWN/approve");
  await waitFor(async () => (await project("OWN")).stage === "approve_plan", "the plan gate");
  answerAll(pid);
  const [anna, onTop, ...rest] = stories(pid);
  ids = { anna: anna.id, mine: onTop.id };
  assert.ok(rest.length >= 1, "a third story, AgentStudio's and independent");
  // After planning, which would set the dependencies again.
  run("UPDATE work_items SET depends_on = ? WHERE id = ?", JSON.stringify([anna.code]), onTop.id);
  run("UPDATE work_items SET depends_on = '[]' WHERE id <> ? AND project_id = ?", onTop.id, pid);
  const given = await api("POST", "/projects/OWN/items/owner", { ids: [anna.id], owner: "person", assignee: "Anna" });
  assert.equal(given.changed, 1);

  const gate = await runToEnd("OWN");
  assert.equal(gate.stage, "open_items", "AgentStudio's dependent story is left");
  assert.equal(builtCount(anna.id), 0, "Anna's story is never built");
  assert.equal(builtCount(onTop.id), 0, "the story on top of it waits");
  for (const s of rest) assert.ok(builtCount(s.id) > 0, `${s.code} is AgentStudio's and independent, so it's built`);
  assert.deepEqual(gate.undelivered.map((u: any) => [u.code, u.reason]), [[onTop.code, `Waits for ${anna.code} (Anna)`]], "Anna's own story doesn't keep the project open");

  // Anna finishes her story: any state is allowed on someone else's item.
  const done = await call("PATCH", `/items/${anna.id}`, { state: "Deployed (Done)" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  await api("POST", "/projects/OWN/approve"); // continue at the undelivered-items gate
  const end = await runToEnd("OWN");
  assert.ok(builtCount(onTop.id) > 0, "built once Anna's story is delivered");
  assert.equal(end.status, "completed");
});

test("owners are validated, and AgentStudio's own items still follow the pipeline", async () => {
  const anna = { id: ids.anna };
  const mine = { id: ids.mine };
  assert.equal((await call("PATCH", `/items/${anna.id}`, { owner: "robot" })).status, 400);
  assert.equal((await call("PATCH", `/items/${anna.id}`, { assignee: "x".repeat(121) })).status, 400);
  const back = await api("PATCH", `/items/${anna.id}`, { owner: "agentstudio" });
  assert.equal(back.owner, "agentstudio");
  assert.equal(back.assignee, "Anna", "the assignee is kept until it's changed");
  assert.equal((await call("PATCH", `/items/${mine.id}`, { state: "New" })).status, 409, "skipping steps on AgentStudio's own item is refused");
  const cleared = await api("PATCH", `/items/${anna.id}`, { owner: null, assignee: "" });
  assert.equal(cleared.owner, null);
  assert.equal(cleared.assignee, null);
});

test("assigning doesn't decide who builds; a rule on the assignee makes AgentStudio build exactly those", async () => {
  const agents = await api<any[]>("GET", "/agents");
  await api("POST", "/projects", {
    name: "Assigned",
    key: "ASG",
    description: "Members book classes. Members cancel a booking. Trainers see who booked their class.",
    agentIds: agents.map((a) => a.id),
    settings: { gates: true, parallelism: 2, budgetUsd: 0, maxRework: 2, repo: { url: "https://github.com/demo/asg.git", branch: "main" } },
    start: true,
  });
  await waitFor(async () => (await project("ASG")).stage === "review_backlog", "the backlog review gate");
  const pid = (await project("ASG")).id;
  answerAll(pid);
  await api("POST", "/projects/ASG/approve");
  await waitFor(async () => (await project("ASG")).stage === "approve_plan", "the plan gate");
  answerAll(pid);
  run("UPDATE work_items SET depends_on = '[]' WHERE project_id = ?", pid);
  const [a1, a2, other] = stories(pid);
  assert.equal((await call("POST", "/projects/ASG/items/owner", { ids: [a1.id] })).status, 400, "owner or assignee is needed");
  const assigned = await api("POST", "/projects/ASG/items/owner", { ids: [a1.id, a2.id], assignee: "Anna" });
  assert.equal(assigned.changed, 2);
  const items = await api<any[]>("GET", "/projects/ASG/items");
  for (const id of [a1.id, a2.id]) {
    const it = items.find((i) => i.id === id);
    assert.equal(it.assignee, "Anna");
    assert.equal(it.owner, null, "assigning didn't take it from AgentStudio");
    assert.equal(it.ours, true);
  }

  // A rule nobody matches leaves AgentStudio nothing: delivery stops and says why instead of finishing empty.
  await api("PATCH", "/projects/ASG", { settings: { workRule: { assignees: ["Nobody"] } } });
  await api("POST", "/projects/ASG/approve");
  await waitFor(async () => { const p = await project("ASG"); return !p.running && p.status === "paused"; }, "the pause");
  assert.ok(all<{ summary: string }>("SELECT summary FROM activity WHERE project_id = ? AND summary LIKE '%rule leaves it nothing to build%'", pid).length);
  assert.ok([a1, a2, other].every((s) => builtCount(s.id) === 0), "nothing was built");

  // "Assigned to Anna": AgentStudio builds Anna's two stories, and the third is left out (not built, not blocking).
  await api("PATCH", "/projects/ASG", { settings: { workRule: { assignees: ["Anna"] } } });
  await api("POST", "/projects/ASG/start");
  const end = await runToEnd("ASG");
  assert.ok(builtCount(a1.id) > 0 && builtCount(a2.id) > 0, "Anna's stories are built");
  assert.equal(builtCount(other.id), 0, "the story outside the rule isn't");
  assert.equal(end.status, "completed");
});
