// An imported project stays in step with Azure DevOps: it refreshes before every run, and writes back only the State of
// AgentStudio's own User Stories (forward only, nothing created). A local stand-in plays Azure DevOps and records writes.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { all, run } from "../src/db.ts";
import { boardState } from "../src/ado.ts";

const TOKEN = "fake-pat-for-refresh-tests-0123";
process.env.AZURE_DEVOPS_PAT = TOKEN;

interface Raw { id: number; fields: Record<string, unknown>; relations: { rel: string; url: string }[] }
const items = new Map<number, Raw>();
const writes: { method: string; path: string; body: any }[] = [];
/** A board like Team Capybaras': Backlog → Design → Develop → Test → Done. */
const STATES = [
  { name: "Backlog", category: "Proposed" },
  { name: "Design", category: "InProgress" },
  { name: "Develop", category: "InProgress" },
  { name: "Test", category: "InProgress" },
  { name: "Done", category: "Completed" },
  { name: "Removed", category: "Removed" },
];
function add(id: number, type: string, title: string, f: Record<string, unknown> = {}) {
  items.set(id, { id, fields: { "System.WorkItemType": type, "System.Title": title, "System.State": "Backlog", "Microsoft.VSTS.Common.AcceptanceCriteria": "It works", "System.AssignedTo": { displayName: "Philip Oxelius" }, ...f }, relations: [] });
}
add(201, "User Story", "Build it");
add(202, "User Story", "Ship it", { "System.State": "Develop" });
add(203, "User Story", "Anna's story", { "System.AssignedTo": { displayName: "Anna Berg" } });
add(204, "User Story", "Finished in Azure DevOps already", { "System.State": "Test" });
add(205, "Task", "A task");

let ado: http.Server;
let adoUrl = "";
let app: http.Server;
let appUrl = "";

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(`${appUrl}/api${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "content-type": "application/json" } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await call(method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

before(async () => {
  ado = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const path = decodeURIComponent(url.pathname);
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Basic ${Buffer.from(`:${TOKEN}`).toString("base64")}`) return send(401, { message: "Unauthorized" });
      let m: RegExpMatchArray | null;
      if (req.method === "POST" && path === "/fakeorg/Zephyr/_apis/wit/wiql") return send(200, { workItems: [...items.keys()].map((id) => ({ id })) });
      if (req.method === "GET" && path === "/fakeorg/Zephyr/_apis/wit/workitems") return send(200, { value: url.searchParams.get("ids")!.split(",").map((id) => items.get(Number(id))) });
      if (req.method === "GET" && path === "/fakeorg/Zephyr/_apis/wit/workitemtypes/User Story/states") return send(200, { value: STATES });
      if ((m = path.match(/^\/fakeorg\/_apis\/wit\/workitems\/(\d+)$/))) {
        const it = items.get(Number(m[1]));
        if (!it) return send(404, { message: "no such item" });
        if (req.method === "GET") return send(200, { id: it.id, fields: it.fields });
        if (req.method === "PATCH") {
          const body = JSON.parse(raw);
          writes.push({ method: "PATCH", path, body });
          for (const op of body) it.fields[op.path.replace("/fields/", "")] = op.value;
          return send(200, { id: it.id, fields: it.fields });
        }
      }
      writes.push({ method: req.method!, path, body: raw ? JSON.parse(raw) : null });
      send(405, { message: `Not allowed in the stand-in: ${req.method} ${path}` });
    });
  });
  await new Promise<void>((r) => ado.listen(0, "127.0.0.1", () => r()));
  adoUrl = `http://127.0.0.1:${(ado.address() as AddressInfo).port}/fakeorg`;
  app = createApp().listen(0);
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "simulation", simulationSpeed: 0.02, dailyLimitUsd: 0, monthlyLimitUsd: 0 });
});

after(() => {
  app.close();
  ado.close();
});

test("AgentStudio's progress maps onto the board's own states", () => {
  assert.equal(boardState("In Progress", STATES), "Develop");
  assert.equal(boardState("In Peer Testing", STATES), "Test");
  assert.equal(boardState("In Review", STATES), "Test");
  assert.equal(boardState("Release Ready", STATES), "Done");
  assert.equal(boardState("New", STATES), null, "not started: left as it is");
  assert.equal(boardState("Blocked", STATES), null);
  const agile = [{ name: "New", category: "Proposed" }, { name: "Active", category: "InProgress" }, { name: "Resolved", category: "Resolved" }, { name: "Closed", category: "Completed" }];
  assert.deepEqual(["In Progress", "In Peer Testing", "Deployed (Done)"].map((s) => boardState(s, agile)), ["Active", "Resolved", "Closed"]);
});

