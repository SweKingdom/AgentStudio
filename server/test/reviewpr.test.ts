// Review mode: a finished story isn't merged by AgentStudio. Its PR opens ready for review, the story waits In Review,
// a person merges (or closes) the PR on GitHub, and AgentStudio picks that up. Without GitHub, the story's Merge
// button merges it. The fake `gh` works on local bare repositories; nothing talks to GitHub.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { TMP, fileUrl } from "./setup.ts";
import { createApp } from "../src/app.ts";
import { all } from "../src/db.ts";
import { workspaceDir } from "../src/store.ts";

const FAKE_GH = path.resolve(import.meta.dirname, "fixtures/fake-gh.mjs");
process.env.ARM_GH_BIN = FAKE_GH;
process.env.ARM_FORCE_GITHUB = "1";

let server: Server;
let base = "";

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(`${base}/api${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "content-type": "application/json" } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await call(method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
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
/** A person on GitHub: the same fake gh, run by hand. */
const person = (...args: string[]) => execFileSync(process.execPath, [FAKE_GH, ...args], { encoding: "utf8" });
const stopped = async (key: string) => {
  const p = await api("GET", `/projects/${key}`);
  return !p.running && p.jobs.length === 0 && (p.status === "awaiting_approval" || p.status === "completed");
};

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "simulation", simulationSpeed: 0, dailyLimitUsd: 0, monthlyLimitUsd: 0 });
});

after(() => server.close());

async function project(key: string, repoUrl: string, push: boolean) {
  const agents = await api<any[]>("GET", "/agents");
  const team = ["requirements", "developer", "qa", "writer"].map((role) => agents.find((a) => a.role === role)!.id);
  await api("POST", "/projects", {
    name: `Review ${key}`,
    key,
    description: "Members book a class. Members cancel a booking.",
    agentIds: team,
    settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 2, mergeMode: "review", repo: { url: repoUrl, branch: "main", push } },
    start: true,
  });
  await waitFor(() => stopped(key), `${key} to stop`);
  return (await api<any[]>("GET", `/projects/${key}/items`)).filter((i) => i.type === "story" || i.type === "task");
}

test("review mode: PRs open ready for review and nothing is merged until a person merges it on GitHub", async () => {
  const remote = path.join(TMP, "rva-remote.git");
  fs.mkdirSync(remote, { recursive: true });
  sh(remote, "init", "-q", "--bare", "-b", "main");
  const state = path.join(TMP, "RVA-gh.json");
  Object.assign(process.env, { ARM_FAKE_GH_REMOTE: remote, ARM_FAKE_GH_STATE: state, ARM_FAKE_GH_LOG: path.join(TMP, "RVA-gh.log") });
  delete process.env.ARM_FAKE_GH_FAIL;

  const items = await project("RVA", fileUrl(remote), true);
  const p = await api("GET", "/projects/RVA");
  assert.equal(p.stage, "open_items", "the project waits for the reviews");
  const inReview = items.filter((i) => i.state === "In Review");
  assert.ok(inReview.length >= 1, "finished stories are in review");
  const prs = () => JSON.parse(fs.readFileSync(state, "utf8")).prs as any[];
  for (const it of inReview) {
    const pr = prs().find((x) => x.headRefName === it.branch);
    assert.ok(pr, `${it.code} has a PR`);
    assert.equal(pr.state, "OPEN", "AgentStudio didn't merge it");
    assert.equal(pr.isDraft, false, "ready for review");
    assert.equal(it.pr_url, pr.url);
    assert.ok(pr.comments.some((c: string) => /QA verdict: approved/.test(c)), "QA's verdict is on the PR");
    assert.throws(() => sh(remote, "merge-base", "--is-ancestor", it.branch, "main"), "not on origin's main");
  }
  assert.ok(p.undelivered.some((u: any) => /^In review: https:\/\/github\.com\//.test(u.reason)));

  // A person merges the first PR and closes the second (if there is one).
  const [first, second] = inReview.map((it) => prs().find((x) => x.headRefName === it.branch));
  person("pr", "merge", String(first.number), "--repo", "demo/rva", "--merge", "--subject", "Merged by a reviewer");
  if (second) {
    const s = JSON.parse(fs.readFileSync(state, "utf8"));
    s.prs.find((x: any) => x.number === second.number).state = "CLOSED";
    fs.writeFileSync(state, JSON.stringify(s));
  }
  const checked = await api("POST", "/projects/RVA/reviews/check");
  assert.equal(checked.merged, 1);
  assert.equal(checked.closed, second ? 1 : 0);
  const after = await api<any[]>("GET", "/projects/RVA/items");
  assert.equal(after.find((i) => i.id === inReview[0].id).state, "Release Ready", "merged after review");
  if (second) assert.equal(after.find((i) => i.id === inReview[1].id).state, "Blocked", "closed without merging");
  sh(workspaceDir({ key: "RVA" }), "merge-base", "--is-ancestor", inReview[0].branch, "main");
  const log = all<{ summary: string }>("SELECT a.summary FROM activity a JOIN projects p ON p.id = a.project_id WHERE p.key = 'RVA'");
  assert.ok(log.some((a) => /was merged after review/.test(a.summary)));
  assert.equal((await call("POST", `/items/${inReview[0].id}/merge-review`)).status, 409, "already merged");
});

test("review mode without GitHub: the story waits, and its Merge button merges it", async () => {
  delete process.env.ARM_FORCE_GITHUB;
  try {
    const items = await project("RVB", "https://example.com/demo/rvb.git", false);
    const waiting = items.filter((i) => i.state === "In Review");
    assert.ok(waiting.length >= 1);
    assert.equal(waiting[0].pr_url, null, "no PR without GitHub");
    const ws = workspaceDir({ key: "RVB" });
    assert.throws(() => sh(ws, "merge-base", "--is-ancestor", waiting[0].branch, "main"), "not merged yet");
    const merged = await api("POST", `/items/${waiting[0].id}/merge-review`);
    assert.equal(merged.state, "Release Ready");
    sh(ws, "merge-base", "--is-ancestor", waiting[0].branch, "main");
    assert.equal((await call("PATCH", `/items/${waiting[0].id}`, { merge_mode: "later" })).status, 400);
    assert.equal((await call("PATCH", "/projects/RVB", { settings: { mergeMode: "sometimes" } })).status, 400);
  } finally {
    process.env.ARM_FORCE_GITHUB = "1";
  }
});

test("changes requested: the review becomes editable feedback, goes to the developer, and the PR goes back to review", async () => {
  const remote = path.join(TMP, "rvc-remote.git");
  fs.mkdirSync(remote, { recursive: true });
  sh(remote, "init", "-q", "--bare", "-b", "main");
  const state = path.join(TMP, "RVC-gh.json");
  Object.assign(process.env, { ARM_FAKE_GH_REMOTE: remote, ARM_FAKE_GH_STATE: state, ARM_FAKE_GH_LOG: path.join(TMP, "RVC-gh.log") });
  const items = await project("RVC", fileUrl(remote), true);
  const story = items.find((i) => i.state === "In Review")!;
  assert.ok(story, "a story in review");
  const devRuns = () => all<{ n: number }>("SELECT COUNT(*) n FROM runs WHERE item_id = ? AND stage = 'development'", story.id)[0].n;
  const before = devRuns();
  /** A reviewer on GitHub requests changes (the fake gh reads reviews from its state file). */
  const review = (at: string, body: string, line?: string) => {
    const s = JSON.parse(fs.readFileSync(state, "utf8"));
    const pr = s.prs.find((x: any) => x.headRefName === story.branch);
    pr.reviewDecision = "CHANGES_REQUESTED";
    pr.reviews = [...(pr.reviews ?? []), { author: { login: "anna" }, state: "CHANGES_REQUESTED", body, submittedAt: at }];
    if (line) pr.lineComments = [...(pr.lineComments ?? []), { user: { login: "anna" }, path: "src/bookings.ts", line: 3, body: line, created_at: at }];
    fs.writeFileSync(state, JSON.stringify(s));
    return pr.number as number;
  };
  const n = review("2026-11-04T10:00:00Z", "Rename the endpoint.", "Use the shared error type here.");
  assert.equal((await api("POST", "/projects/RVC/reviews/check")).requested, 1);
  let it = await api("GET", `/items/${story.id}`);
  assert.equal(it.state, "Changes Requested");
  assert.match(it.review_feedback, /Review by anna on PR #\d+:\nRename the endpoint\./);
  assert.match(it.review_feedback, /- src\/bookings\.ts:3 \(anna\): Use the shared error type here\./);
  assert.equal((await api("POST", "/projects/RVC/reviews/check")).requested, 0, "each review is taken up once");
  assert.equal((await call("POST", `/items/${story.id}/review-feedback`, { feedback: "  " })).status, 409, "empty feedback is refused");

  // You edit the feedback and send it: a rework round on the same branch, and the same PR waits in review again.
  await api("POST", `/items/${story.id}/review-feedback`, { feedback: "Rename the endpoint to /bookings." });
  await waitFor(async () => (await api("GET", `/items/${story.id}`)).state === "In Review" && (await stopped("RVC")), "the story back in review");
  assert.ok(devRuns() > before, "the developer reworked it");
  const pr = JSON.parse(fs.readFileSync(state, "utf8")).prs.filter((x: any) => x.headRefName === story.branch);
  assert.equal(pr.length, 1, "the same PR, not a new one");
  assert.equal(pr[0].number, n);
  assert.equal(pr[0].state, "OPEN");
  it = await api("GET", `/items/${story.id}`);
  assert.ok(it.comments.some((c: any) => /Rename the endpoint to \/bookings\./.test(c.content)), "your edited feedback is on the story");
  assert.equal((await call("POST", `/items/${story.id}/review-feedback`, { feedback: "x" })).status, 409, "nothing to send while it's in review");

  // Set to send reviews to the developer by itself: a new review starts the rework without you.
  await api("PATCH", "/projects/RVC", { settings: { reviewRework: "auto" } });
  const runs = devRuns();
  review("2026-11-04T12:00:00Z", "Also add a test for a full class.");
  assert.equal((await api("POST", "/projects/RVC/reviews/check")).requested, 1);
  await waitFor(async () => devRuns() > runs && (await api("GET", `/items/${story.id}`)).state === "In Review" && (await stopped("RVC")), "the automatic rework");
  assert.equal((await call("PATCH", "/projects/RVC", { settings: { reviewRework: "sometimes" } })).status, 400);
});
