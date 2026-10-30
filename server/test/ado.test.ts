import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { Router } from "express";
import { all, insert, now } from "../src/db.ts";
import { createItem, getItem, getProject, patchItem, patchProject, type WorkItem } from "../src/store.ts";
import { agileState, cleanAdoConfig } from "../src/ado.ts";
import { registerAdo } from "../src/routes/ado.ts";
import { runChecks } from "../src/doctor.ts";

// ---------------------------------------------------------------- a local stand-in for Azure DevOps (nothing real is contacted)

const TOKEN = "fake-pat-for-tests-0123456789";
interface FakeItem { id: number; type: string; fields: Record<string, unknown>; relations: { rel: string; url: string }[] }
const fake = {
  items: new Map<number, FakeItem>(),
  nextId: 1000,
  requests: [] as { method: string; path: string; body: any }[],
  /** State names the fake process refuses (like an Agile process refusing ARM's own names). */
  refuseStates: new Set<string>(),
};

let adoServer: http.Server;
let adoBase = "";
let appServer: http.Server;
let appBase = "";
const responses: string[] = [];

function startFakeAdo() {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const path = decodeURIComponent(url.pathname);
      const body = raw ? JSON.parse(raw) : null;
      fake.requests.push({ method: req.method!, path, body });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Basic ${Buffer.from(`:${TOKEN}`).toString("base64")}`) return send(401, { message: "Unauthorized" });
      if (url.searchParams.get("api-version") !== "7.1") return send(400, { message: "api-version missing" });
      let m: RegExpMatchArray | null;
      if (req.method === "GET" && (m = path.match(/^\/fakeorg\/_apis\/projects\/(.+)$/))) {
        return m[1] === "Demo" ? send(200, { name: "Demo", capabilities: { processTemplate: { templateName: "Agile" } } }) : send(404, { message: `TF200016: The project ${m[1]} does not exist` });
      }
      if (req.method === "POST" && (m = path.match(/^\/fakeorg\/Demo\/_apis\/wit\/workitems\/\$(.+)$/))) {
        assert.equal(req.headers["content-type"], "application/json-patch+json");
        const fields: Record<string, unknown> = {};
        const relations: FakeItem["relations"] = [];
        for (const op of body) {
          if (op.path.startsWith("/fields/")) fields[op.path.slice(8)] = op.value;
          else if (op.path === "/relations/-") relations.push(op.value);
        }
        // Like the Agile process: a Task has no Story Points field.
        if (m[1] === "Task" && "Microsoft.VSTS.Scheduling.StoryPoints" in fields) return send(400, { message: "TF51535: Cannot find field Microsoft.VSTS.Scheduling.StoryPoints." });
        if (fake.refuseStates.has(String(fields["System.State"]))) {
          return send(400, { message: `TF401320: The field 'State' contains the value '${fields["System.State"]}' that is not in the list of supported values` });
        }
        const it = { id: fake.nextId++, type: m[1], fields, relations };
        fake.items.set(it.id, it);
        return send(200, { id: it.id, rev: 1, fields, url: `${adoBase}/fakeorg/_apis/wit/workItems/${it.id}` });
      }
      if ((m = path.match(/^\/fakeorg\/_apis\/wit\/workitems\/(\d+)$/))) {
        const it = fake.items.get(Number(m[1]));
        if (!it) return send(404, { message: `TF401232: Work item ${m[1]} does not exist` });
        if (req.method === "GET") return send(200, { id: it.id, fields: it.fields, relations: it.relations });
        if (req.method === "PATCH") {
          const next = { ...it.fields };
          const rels = [...it.relations];
          for (const op of body) {
            if (op.path.startsWith("/fields/")) next[op.path.slice(8)] = op.value;
            else if (op.path === "/relations/-") rels.push(op.value);
            else if (op.op === "remove" && op.path.startsWith("/relations/")) rels.splice(Number(op.path.split("/")[2]), 1);
          }
          if (String(next["System.Title"]).includes("REJECT")) return send(400, { message: "TF999999: The title was refused by a custom rule" });
          if (fake.refuseStates.has(String(next["System.State"]))) return send(400, { message: `TF401320: The field 'State' contains the value '${next["System.State"]}' that is not in the list of supported values` });
          it.fields = next;
          it.relations = rels;
          return send(200, { id: it.id, rev: 2, fields: it.fields });
        }
      }
      send(404, { message: `No fake route for ${req.method} ${path}` });
    });
  });
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${appBase}/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  responses.push(text);
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ---------------------------------------------------------------- fixture project

const PID = "prj_adotest";
let epic: WorkItem, feature: WorkItem, story: WorkItem, task: WorkItem, bug: WorkItem;

before(async () => {
  delete process.env.AZURE_DEVOPS_PAT;
  adoServer = startFakeAdo().listen(0);
  await new Promise((r) => adoServer.once("listening", r));
  adoBase = `http://127.0.0.1:${(adoServer.address() as AddressInfo).port}`;
  const router = Router();
  registerAdo(router);
  appServer = express().use(express.json()).use("/api", router).listen(0);
  await new Promise((r) => appServer.once("listening", r));
  appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

  const ts = now();
  insert("projects", {
    id: PID, key: "ADO", name: "ADO sync", status: "ready", mode: "simulation", created_at: ts, updated_at: ts,
    settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1, ado: { orgUrl: `${adoBase}/fakeorg/`, project: "Demo", areaPath: "Demo\\Team A", iterationRoot: "Demo/Release 1", stateMode: "same" } },
  });
  epic = createItem(PID, { type: "epic", title: "Field service" });
  feature = createItem(PID, { type: "feature", title: "Work orders", parent_id: epic.id });
  story = createItem(PID, {
    type: "story", title: "Assign a technician", parent_id: feature.id, story_points: 5, sprint: 2, priority: 2, category: "development",
    user_story: "As a dispatcher I want to assign a technician so that the job gets done.",
    business_rules: "- Only active technicians\n- One technician per job",
    acceptance_criteria: "1. Given an open job, when I assign, then the technician is notified\n2. Given an inactive technician, assignment fails",
    tags: ["dispatch"],
  });
  task = createItem(PID, { type: "task", title: "Build the trigger", parent_id: story.id, story_points: 2, acceptance_criteria: "Trigger handles bulk" });
  bug = createItem(PID, { type: "bug", title: "Wrong <b>owner</b> & team", parent_id: story.id, state: "In Progress" });
});

