// Importing a backlog that already exists in Azure DevOps, through the buffer and the project's saved mapping.
// A local stand-in plays Azure DevOps (fixtures/fake-ado.ts); nothing real is contacted.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { all } from "../src/db.ts";
import { changeText, htmlToText, mapAdoItem, wiqlFor, type RawItem } from "../src/adoimport.ts";
import { fieldsToRead, defaultMapping } from "../src/adomapping.ts";
import { startFakeAdo, type FakeAdo, type FakeItem } from "./fixtures/fake-ado.ts";

const TOKEN = "fake-pat-for-import-tests-0123";
process.env.AZURE_DEVOPS_PAT = TOKEN;

/** Team Capybaras' board: Backlog → Design → Develop → Test → Done. */
const STATES = [
  { name: "Backlog", category: "Proposed" },
  { name: "Design", category: "InProgress" },
  { name: "Develop", category: "InProgress" },
  { name: "Test", category: "InProgress" },
  { name: "Done", category: "Completed" },
  { name: "Removed", category: "Removed" },
];
let ado: FakeAdo;
const link = (rel: string, id: number) => ({ rel, url: `http://ado.local/fakeorg/_apis/wit/workItems/${id}` });
function add(id: number, type: string, title: string, f: Record<string, unknown> = {}, relations: FakeItem["relations"] = []) {
  ado.items.set(id, { id, fields: { "System.WorkItemType": type, "System.Title": title, "System.State": "Backlog", "System.IterationPath": "Sirocco SAFe\\2026-23", "System.CreatedBy": "someone", "System.History": "x".repeat(5000), ...f }, relations });
}
/** A buffered work item, as the import keeps it. */
const raw = (id: number): RawItem => {
  const it = ado.items.get(id)!;
  const parent = it.relations.find((r) => r.rel === "System.LinkTypes.Hierarchy-Reverse");
  return { id, rev: 1, fields: { ...it.fields, ...(parent ? { "System.Parent": Number(parent.url.split("/").pop()) } : {}) }, dependsOnLinks: it.relations.filter((r) => r.rel === "System.LinkTypes.Dependency-Reverse").map((r) => Number(r.url.split("/").pop())) };
};

let app: Server;
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
  ado = await startFakeAdo({ token: TOKEN, project: "Zephyr", states: STATES });
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
  app = createApp().listen(0);
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "simulation", simulationSpeed: 0.02, dailyLimitUsd: 0, monthlyLimitUsd: 0 });
});

after(() => {
  app.close();
  ado.close();
});

test("Azure DevOps fields map onto AgentStudio's through the mapping, and the query uses the filter", () => {
  assert.equal(htmlToText("<p>One &amp; two</p><ul><li>A</li><li>B</li></ul>"), "One & two\n\n- A\n- B");
  const m = mapAdoItem(raw(12146))!;
  assert.deepEqual([m.type, m.assignee, m.iteration, m.tags, m.points, m.parentAdoId, m.dependsOnAdoIds], ["story", "Philip Oxelius", "2026-23", ["Zephyr", "Backend"], 5, 101, [12140]]);
  assert.deepEqual(mapAdoItem(raw(12151))!.dependsOnAdoIds, [12146], "from the dependency link");
  assert.equal(mapAdoItem(raw(12160)), null, "types AgentStudio doesn't track are left out");
  const q = wiqlFor({ project: "Zephyr" }, { areaPath: "Sirocco SAFe\\Team Capybaras", tags: ["Zephyr", "O'Brien"] });
  assert.match(q, /\[System\.TeamProject\] = 'Zephyr'/);
  assert.match(q, /\[System\.AreaPath\] UNDER 'Sirocco SAFe\\Team Capybaras'/);
  assert.match(q, /\[System\.Tags\] CONTAINS 'O''Brien'/, "quotes are escaped");
  assert.equal(changeText("title", "Old", "New"), 'title: "Old" → "New"');
  assert.equal(changeText("acceptance criteria", "- A\n- B", "- A\n- B\n- C"), "acceptance criteria:\n+ - C");
});

