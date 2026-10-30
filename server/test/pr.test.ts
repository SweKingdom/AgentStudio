import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { TMP } from "./setup.ts";
import { createApp } from "../src/app.ts";
import { all } from "../src/db.ts";
import { workspaceDir, worktreeDir } from "../src/store.ts";
import { githubRepoOf, redact } from "../src/github.ts";

// The `gh` stand-in works on local bare repositories; ARM_FORCE_GITHUB=1 lets their file:// URLs count as GitHub.
process.env.ARM_GH_BIN = path.resolve(import.meta.dirname, "fixtures/fake-gh.mjs");
process.env.ARM_FORCE_GITHUB = "1";

let server: Server;
let base = "";

async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function waitFor(pred: () => Promise<boolean>, what: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const DESCRIPTION = "Service agents must create a case from an email automatically. Managers need a weekly report of open cases per team. Agents should see the customer's order status from the ERP API.";

/** A project that pushes to a fresh local bare repository, with the fake gh pointed at it. */
async function run(key: string, fail?: "all" | "merge") {
  const remote = path.join(TMP, `${key.toLowerCase()}-remote.git`);
  fs.mkdirSync(remote, { recursive: true });
  sh(remote, "init", "-q", "--bare", "-b", "main");
  const log = path.join(TMP, `${key}-gh.log`);
  const state = path.join(TMP, `${key}-gh.json`);
  Object.assign(process.env, { ARM_FAKE_GH_REMOTE: remote, ARM_FAKE_GH_STATE: state, ARM_FAKE_GH_LOG: log });
  if (fail) process.env.ARM_FAKE_GH_FAIL = fail;
  else delete process.env.ARM_FAKE_GH_FAIL;
  const agents = await api<any[]>("GET", "/agents");
  const team = ["requirements", "developer", "qa", "writer"].map((role) => agents.find((a) => a.role === role)!.id);
  await api("POST", "/projects", {
    name: `PR ${key}`,
    key,
    description: DESCRIPTION,
    agentIds: team,
    settings: { gates: false, parallelism: 2, budgetUsd: 0, maxRework: 2, repo: { url: `file://${remote}`, branch: "main", push: true } },
    start: true,
  });
  await waitFor(async () => {
    const p = await api("GET", `/projects/${key}`);
    return p.status === "completed" && !p.running && p.jobs.length === 0;
  }, `${key} to complete`);
  const items = (await api<any[]>("GET", `/projects/${key}/items`)).filter((i) => i.branch);
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const prs = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")).prs : [];
  const activity = all<{ summary: string; item_id: string }>("SELECT a.summary, a.item_id FROM activity a JOIN projects p ON p.id = a.project_id WHERE p.key = ? ORDER BY a.id", key);
  return { remote, items, calls, prs, activity, ws: workspaceDir({ key }) };
}

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "simulation", simulationSpeed: 0, dailyLimitUsd: 0, monthlyLimitUsd: 0 });
});

after(() => server.close());

test("GitHub repository names and redaction", () => {
  assert.equal(githubRepoOf("https://github.com/acme/field-service.git"), "acme/field-service");
  assert.equal(githubRepoOf("git@github.com:acme/field-service.git"), "acme/field-service");
  assert.equal(redact("remote: https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b"), "remote: https://[redacted]@github.com/a/b");
  assert.equal(redact("token ghp_abcdefghijklmnopqrstuvwxyz0123 leaked"), "token [redacted] leaked");
});