after(() => {
  appServer.close();
  adoServer.close();
  delete process.env.AZURE_DEVOPS_PAT;
});

// ---------------------------------------------------------------- tests

test("config validation: https only (local stand-ins allowed), no credentials in the URL", () => {
  assert.equal(cleanAdoConfig(null), null);
  assert.equal(cleanAdoConfig({ orgUrl: "", project: "" }), null);
  assert.deepEqual(cleanAdoConfig({ orgUrl: "https://dev.azure.com/acme/", project: "Demo", iterationRoot: "Demo/R1/", stateMode: "weird" }), { orgUrl: "https://dev.azure.com/acme", project: "Demo", iterationRoot: "Demo\\R1", stateMode: "same" });
  assert.throws(() => cleanAdoConfig({ orgUrl: "http://dev.azure.com/acme", project: "Demo" }), /https/);
  assert.throws(() => cleanAdoConfig({ orgUrl: "https://user:secret@dev.azure.com/acme", project: "Demo" }), /never stores credentials/);
  assert.throws(() => cleanAdoConfig({ orgUrl: "https://dev.azure.com/acme", project: "" }), /project name is required/);
  assert.ok(cleanAdoConfig({ orgUrl: "http://localhost:9/org", project: "Demo" }));
  assert.equal(agileState("Ready for UAT", "story"), "Active");
  assert.equal(agileState("Release Ready", "task"), "Closed");
  assert.equal(agileState("Cancelled", "bug"), "Closed");
  assert.equal(agileState("Deployed (Done)", "epic"), "Closed");
});

test("without a token: a clear error and nothing is sent", async () => {
  const st = await call("GET", `/projects/${PID}/ado/status`);
  assert.equal(st.body.configured, true);
  assert.equal(st.body.tokenPresent, false);
  const t = await call("POST", `/projects/${PID}/ado/test`, {});
  assert.equal(t.body.ok, false);
  assert.match(t.body.error, /AZURE_DEVOPS_PAT=/);
  const s = await call("POST", `/projects/${PID}/ado/sync`, {});
  assert.equal(s.status, 400);
  assert.match(s.body.error, /AZURE_DEVOPS_PAT=/);
  assert.equal(fake.requests.length, 0);
  const doc = (await runChecks()).find((c) => c.id === "ado-token");
  assert.equal(doc?.status, "warn");
});

