// AgentStudio's rule: which items it builds when they weren't given to it or to someone by hand. Checked every time,
// so imported, edited and reassigned items follow it.
import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

const { cleanWorkRule, matchesRule, ownedByStudio, iterationOf } = await import("../src/ownership.ts");
const { createApp } = await import("../src/app.ts");
const { createItem, getProject, patchItem } = await import("../src/store.ts");
const { insert, now } = await import("../src/db.ts");

const item = (o: Record<string, unknown> = {}) => ({ owner: null, assignee: "Philip Oxelius", iteration: "2026-23", sprint: null, tags: ["Zephyr"], ...o }) as any;
const withRule = (workRule: unknown) => ({ settings: { workRule } }) as any;

test("a rule matches any value within a field and every field it sets, ignoring case", () => {
  const rule = { assignees: ["philip oxelius", "Anna"], iterations: ["2026-23"], tags: ["zephyr"] };
  assert.equal(matchesRule(rule, item()), true);
  assert.equal(matchesRule(rule, item({ assignee: "Anna" })), true);
  assert.equal(matchesRule(rule, item({ assignee: "Bo" })), false);
  assert.equal(matchesRule(rule, item({ assignee: null })), false, "unassigned doesn't match a rule on assignees");
  assert.equal(matchesRule(rule, item({ iteration: "2026-24" })), false);
  assert.equal(matchesRule(rule, item({ tags: ["Other"] })), false);
  assert.equal(matchesRule({ iterations: ["Sprint 2"] }, item({ iteration: null, sprint: 2 })), true, "AgentStudio's own sprints count as iterations");
  assert.equal(iterationOf({ iteration: " ", sprint: 3 }), "Sprint 3");
});

test("an explicit owner wins over the rule; without a rule everything is AgentStudio's", () => {
  const p = withRule({ assignees: ["Philip Oxelius"] });
  assert.equal(ownedByStudio(p, item()), true);
  assert.equal(ownedByStudio(p, item({ assignee: "Anna" })), false, "outside the rule");
  assert.equal(ownedByStudio(p, item({ assignee: "Anna", owner: "agentstudio" })), true, "given to AgentStudio by hand");
  assert.equal(ownedByStudio(p, item({ owner: "person" })), false, "given to someone by hand");
  assert.equal(ownedByStudio(withRule(null), item({ assignee: "Anna" })), true);
  assert.equal(ownedByStudio(withRule({ assignees: [" "] }), item({ assignee: "Anna" })), true, "an empty rule is no rule");
});

test("rules are cleaned and checked: lists of names, duplicates removed, empty = none", () => {
  assert.deepEqual(cleanWorkRule({ assignees: [" Anna ", "Anna", ""], tags: ["Zephyr"] }), { assignees: ["Anna"], iterations: undefined, tags: ["Zephyr"] });
  assert.equal(cleanWorkRule({ assignees: [], iterations: [""] }), null);
  assert.equal(cleanWorkRule(null), null);
  assert.throws(() => cleanWorkRule({ assignees: "Anna" }), /must be a list/);
  assert.throws(() => cleanWorkRule({ tags: ["x".repeat(121)] }), /at most 50 values/);
});

test("the rule is saved on the project, and the items list says which items AgentStudio builds", async () => {
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    const ts = now();
    insert("projects", { id: "prj_RUL", key: "RUL", name: "RUL", status: "ready", mode: "simulation", created_at: ts, updated_at: ts, settings: { gates: true, parallelism: 1, budgetUsd: 0, maxRework: 1 } });
    const mine = createItem("prj_RUL", { type: "story", title: "Search accounts" });
    const anna = createItem("prj_RUL", { type: "story", title: "Export accounts" });
    patchItem(mine.id, { assignee: "Philip Oxelius", iteration: "2026-23" });
    patchItem(anna.id, { assignee: "Anna", iteration: "2026-23" });
    assert.equal((await call("PATCH", "/projects/RUL", { settings: { workRule: { assignees: "Philip" } } })).status, 400);
    const saved = await call("PATCH", "/projects/RUL", { settings: { workRule: { assignees: ["Philip Oxelius"], iterations: ["2026-23"] } } });
    assert.equal(saved.status, 200);
    assert.deepEqual(getProject("prj_RUL")!.settings.workRule, { assignees: ["Philip Oxelius"], iterations: ["2026-23"] });
    const items = (await call("GET", "/projects/RUL/items")).body as { id: string; ours: boolean }[];
    assert.deepEqual(items.map((i) => [i.id, i.ours]).sort(), [[mine.id, true], [anna.id, false]].sort());
    // Reassigned later (e.g. in Azure DevOps): the rule follows without anyone going through the backlog.
    patchItem(anna.id, { assignee: "Philip Oxelius" });
    assert.equal(((await call("GET", "/projects/RUL/items")).body as { id: string; ours: boolean }[]).find((i) => i.id === anna.id)!.ours, true);
    await call("PATCH", "/projects/RUL", { settings: { workRule: null } });
    assert.equal(getProject("prj_RUL")!.settings.workRule, null);
  } finally {
    server.close();
  }
});