let pid = "";
const code = (adoId: number) => all<{ id: string; state: string }>("SELECT id, state FROM work_items WHERE project_id = ? AND ado_id = ?", pid, adoId)[0];

test("state-only write-back: only AgentStudio's own stories, only System.State, forward only, nothing created", async () => {
  const agents = await api<any[]>("GET", "/agents");
  const p = await api("POST", "/projects", { name: "Zephyr refresh", key: "ZRF", description: "", agentIds: agents.map((a) => a.id), settings: { gates: true, parallelism: 1, budgetUsd: 0, maxRework: 1, repo: { url: "https://github.com/demo/zrf.git", branch: "main" } } });
  pid = p.id;
  await api("POST", `/projects/${pid}/ado/import`, { config: { orgUrl: adoUrl, project: "Zephyr", stateMode: "same" }, filter: {}, rule: { assignees: ["Philip Oxelius"] } });
  assert.equal((await api("GET", `/projects/${pid}`)).settings.ado.writeMode, "state", "imported projects write only states");
  // AgentStudio's progress on its stories, and Anna's story moving in AgentStudio too.
  run("UPDATE work_items SET state = 'In Progress' WHERE project_id = ? AND ado_id IN (201, 203, 204)", pid);
  run("UPDATE work_items SET state = 'Release Ready' WHERE project_id = ? AND ado_id = 202", pid);
  run("UPDATE work_items SET state = 'In Progress' WHERE project_id = ? AND ado_id = 205", pid);
  const s = await api("POST", `/projects/${pid}/ado/sync`);
  assert.equal(s.updated, 2);
  assert.equal(items.get(201)!.fields["System.State"], "Develop");
  assert.equal(items.get(202)!.fields["System.State"], "Done");
  assert.equal(items.get(203)!.fields["System.State"], "Backlog", "Anna's story isn't touched");
  assert.equal(items.get(204)!.fields["System.State"], "Test", "never moved back (Test is past Develop)");
  assert.equal(items.get(205)!.fields["System.State"], "Backlog", "only User Stories");
  assert.ok(writes.every((w) => w.method === "PATCH" && w.body.length === 1 && w.body[0].path === "/fields/System.State"), "only the State field, never a new item");
  assert.equal((await api("POST", `/projects/${pid}/ado/sync`)).updated, 0, "nothing to move the second time");
});

test("a run starts by taking what changed in Azure DevOps; changes to a story under way reach the developer", async () => {
  items.get(201)!.fields["Microsoft.VSTS.Common.AcceptanceCriteria"] = "<ol><li>It works</li><li>It is fast</li></ol>";
  items.get(203)!.fields["System.State"] = "Done";
  add(206, "User Story", "Added in Azure DevOps meanwhile");
  await api("POST", `/projects/${pid}/start`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && (await api("GET", `/projects/${pid}`)).running) await new Promise((r) => setTimeout(r, 100));
  assert.ok(code(206), "a story added in Azure DevOps came in");
  assert.equal(code(203).state, "Deployed (Done)", "Anna finished hers");
  const comments = all<{ content: string; author_id: string }>("SELECT content, author_id FROM comments WHERE item_id = ?", code(201).id);
  assert.ok(comments.some((c) => c.author_id === "human" && /^Changed in Azure DevOps \(acceptance criteria\):/.test(c.content) && /It is fast/.test(c.content)), "the developer sees the change");
  assert.ok(all("SELECT 1 FROM activity WHERE project_id = ? AND summary LIKE '↻ Azure DevOps:%'", pid).length >= 1);
});

test("read only: nothing is written to Azure DevOps", async () => {
  const p = await api("GET", `/projects/${pid}`);
  await api("PATCH", `/projects/${pid}`, { settings: { ado: { ...p.settings.ado, writeMode: "none" } } });
  const before = writes.length;
  const r = await call("POST", `/projects/${pid}/ado/sync`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /read only/);
  assert.equal(writes.length, before);
});