test("importing a backlog under way: the mapping comes from the board, only mapped fields are read, done stays done", async () => {
  const agents = await api<any[]>("GET", "/agents");
  const p = await api("POST", "/projects", { name: "Zephyr", key: "ZEP", description: "", agentIds: agents.map((a) => a.id), settings: { gates: true, parallelism: 1, budgetUsd: 0, maxRework: 1, repo: { url: "https://github.com/demo/zephyr.git", branch: "main" } } });
  const config = { orgUrl: ado.url, project: "Zephyr", stateMode: "same" };
  const preview = await api("POST", `/projects/${p.id}/ado/import/preview`, { config, filter: { tags: ["Zephyr"] } });
  assert.equal(preview.total, 6);
  assert.equal(preview.mappingSaved, false);
  assert.deepEqual(preview.mapping.states, { Backlog: "new", Design: "started", Develop: "started", Test: "started", Done: "done", Removed: "dropped" }, "from the board's own state categories");
  assert.deepEqual(preview.mapping.writeBack, { "In Progress": "Develop", "In Peer Testing": "Test", "Ready for UAT": "Test", "In Review": "Test", "Changes Requested": "Test", "Release Ready": "Done", "Smoke Testing": "Done", "Deployed (Done)": "Done" });
  assert.equal(preview.mapping.types["Test Case"], undefined, "types AgentStudio doesn't track aren't in it");
  assert.equal(all("SELECT 1 FROM work_items WHERE project_id = ?", p.id).length, 0, "a preview saves nothing");

  const r = await api("POST", `/projects/${p.id}/ado/import`, { config, filter: { areaPath: "Sirocco SAFe/Team Capybaras", tags: ["Zephyr"] }, rule: { assignees: ["Philip Oxelius"] }, mapping: preview.mapping });
  assert.deepEqual([r.created, r.updated, r.done, r.questions, r.total], [6, 0, 1, 1, 6]);
  assert.ok(ado.queries.some((q) => /\[System\.AreaPath\] UNDER 'Sirocco SAFe\\Team Capybaras'/.test(q)), "slashes become Azure DevOps paths");
  // Only what the mapping reads is downloaded: not the history, not who created it.
  const fields = ado.batches.at(-1)!.fields;
  assert.deepEqual(fields.sort(), fieldsToRead(defaultMapping()).sort());
  assert.ok(!fields.includes("System.History") && !fields.includes("System.CreatedBy"));
  const buffered = all<{ fields: string }>("SELECT fields FROM ado_raw WHERE project_id = ? AND ado_id = 12146", p.id)[0];
  assert.ok(buffered && !buffered.fields.includes("System.History"), "the buffer keeps only the mapped fields");

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
  assert.equal(by("US-12146").merge_mode, "review", "imported stories are merged after review");
  assert.match(by("US-12146").acceptance_criteria, /- Forms read the metadata\n- Validation uses it/);
  const qs = all<{ question: string; item_id: string }>("SELECT question, item_id FROM questions WHERE project_id = ?", p.id);
  assert.deepEqual(qs.map((q) => q.item_id), [by("US-12151").id], "only AgentStudio's story without acceptance criteria");
  const proj = await api("GET", `/projects/${p.id}`);
  assert.equal(proj.stages.find((s: any) => s.key === "requirements").status, "skipped");
  assert.deepEqual(proj.settings.adoMapping.states, preview.mapping.states, "the mapping is saved on the project");
});

test("a refresh takes only what changed in Azure DevOps: AgentStudio's own refinements stay", async () => {
  const p = await api("GET", "/projects/ZEP");
  const id = (await api<any[]>("GET", `/projects/${p.id}/items`)).find((i) => i.code === "US-12146").id;
  // AgentStudio refined the acceptance criteria; meanwhile only the title changed in Azure DevOps.
  await api("PATCH", `/items/${id}`, { acceptance_criteria: "1. Forms read the metadata\n2. Validation uses it\n3. Refined by the architect" });
  ado.items.get(12146)!.fields["System.Title"] = "Field metadata layer v2";
  ado.items.get(12150)!.fields["System.State"] = "Done";
  const again = await api("POST", `/projects/${p.id}/ado/import`, {});
  assert.deepEqual([again.created, again.updated], [0, 2]);
  const it = await api("GET", `/items/${id}`);
  assert.equal(it.title, "Field metadata layer v2");
  assert.match(it.acceptance_criteria, /Refined by the architect/, "not overwritten: it didn't change in Azure DevOps");
  const items = await api<any[]>("GET", `/projects/${p.id}/items`);
  assert.equal(items.length, 6, "no copies");
  assert.equal(items.find((i) => i.code === "US-12150").state, "Deployed (Done)");
});

test("the mapping can be corrected and is used from then on: a state that means done", async () => {
  const p = await api("GET", "/projects/ZEP");
  const m = p.settings.adoMapping;
  assert.equal((await call("PUT", `/projects/${p.id}/ado/mapping`, { mapping: { ...m, states: { ...m.states, Test: "finished" } } })).status, 400, "unknown meanings are refused");
  assert.equal((await call("PUT", `/projects/${p.id}/ado/mapping`, { mapping: { ...m, fields: { ...m.fields, title: "not a field!" } } })).status, 400);
  await api("PUT", `/projects/${p.id}/ado/mapping`, { mapping: { ...m, states: { ...m.states, Test: "done" } } });
  ado.items.get(12151)!.fields["System.State"] = "Test";
  ado.items.get(12151)!.fields["System.AssignedTo"] = { displayName: "Anna Berg" };
  await api("POST", `/projects/${p.id}/ado/import`, {});
  assert.equal((await api<any[]>("GET", `/projects/${p.id}/items`)).find((i) => i.code === "US-12151").state, "Deployed (Done)", "Test now means done on this board");
  const recomputed = await api("POST", `/projects/${p.id}/ado/mapping/refresh`, {});
  assert.equal(recomputed.states.Test, "started", "worked out from the board again");
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
