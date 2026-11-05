// A token per project: each project can name its own .env variable (AZURE_DEVOPS_PAT_<NAME>), so several people work
// with their own tokens and scopes side by side, and a read-only token keeps AgentStudio from changing anything. A local
// stand-in plays Azure DevOps with two tokens: Anna's (read & write) and a read-only one.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { all, run } from "../src/db.ts";
import { cleanAdoConfig } from "../src/ado.ts";
import { claudeEnv } from "../src/claudeAccounts.ts";
import { startFakeAdo, type FakeAdo } from "./fixtures/fake-ado.ts";

const ANNA = "fake-pat-anna-0123456789abcdef";
const READER = "fake-pat-reader-0123456789abcd";
const STATES = [
  { name: "Backlog", category: "Proposed" },
  { name: "Develop", category: "InProgress" },
  { name: "Test", category: "InProgress" },
  { name: "Done", category: "Completed" },
];

let ado: FakeAdo;
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
  delete process.env.AZURE_DEVOPS_PAT;
  process.env.AZURE_DEVOPS_PAT_ANNA = ANNA;
  process.env.AZURE_DEVOPS_PAT_READER = READER;
  ado = await startFakeAdo({ token: "the-default-token-is-not-set", project: "Zephyr", states: STATES, tokens: { [ANNA]: { name: "Anna Berg", write: true }, [READER]: { name: "Read Only Bot", write: false } } });
  for (const [id, title] of [[301, "Build it"], [302, "Test it"]] as const) {
    ado.items.set(id, { id, fields: { "System.WorkItemType": "User Story", "System.Title": title, "System.State": "Backlog", "System.AssignedTo": { displayName: "Philip Oxelius" } }, relations: [] });
  }
  app = createApp().listen(0);
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "simulation", simulationSpeed: 0.02, dailyLimitUsd: 0, monthlyLimitUsd: 0 });
});

after(() => {
  app.close();
  ado.close();
  delete process.env.AZURE_DEVOPS_PAT_ANNA;
  delete process.env.AZURE_DEVOPS_PAT_READER;
});

test("the token variable: only AZURE_DEVOPS_PAT_<NAME>, never another secret, and the default isn't stored", () => {
  const base = { orgUrl: "https://dev.azure.com/acme", project: "Demo" };
  assert.equal(cleanAdoConfig({ ...base, tokenVar: "azure_devops_pat_anna" })?.tokenVar, "AZURE_DEVOPS_PAT_ANNA");
  assert.equal(cleanAdoConfig({ ...base, tokenVar: "AZURE_DEVOPS_PAT" })?.tokenVar, undefined);
  assert.equal(cleanAdoConfig({ ...base, tokenVar: "" })?.tokenVar, undefined);
  for (const bad of ["ANTHROPIC_API_KEY", "GH_TOKEN", "AZURE_DEVOPS_PATX", "AZURE_DEVOPS_PAT_", "AZURE_DEVOPS_PAT_A-B"]) {
    assert.throws(() => cleanAdoConfig({ ...base, tokenVar: bad }), /must be AZURE_DEVOPS_PAT/, bad);
  }
});

/** Every request since the last reset carried this person's token. */
const onlyBy = (name: string) => ado.seenTokens.length > 0 && ado.seenTokens.every((n: string) => n === name);

let annaPid = "";
let readerPid = "";

