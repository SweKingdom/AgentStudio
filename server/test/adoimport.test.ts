// Importing a backlog that already exists in Azure DevOps. A local stand-in plays Azure DevOps; nothing real is contacted.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { all } from "../src/db.ts";
import { htmlToText, mapAdoItem, wiqlFor } from "../src/adoimport.ts";

const TOKEN = "fake-pat-for-import-tests-0123";
process.env.AZURE_DEVOPS_PAT = TOKEN;

interface Raw { id: number; fields: Record<string, unknown>; relations: { rel: string; url: string }[] }
const items = new Map<number, Raw>();
const queries: string[] = [];
const link = (rel: string, id: number) => ({ rel, url: `http://ado.local/fakeorg/_apis/wit/workItems/${id}` });
function add(id: number, type: string, title: string, f: Record<string, unknown> = {}, relations: Raw["relations"] = []) {
  items.set(id, { id, fields: { "System.WorkItemType": type, "System.Title": title, "System.State": "New", "System.IterationPath": "Sirocco SAFe\\2026-23", ...f }, relations });
}
add(100, "Epic", "CRM core");
add(101, "Feature", "Accounts", {}, [link("System.LinkTypes.Hierarchy-Reverse", 100)]);
add(12140, "User Story", "Account data model", { "System.State": "Done", "System.AssignedTo": { displayName: "Anna Berg" } }, [link("System.LinkTypes.Hierarchy-Reverse", 101)]);
add(12146, "User Story", "Field metadata layer", {
  "System.AssignedTo": { displayName: "Philip Oxelius" },
  "System.Tags": "Zephyr; Backend",
  "System.Description": "<p>As a developer I want field metadata.</p><p>Depends on: #12140</p>",
  "Microsoft.VSTS.Common.AcceptanceCriteria": "<ol><li>Forms read the metadata</li><li>Validation uses it</li></ol>",
  "Microsoft.VSTS.Scheduling.StoryPoints": 5,
}, [link("System.LinkTypes.Hierarchy-Reverse", 101)]);
add(12150, "User Story", "Account search", { "System.State": "Develop", "System.AssignedTo": { displayName: "Anna Berg" }, "Microsoft.VSTS.Common.AcceptanceCriteria": "Search by name" }, [link("System.LinkTypes.Hierarchy-Reverse", 101)]);
add(12151, "User Story", "Account export", { "System.AssignedTo": { displayName: "Philip Oxelius" } }, [link("System.LinkTypes.Hierarchy-Reverse", 101), link("System.LinkTypes.Dependency-Reverse", 12146)]);
add(12160, "Test Case", "Not tracked by AgentStudio");

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
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Basic ${Buffer.from(`:${TOKEN}`).toString("base64")}`) return send(401, { message: "Unauthorized" });
      if (req.method !== "GET" && req.method !== "POST") return send(405, { message: "The import must only read" });
      if (req.method === "POST" && url.pathname === "/fakeorg/Zephyr/_apis/wit/wiql") {
        queries.push(JSON.parse(raw).query);
        return send(200, { workItems: [...items.keys()].map((id) => ({ id })) });
      }
      if (req.method === "GET" && url.pathname === "/fakeorg/Zephyr/_apis/wit/workitems") {
        assert.equal(url.searchParams.get("$expand"), "relations");
        const ids = url.searchParams.get("ids")!.split(",").map(Number);
        return send(200, { value: ids.map((id) => items.get(id)).filter(Boolean) });
      }
      send(404, { message: `Not in the stand-in: ${req.method} ${url.pathname}` });
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

test("Azure DevOps fields map onto AgentStudio's, and the query uses the filter", () => {
  assert.equal(htmlToText("<p>One &amp; two</p><ul><li>A</li><li>B</li></ul>"), "One & two\n\n- A\n- B");
  const m = mapAdoItem(items.get(12146)!)!;
  assert.deepEqual([m.type, m.assignee, m.iteration, m.tags, m.points, m.parentAdoId, m.dependsOnAdoIds], ["story", "Philip Oxelius", "2026-23", ["Zephyr", "Backend"], 5, 101, [12140]]);
  assert.equal(mapAdoItem(items.get(12160)!), null, "types AgentStudio doesn't track are left out");
  const q = wiqlFor({ project: "Zephyr" }, { areaPath: "Sirocco SAFe\\Team Capybaras", tags: ["Zephyr", "O'Brien"] });
  assert.match(q, /\[System\.TeamProject\] = 'Zephyr'/);
  assert.match(q, /\[System\.AreaPath\] UNDER 'Sirocco SAFe\\Team Capybaras'/);
  assert.match(q, /\[System\.Tags\] CONTAINS 'O''Brien'/, "quotes are escaped");
});

test("importing a backlog under way: done stays done, someone else's work stays theirs, AgentStudio asks about unclear stories", async () => {
  const agents = await api<any[]>("GET", "/agents");
  const p = await api("POST", "/projects", { name: "Zephyr", key: "ZEP", description: "", agentIds: agents.map((a) => a.id), settings: { gates: true, parallelism: 1, budgetUsd: 0, maxRework: 1, repo: { url: "https://github.com/demo/zephyr.git", branch: "main" } } });
  const config = { orgUrl: adoUrl, project: "Zephyr", stateMode: "same" };
  const preview = await api("POST", `/projects/${p.id}/ado/import/preview`, { config, filter: { tags: ["Zephyr"] } });
  assert.equal(preview.total, 6);
  assert.equal(all("SELECT 1 FROM work_items WHERE project_id = ?", p.id).length, 0, "a preview saves nothing");

  const r = await api("POST", `/projects/${p.id}/ado/import`, { config, filter: { areaPath: "Sirocco SAFe/Team Capybaras", tags: ["Zephyr"] }, rule: { assignees: ["Philip Oxelius"] } });
  assert.deepEqual([r.created, r.updated, r.done, r.questions, r.total], [6, 0, 1, 1, 6]);
  assert.match(queries.at(-1)!, /\[System\.AreaPath\] UNDER 'Sirocco SAFe\\Team Capybaras'/, "slashes become Azure DevOps paths");
  const list = await api<any[]>("GET", `/projects/${p.id}/items`);
  const by = (code: string) => list.find((i) => i.code === code)!;
  assert.deepEqual(list.map((i) => i.code).sort(), ["EP-100", "FT-101", "US-12140", "US-12146", "US-12150", "US-12151"]);
  assert.equal(by("FT-101").parent_id, by("EP-100").id);
  assert.equal(by("US-12146").parent_id, by("FT-101").id);
  assert.deepEqual(by("US-12146").depends_on, ["US-12140"], "from the description's Depends on line");
  assert.deepEqual(by("US-12151").depends_on, ["US-12146"], "from the dependency link");
  assert.equal(by("US-12140").state, "Deployed (Done)", "done in Azure DevOps: delivered, never rebuilt");
  assert.equal(by("US-12150").state, "In Progress", "Anna's work in progress");
  assert.equal(by("US-12150").ours, false, "outside the rule: Anna's");
  assert.equal(by("US-12146").ours, true);
  assert.equal(by("US-12146").ado_id, 12146);
  assert.equal(by("US-12146").merge_mode, "review", "imported stories are merged after review");
  assert.match(by("US-12146").acceptance_criteria, /- Forms read the metadata\n- Validation uses it/);
  const qs = all<{ question: string; item_id: string }>("SELECT question, item_id FROM questions WHERE project_id = ?", p.id);
  assert.deepEqual(qs.map((q) => q.item_id), [by("US-12151").id], "only AgentStudio's story without acceptance criteria");
  assert.match(qs[0].question, /US-12151 "Account export" came from Azure DevOps without acceptance criteria/);
  const proj = await api("GET", `/projects/${p.id}`);
  assert.equal(proj.stages.find((s: any) => s.key === "requirements").status, "skipped");

  // Importing again updates in place: no copies, and AgentStudio's codes stay.
  items.get(12146)!.fields["System.Title"] = "Field metadata layer v2";
  items.get(12150)!.fields["System.State"] = "Done";
  const again = await api("POST", `/projects/${p.id}/ado/import`, {});
  assert.deepEqual([again.created, again.updated], [0, 2]);
  const after = await api<any[]>("GET", `/projects/${p.id}/items`);
  assert.equal(after.length, 6);
  assert.equal(after.find((i) => i.code === "US-12146").title, "Field metadata layer v2");
  assert.equal(after.find((i) => i.code === "US-12150").state, "Deployed (Done)");
});

test("an imported project never runs the requirements stage, which would start from an empty backlog", async () => {
  const p = await api("GET", "/projects/ZEP");
  await api("POST", `/projects/${p.id}/start`);
  await new Promise((r) => setTimeout(r, 300));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const cur = await api("GET", `/projects/${p.id}`);
    if (!cur.running) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(all("SELECT 1 FROM work_items WHERE project_id = ?", p.id).length, 6, "the imported backlog is intact");
  assert.equal(all("SELECT 1 FROM runs WHERE project_id = ? AND stage = 'requirements'", p.id).length, 0, "the analyst didn't run");
});

test("import errors are clear: no config, unreachable Azure DevOps", async () => {
  const agents = await api<any[]>("GET", "/agents");
  const p = await api("POST", "/projects", { name: "No ADO", key: "NOADO", description: "", agentIds: [agents[0].id], settings: { gates: true, parallelism: 1, budgetUsd: 0, maxRework: 1, repo: { url: "https://github.com/demo/noado.git", branch: "main" } } });
  assert.match((await call("POST", `/projects/${p.id}/ado/import`, {})).body.error, /organization URL/);
  const dead = await call("POST", `/projects/${p.id}/ado/import`, { config: { orgUrl: "http://127.0.0.1:9/x", project: "Zephyr" } });
  assert.equal(dead.status, 400);
  assert.match(dead.body.error, /Could not reach Azure DevOps/);
});
