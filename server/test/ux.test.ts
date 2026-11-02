// What a person needs after the agents: where a story's working copy is, and what's left to do after a release.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const { createApp } = await import("../src/app.ts");
const { createItem, getProject, patchItem, worktreeDir } = await import("../src/store.ts");
const { ensureItemBranch } = await import("../src/git.ts");

let server: Server;
let base = "";
async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "content-type": "application/json" } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

before(() => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function newProject(key: string) {
  const agents = (await api<any[]>("GET", "/agents")).body;
  return (await api("POST", "/projects", { name: key, key, description: "x", agentIds: agents.map((a) => a.id), settings: { gates: true, parallelism: 1, budgetUsd: 0, maxRework: 1, repo: { url: `https://github.com/demo/${key.toLowerCase()}.git`, branch: "main" } } })).body;
}

test("a story shows its worktree path; a terminal can only be opened where one exists", async () => {
  const p = await newProject("WTP");
  const story = createItem(p.id, { type: "story", title: "Seed data" });
  assert.equal((await api("GET", `/items/${story.id}`)).body.worktree, null, "no branch yet, no working copy");
  assert.equal((await api("POST", `/items/${story.id}/terminal`)).status, 409);

  const { branch } = await ensureItemBranch(getProject(p.id)!, story);
  patchItem(story.id, { branch });
  const { body } = await api("GET", `/items/${story.id}`);
  assert.deepEqual(body.worktree, { path: worktreeDir(getProject(p.id)!, story.code), exists: true });
});