test("each project uses its own token, and Test connection says whose it is and the scope it needs", async () => {
  const agents = await api<any[]>("GET", "/agents");
  const make = async (key: string) => (await api("POST", "/projects", { name: key, key, description: "", agentIds: agents.map((a) => a.id), settings: { gates: true, parallelism: 1, budgetUsd: 0, maxRework: 1, repo: { url: `https://github.com/demo/${key.toLowerCase()}.git`, branch: "main" } } })).id as string;
  annaPid = await make("TKA");
  readerPid = await make("TKR");

  const anna = await api("POST", `/projects/${annaPid}/ado/test`, { config: { orgUrl: ado.url, project: "Zephyr", tokenVar: "AZURE_DEVOPS_PAT_ANNA" } });
  assert.deepEqual(anna, { ok: true, project: "Zephyr", process: "Agile", identity: "Anna Berg", tokenVar: "AZURE_DEVOPS_PAT_ANNA", scope: "Work Items (Read & write)" });
  const reader = await api("POST", `/projects/${readerPid}/ado/test`, { config: { orgUrl: ado.url, project: "Zephyr", tokenVar: "AZURE_DEVOPS_PAT_READER", writeMode: "none" } });
  assert.equal(reader.identity, "Read Only Bot");
  assert.equal(reader.scope, "Work Items (Read)");

  const before = ado.seenTokens.length;
  const missing = await api("POST", `/projects/${annaPid}/ado/test`, { config: { orgUrl: ado.url, project: "Zephyr", tokenVar: "AZURE_DEVOPS_PAT_NOBODY" } });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Add AZURE_DEVOPS_PAT_NOBODY=…/);
  assert.equal(ado.seenTokens.length, before, "nothing is sent without the token");

  // Importing with each project's token: the requests carry that token, and the variable's name is saved, never the token.
  ado.seenTokens.length = 0;
  await api("POST", `/projects/${annaPid}/ado/import`, { config: { orgUrl: ado.url, project: "Zephyr", stateMode: "same", tokenVar: "AZURE_DEVOPS_PAT_ANNA" }, filter: {}, rule: { assignees: ["Philip Oxelius"] } });
  assert.ok(onlyBy("Anna Berg"), ado.seenTokens.join(", "));
  ado.seenTokens.length = 0;
  await api("POST", `/projects/${readerPid}/ado/import`, { config: { orgUrl: ado.url, project: "Zephyr", stateMode: "same", tokenVar: "AZURE_DEVOPS_PAT_READER" }, filter: {}, rule: { assignees: ["Philip Oxelius"] } });
  assert.ok(onlyBy("Read Only Bot"), ado.seenTokens.join(", "));
  const saved = await api("GET", `/projects/${readerPid}`);
  assert.equal(saved.settings.ado.tokenVar, "AZURE_DEVOPS_PAT_READER");
  assert.ok(!JSON.stringify(saved).includes(READER), "the token itself is never stored");

  const status = await api("GET", `/projects/${readerPid}/ado/status`);
  assert.equal(status.tokenPresent, true);
  assert.equal(status.tokenVar, "AZURE_DEVOPS_PAT_READER");
  assert.ok(!JSON.stringify(status).includes(READER));
});

test("a token that can only read: the first refused write switches the project to Read only, and says why", async () => {
  run("UPDATE work_items SET state = 'In Progress' WHERE project_id = ? AND ado_id IN (301, 302)", readerPid);
  const s = await api("POST", `/projects/${readerPid}/ado/sync`);
  assert.equal(s.ok, false);
  assert.match(s.error, /AZURE_DEVOPS_PAT_READER: the token can read but not write\. AgentStudio switched TKR to Read only/);
  assert.equal(s.failed, 0, "stopped at the first refusal instead of trying every story");
  assert.ok(!s.error.includes(READER));
  assert.equal(ado.items.get(301)!.fields["System.State"], "Backlog");
  assert.equal((await api("GET", `/projects/${readerPid}`)).settings.ado.writeMode, "none");
  const activity = all<{ summary: string }>("SELECT summary FROM activity WHERE project_id = ? AND type = 'ado_sync'", readerPid);
  assert.ok(activity.some((a) => /switched TKR to Read only/.test(a.summary)));
  const again = await call("POST", `/projects/${readerPid}/ado/sync`);
  assert.equal(again.status, 400);
  assert.match(again.body.error, /read only/);

  // Anna's project, same stories, writes as before.
  run("UPDATE work_items SET state = 'In Progress' WHERE project_id = ? AND ado_id = 301", annaPid);
  const a = await api("POST", `/projects/${annaPid}/ado/sync`);
  assert.equal(a.updated, 1);
  assert.equal(ado.items.get(301)!.fields["System.State"], "Develop");
});

test("Azure DevOps tokens never reach the claude process", () => {
  const env = claudeEnv();
  assert.ok(!Object.keys(env).some((k) => k.startsWith("AZURE_DEVOPS_PAT")));
});
