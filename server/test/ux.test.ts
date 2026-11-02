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

test("next steps after a release: deployment steps, untested ACs, open items and whether it's on the remote", async () => {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { TMP, fileUrl } = await import("./setup.ts");
  const { insert, now } = await import("../src/db.ts");
  const { ensureRepo, pushRefs, tagRelease } = await import("../src/git.ts");

  const remote = path.join(TMP, "nxt-remote.git");
  fs.mkdirSync(remote, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
  const p = await newProject("NXT");
  assert.equal((await api("GET", `/projects/${p.id}/next-steps`)).body.release, null, "nothing before a release");
  await api("PATCH", `/projects/${p.id}`, { settings: { repo: { url: fileUrl(remote), branch: "main", push: true } } });

  const seeded = createItem(p.id, { type: "story", title: "Seed clubs", state: "Deployed (Done)", tags: ["Post-deploy Steps"], manual_steps: "Run the seed CLI against production." });
  createItem(p.id, { type: "story", title: "Report", state: "Deployed (Done)" });
  const blocked = createItem(p.id, { type: "story", title: "Refunds", state: "Blocked" });
  insert("test_results", { project_id: p.id, item_id: seeded.id, kind: "qa", ac_ref: "AC 2", result: "blocked", notes: "Needs production data.", iteration: 1, agent_id: "agt_qa", created_at: now() });
  insert("releases", { id: "rel_nxt", project_id: p.id, version: "1.0.0", notes: "# 1.0.0", status: "published", created_at: now() });
  const proj = getProject(p.id)!;
  await ensureRepo(proj);
  await tagRelease(proj, "1.0.0", "release 1.0.0");

  let n = (await api("GET", `/projects/${p.id}/next-steps`)).body;
  assert.equal(n.release.version, "1.0.0");
  assert.deepEqual(n.steps.map((s: any) => [s.code, s.post, s.text]), [[seeded.code, true, "Run the seed CLI against production."]]);
  assert.deepEqual(n.untested.map((u: any) => [u.code, u.ac]), [[seeded.code, "AC 2"]]);
  assert.ok(n.issues.some((i: any) => i.code === blocked.code));
  assert.equal(n.github.reachable, true);
  assert.equal(n.github.basePushed, false, "main isn't on the remote yet");
  assert.equal(n.github.tagPushed, false);

  assert.ok((await pushRefs(proj, ["main"], true)).pushed);
  n = (await api("GET", `/projects/${p.id}/next-steps`)).body;
  assert.equal(n.github.basePushed, true);
  assert.equal(n.github.tagPushed, true, "the release tag is on the remote");
});

test("the requirements template is served with its default choices", async () => {
  const res = await fetch(`${base}/api/templates/requirements`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /markdown/);
  const md = await res.text();
  for (const heading of ["## Defaults", "**Time zone and locale:**", "**Sign-in:**", "**Stack:**", "## Manual steps", "## Out of scope", "## Open decisions"]) assert.ok(md.includes(heading), heading);
});