test("each story goes through a pull request: draft at hand-over, QA comments, merged on GitHub", async () => {
  const r = await run("PRA");
  assert.ok(r.items.length >= 3, "stories were built");
  assert.ok(r.calls.length > 0, "gh was used");
  for (const c of r.calls) {
    assert.ok(c.args.includes("--repo"), `every gh call names the repository: ${c.args.join(" ")}`);
    assert.ok(c.promptDisabled, "gh never prompts");
  }
  for (const it of r.items) {
    assert.equal(it.state, "Release Ready", `${it.code} delivered`);
    const pr = r.prs.find((p: any) => p.headRefName === it.branch);
    assert.ok(pr, `${it.code} has a PR`);
    assert.equal(it.pr_url, pr.url, "the item links its PR");
    assert.equal(pr.state, "MERGED");
    assert.equal(pr.baseRefName, "main");
    assert.match(pr.title, new RegExp(`^Merge ${it.branch}: ${it.code}`), "title = the team's merge pattern");
    assert.match(pr.body, new RegExp(`## ${it.code} — `), "body = the PR template");
    // Draft first (opened at the developer's hand-over), then ready, then merged.
    const mine = r.calls.filter((c: any) => c.args.includes(String(pr.number)) || c.args.includes(it.branch));
    const idx = (pred: (c: any) => boolean) => mine.findIndex(pred);
    const created = idx((c) => c.args[1] === "create");
    assert.ok(mine[created].args.includes("--draft"), "opened as a draft");
    assert.ok(created < idx((c) => c.args[1] === "ready") && idx((c) => c.args[1] === "ready") < idx((c) => c.args[1] === "merge"));
    // QA's verdict, signed by the QA agent, without links.
    const verdict = pr.comments.find((c: string) => /QA verdict: approved/.test(c));
    assert.ok(verdict, `${it.code} has QA's verdict`);
    assert.match(verdict, /\| ✅ \|/);
    assert.match(verdict, /— [\p{L}\p{M}]+ \(QA\)$/u);
    assert.doesNotMatch(verdict, /\]\(|https?:\/\//);
    // The merge is on origin and in the local base branch.
    sh(r.ws, "merge-base", "--is-ancestor", it.branch, "main");
    sh(r.remote, "merge-base", "--is-ancestor", it.branch, "main");
    assert.ok(r.activity.some((a) => a.summary === `Opened draft PR #${pr.number} for ${it.code}`));
    assert.ok(r.activity.some((a) => a.summary === `Merged PR #${pr.number} into main`));
  }
  // The story QA rejected once has the findings on its PR.
  const reworked = r.items.find((i) => i.rework_count > 0);
  assert.ok(reworked, "one story went through rework");
  const pr = r.prs.find((p: any) => p.headRefName === reworked.branch);
  assert.ok(pr.comments.some((c: string) => /QA: changes requested/.test(c) && /❌/.test(c)), "rework findings commented");
  assert.match(pr.comments.at(-1), /1 rework loop/);
  // Local main = origin main after the last story (every merge came from GitHub).
  assert.equal(sh(r.ws, "rev-parse", "main"), sh(r.ws, "rev-parse", "origin/main"));
  assert.match(sh(r.ws, "log", "main", "--format=%s"), /Merge feature\/.+: US-\d+/);
  for (const it of r.items) assert.ok(!fs.existsSync(worktreeDir({ key: "PRA" }, it.code)), "worktrees removed");
});

test("when gh fails, stories are merged locally and pushed — nothing is lost", async () => {
  const r = await run("PRF", "all");
  assert.ok(r.items.length >= 3);
  for (const it of r.items) {
    assert.equal(it.state, "Release Ready", `${it.code} still delivered`);
    assert.equal(it.pr_url, null);
    sh(r.ws, "merge-base", "--is-ancestor", it.branch, "main");
    sh(r.remote, "merge-base", "--is-ancestor", it.branch, "main");
  }
  assert.ok(r.activity.some((a) => /Couldn't open a draft PR/.test(a.summary)));
  assert.ok(r.activity.some((a) => /merging locally and pushing instead/.test(a.summary)));
  assert.equal(r.prs.length, 0);
});

test("when only the GitHub merge fails, the PR stays and the story is merged locally", async () => {
  const r = await run("PRM", "merge");
  for (const it of r.items) {
    assert.equal(it.state, "Release Ready");
    assert.match(it.pr_url ?? "", /\/pull\/\d+$/, "the PR was opened");
    sh(r.remote, "merge-base", "--is-ancestor", it.branch, "main");
  }
  assert.ok(r.activity.some((a) => /GitHub PR #\d+ for .+ failed: .*merging locally/.test(a.summary)));
});