test("test connection: project and process, rejected token, unknown project", async () => {
  process.env.AZURE_DEVOPS_PAT = TOKEN;
  const okRes = await call("POST", `/projects/${PID}/ado/test`, {});
  assert.deepEqual(okRes.body, { ok: true, project: "Demo", process: "Agile" });
  const missing = await call("POST", `/projects/${PID}/ado/test`, { config: { orgUrl: `${adoBase}/fakeorg`, project: "Nope" } });
  assert.equal(missing.body.ok, false);
  assert.match(missing.body.error, /project not found/);
  const insecure = await call("POST", `/projects/${PID}/ado/test`, { config: { orgUrl: "http://example.com/org", project: "Demo" } });
  assert.match(insecure.body.error, /https/);
  process.env.AZURE_DEVOPS_PAT = "a-different-token";
  const rejected = await call("POST", `/projects/${PID}/ado/test`, {});
  assert.match(rejected.body.error, /rejected the token/);
  process.env.AZURE_DEVOPS_PAT = TOKEN;
  assert.equal((await runChecks()).find((c) => c.id === "ado-token")?.status, "ok");
});

test("first sync creates every item parents-first with the right JSON-patch", async () => {
  fake.requests.length = 0;
  const r = await call("POST", `/projects/${PID}/ado/sync`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 5);
  assert.equal(r.body.updated, 0);
  assert.equal(r.body.failed, 0, JSON.stringify(r.body.errors));
  // Parents first: Epic, Feature, User Story, then children.
  assert.deepEqual([...new Set(fake.requests.map((q) => q.path.split("$")[1]))], ["Epic", "Feature", "User Story", "Task", "Bug"]);

  const ids = [epic, feature, story, task, bug].map((i) => getItem(i.id)!.ado_id!);
  assert.ok(ids.every((id) => typeof id === "number" && id >= 1000), "ADO ids stored on the items");
  const ado = (i: WorkItem) => fake.items.get(getItem(i.id)!.ado_id!)!;

  const s = ado(story).fields;
  assert.equal(s["System.Title"], "Assign a technician");
  assert.equal(s["Microsoft.VSTS.Scheduling.StoryPoints"], 5);
  assert.equal(s["Microsoft.VSTS.Common.Priority"], 2);
  assert.match(String(s["Microsoft.VSTS.Common.AcceptanceCriteria"]), /^<ol><li>Given an open job/);
  assert.match(String(s["System.Description"]), /<h3>User Story<\/h3>\n<p>As a dispatcher/);
  assert.match(String(s["System.Description"]), /<h3>Business Rules<\/h3>\n<ul><li>Only active technicians<\/li>/);
  assert.equal(s["System.AreaPath"], "Demo\\Team A");
  assert.equal(s["System.IterationPath"], "Demo\\Release 1\\Sprint 2");
  assert.equal(s["System.State"], "New");
  assert.deepEqual(String(s["System.Tags"]).split("; "), ["dispatch", "AgentStudio", "development", `ARM ${story.code}`]);
  assert.deepEqual(ado(story).relations, [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${adoBase}/fakeorg/_apis/wit/workItems/${getItem(feature.id)!.ado_id}` }]);
  assert.deepEqual(ado(epic).relations, []);
  assert.equal(ado(epic).fields["System.IterationPath"], "Demo\\Release 1", "no sprint → the iteration root");
  // Tasks have no Acceptance Criteria field: the criteria go into the description; HTML is escaped.
  assert.equal(ado(task).fields["Microsoft.VSTS.Common.AcceptanceCriteria"], undefined);
  assert.match(String(ado(task).fields["System.Description"]), /<h3>Acceptance Criteria<\/h3>\n<p>Trigger handles bulk<\/p>/);
  assert.equal(ado(task).fields["Microsoft.VSTS.Scheduling.StoryPoints"], undefined, "a field the type lacks is dropped");
  assert.match(r.body.warnings.find((w: any) => w.code === task.code)?.message ?? "", /StoryPoints was refused for Task/);
  assert.equal(ado(bug).fields["System.Title"], "Wrong <b>owner</b> & team");
  assert.equal(ado(bug).fields["System.State"], "In Progress", "stateMode same sends ARM's state name");

  const st = await call("GET", `/projects/${PID}/ado/status`);
  assert.equal(st.body.lastSync.created, 5);
  const act = all<{ summary: string }>("SELECT summary FROM activity WHERE project_id = ? AND type = 'ado_sync'", PID);
  assert.match(act[0].summary, /5 created, 0 updated/);
});

test("second sync updates in place, re-parents, and re-creates items deleted in ADO", async () => {
  fake.requests.length = 0;
  const storyId = getItem(story.id)!.ado_id!;
  patchItem(story.id, { title: "Assign a field technician", story_points: 8 });
  // Move the task under the epic's feature to check the parent link is replaced, not duplicated.
  patchItem(task.id, { parent_id: feature.id });
  const deleted = getItem(bug.id)!.ado_id!;
  fake.items.delete(deleted);

  const r = await call("POST", `/projects/${PID}/ado/sync`, {});
  assert.equal(r.body.updated, 4);
  assert.equal(r.body.created, 1);
  assert.equal(r.body.recreated, 1);
  assert.equal(r.body.failed, 0);
  assert.ok(!fake.requests.some((q) => q.method === "POST" && !q.path.endsWith("$Bug")), "only the deleted bug is created again");
  assert.ok(fake.requests.some((q) => q.method === "PATCH" && q.path.endsWith(`/${storyId}`)));
  assert.equal(fake.items.get(storyId)!.fields["System.Title"], "Assign a field technician");
  assert.equal(fake.items.get(storyId)!.fields["Microsoft.VSTS.Scheduling.StoryPoints"], 8);
  assert.equal(fake.items.get(storyId)!.relations.length, 1, "unchanged parent: no duplicate link");
  const t = fake.items.get(getItem(task.id)!.ado_id!)!;
  assert.deepEqual(t.relations.map((x) => x.url), [`${adoBase}/fakeorg/_apis/wit/workItems/${getItem(feature.id)!.ado_id}`]);
  assert.notEqual(getItem(bug.id)!.ado_id, deleted, "new id stored");
});

test("a state the process refuses falls back to the Agile mapping and is reported", async () => {
  fake.refuseStates = new Set(["In Peer Testing", "Blocked"]);
  patchItem(story.id, { state: "In Peer Testing" });
  patchItem(task.id, { state: "Blocked" });
  const r = await call("POST", `/projects/${PID}/ado/sync`, {});
  assert.equal(r.body.failed, 0, JSON.stringify(r.body.errors));
  assert.deepEqual(r.body.stateFallbacks, [
    { code: story.code, state: "In Peer Testing", sent: "Active" },
    { code: task.code, state: "Blocked", sent: "Active" },
  ]);
  assert.equal(fake.items.get(getItem(story.id)!.ado_id!)!.fields["System.State"], "Active");

  // Agile mode maps up front and tags blocked work.
  const p = getProject(PID)!;
  patchProject(PID, { settings: { ...p.settings, ado: { ...p.settings.ado!, stateMode: "agile" } } });
  const r2 = await call("POST", `/projects/${PID}/ado/sync`, {});
  assert.deepEqual(r2.body.stateFallbacks, []);
  const tf = fake.items.get(getItem(task.id)!.ado_id!)!.fields;
  assert.equal(tf["System.State"], "Active");
  assert.match(String(tf["System.Tags"]), /; Blocked$/);
  fake.refuseStates = new Set();
});

test("one bad item doesn't stop the sync", async () => {
  patchItem(story.id, { title: "REJECT me" });
  const r = await call("POST", `/projects/${PID}/ado/sync`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.failed, 1);
  assert.equal(r.body.updated, 4);
  assert.equal(r.body.ok, false);
  assert.deepEqual(r.body.errors, [{ code: story.code, error: "TF999999: The title was refused by a custom rule" }]);
  const st = await call("GET", `/projects/${PID}/ado/status`);
  assert.equal(st.body.lastSync.failed, 1);
});

test("the token never appears in responses, activity, settings or the work items", () => {
  const encoded = Buffer.from(`:${TOKEN}`).toString("base64");
  const dump = [
    ...responses,
    JSON.stringify(all("SELECT * FROM activity")),
    JSON.stringify(all("SELECT * FROM settings")),
    JSON.stringify(all("SELECT * FROM projects")),
    JSON.stringify(all("SELECT * FROM work_items")),
  ].join("\n");
  assert.ok(responses.length > 5);
  assert.ok(!dump.includes(TOKEN));
  assert.ok(!dump.includes(encoded));
});
