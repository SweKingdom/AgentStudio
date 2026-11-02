// Untested and weakened acceptance criteria never pass silently: a story whose AC needs another story waits for it,
// the release waits for your approval of ⛔ ACs, and an AC met differently than written goes to the product owner.
// A scripted stand-in plays Claude; the checks run for real.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.ANTHROPIC_API_KEY = "test-key-never-sent";

const { createApp } = await import("../src/app.ts");
const { setAnthropicClientForTests } = await import("../src/agents/runner.ts");
const { createItem, getItem, getProject, workspaceDir } = await import("../src/store.ts");
const { all, insert, now, run } = await import("../src/db.ts");

let n = 0;
const reply = (content: any[]) => ({
  id: `msg_${++n}`,
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content,
  stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
const use = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `toolu_${++n}`, name, input });
const firstText = (params: any) => {
  const c = params.messages[0].content;
  return Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : String(c);
};

/** What each story's agents do, by story title. Each QA / dev run takes the next script entry (the last one repeats). */
type QaStep = { blocked?: { ac: string; waitsFor?: string }; reinterpret?: string; fail?: string };
const scripts: Record<string, { dev?: { deviation?: string; ac?: string }[]; qa?: QaStep[] }> = {};
const runs: string[] = [];
/** Each QA run's task, by story title. */
const qaTasks: Record<string, string> = {};
/** While set, every model call waits for it: a run that stays running. */
let hold: Promise<void> | null = null;
const count = new Map<string, number>();
const next = <T,>(list: T[] | undefined, key: string): T | undefined => {
  if (!list?.length) return undefined;
  const i = count.get(key) ?? 0;
  count.set(key, i + 1);
  return list[Math.min(i, list.length - 1)];
};

function respond(params: any) {
  const tools: string[] = params.tools.map((t: any) => t.name);
  const turn = params.messages.filter((m: any) => m.role === "assistant").length;
  const text = firstText(params);
  const code = text.match(/(?:Implement|Peer-test|didn't hand|requested changes on) (US-\d+)/)?.[1] ?? text.match(/(US-\d+)/)?.[1] ?? "";
  const title = Object.keys(scripts).find((t) => text.includes(`"${t}"`)) ?? "";
  if (tools.includes("complete_development")) {
    if (turn === 0) {
      runs.push(`dev:${title}`);
      (globalThis as any).__dev = next(scripts[title]?.dev, `dev:${title}`);
      return reply([use("write_file", { path: `src/${code.toLowerCase()}.js`, content: `export const x = ${n};\n` })]);
    }
    if (turn === 1) return reply([use("run_checks", {})]);
    if (turn === 2) {
      const d = (globalThis as any).__dev as { deviation?: string; ac?: string } | undefined;
      return reply([use("complete_development", { code, summary: `${code} built.`, ...(d?.deviation ? { deviations: [{ ac: d.ac ?? "AC 1", how: d.deviation }] } : {}) })]);
    }
    return reply([{ type: "text", text: "Handed over." }]);
  }
  if (tools.includes("submit_review")) {
    if (turn === 0) {
      runs.push(`qa:${title}`);
      qaTasks[title] = text;
      (globalThis as any).__qa = next(scripts[title]?.qa, `qa:${title}`) ?? {};
      return reply([use("run_checks", {})]);
    }
    const s = (globalThis as any).__qa as QaStep;
    if (turn === 1) {
      return reply([
        s.fail
          ? use("record_test_result", { code, ac_ref: s.fail, result: "fail", notes: "Still wrong." })
          : s.blocked
            ? use("record_test_result", { code, ac_ref: s.blocked.ac, result: "blocked", notes: "Needs data that isn't there yet.", ...(s.blocked.waitsFor ? { waits_for: s.blocked.waitsFor } : {}) })
            : use("record_test_result", { code, ac_ref: "AC 1", result: "pass", notes: "Works." }),
      ]);
    }
    if (turn === 2 && s.fail) return reply([use("submit_review", { code, verdict: "changes_requested", findings: `${s.fail} is still wrong.` })]);
    if (turn === 2) return reply([use("submit_review", { code, verdict: "approved", findings: "", ...(s.reinterpret ? { reinterpretations: [{ ac: "AC 1", how: s.reinterpret }] } : {}) })]);
    return reply([{ type: "text", text: "Done." }]);
  }
  if (tools.includes("publish_release")) {
    if (turn === 0) return reply([use("run_checks", {})]);
    if (turn === 1) return reply([use("publish_release", { version: "1.0.0", notes: "# Release" })]);
    return reply([{ type: "text", text: "Released." }]);
  }
  return reply([{ type: "text", text: "Done." }]);
}

let server: Server;
let base = "";
async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
async function waitFor(pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A project whose main already has a package.json with a passing test, so stories run in parallel lanes. */
async function newProject(key: string, roles: string[]) {
  const agents = await api<any[]>("GET", "/agents");
  const p = await api("POST", "/projects", {
    name: key,
    key,
    description: "x",
    agentIds: agents.filter((a) => roles.includes(a.role)).map((a) => a.id),
    settings: { gates: false, parallelism: 2, budgetUsd: 0, maxRework: 1, checks: { install: "off" }, repo: { url: `https://github.com/demo/${key.toLowerCase()}.git`, branch: "main" } },
  });
  const dir = workspaceDir(getProject(p.id)!);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: key.toLowerCase(), private: true, scripts: { test: "node -e 0" } }));
  return p;
}
const story = (pid: string, title: string, rank: number) => createItem(pid, { type: "story", title, state: "To Do", rank, story_points: 3, acceptance_criteria: "### AC 1: Works\nIt works." });

before(async () => {
  setAnthropicClientForTests({
    beta: { messages: { stream: (params: any) => ({ finalMessage: async () => (await hold, respond(params)) }) } },
    messages: { create: async () => reply([{ type: "text", text: "ok" }]), countTokens: async () => ({ input_tokens: 10 }) },
  });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "live", backend: "api" });
});
after(async () => {
  await api("PUT", "/settings", { mode: "simulation", backend: "auto" });
  server.close();
});

test("an AC that needs another story waits for it to be merged and is tested again, instead of passing untested", async () => {
  const p = await newProject("WFS", ["developer", "qa"]);
  await api("PATCH", `/projects/${p.id}`, { settings: { parallelism: 1 } }); // the report story is tested before the seed story exists
  const report = story(p.id, "Report bookings", 1);
  const seed = story(p.id, "Seed bookings", 2);
  scripts["Report bookings"] = { qa: [{ blocked: { ac: "AC 1", waitsFor: seed.code } }, {}] };
  scripts["Seed bookings"] = {};

  await api("POST", `/projects/${p.id}/start`);
  await waitFor(() => [report, seed].every((s) => ["Release Ready", "Blocked"].includes(getItem(s.id)!.state)), "both stories to finish");
  assert.equal(getItem(seed.id)!.state, "Release Ready");
  assert.equal(getItem(report.id)!.state, "Release Ready", "tested again once the seed story was merged");
  assert.ok(getItem(report.id)!.depends_on.includes(seed.code), "the dependency QA found is recorded");
  assert.equal(runs.filter((r) => r === "qa:Report bookings").length, 2);
  const seedMerged = all<{ id: number }>("SELECT id FROM activity WHERE item_id = ? AND summary LIKE 'Merged %'", seed.id)[0].id;
  const resumed = all<{ id: number }>("SELECT id FROM activity WHERE item_id = ? AND summary LIKE '%resumes%'", report.id)[0]?.id;
  assert.ok(resumed && resumed > seedMerged, "it resumed after the seed story was merged");
});

test("⛔ untested ACs stop the release for your approval, even on autopilot", async () => {
  const p = await newProject("UNT", ["developer", "qa", "release"]);
  const s = story(p.id, "Export to PDF", 1);
  scripts["Export to PDF"] = { qa: [{ blocked: { ac: "AC 1" } }] };
  await api("POST", `/projects/${p.id}/start`);
  await waitFor(async () => (await api("GET", `/projects/${p.id}`)).stage === "approve_untested", "the untested-ACs gate");
  const at = await api("GET", `/projects/${p.id}`);
  assert.equal(at.status, "awaiting_approval");
  assert.deepEqual(at.untested.map((u: any) => [u.code, u.ac]), [[s.code, "AC 1"]]);
  assert.equal(getItem(s.id)!.state, "Release Ready", "not released before you approve");

  await api("POST", `/projects/${p.id}/approve`);
  await waitFor(() => getItem(s.id)!.state === "Deployed (Done)", "the release after approval");
  assert.equal((await api("GET", `/projects/${p.id}`)).stages.find((x: any) => x.key === "approve_untested").status, "done");
});

test("an AC met differently than written goes to the product owner, before QA and before approval", async () => {
  const p = await newProject("DEV", ["developer", "qa"]);
  const s = story(p.id, "Seed admin", 1);
  scripts["Seed admin"] = { dev: [{ deviation: "The admin password is documented in the README instead of seeded." }, {}], qa: [{ reinterpret: "AC 1 asks for a seeded password; a documented default is there." }, {}] };
  await api("POST", `/projects/${p.id}/start`);

  const openQuestions = () => all<{ id: number; question: string }>("SELECT id, question FROM questions WHERE item_id = ? AND (answer IS NULL OR answer = '')", s.id);
  const answer = (id: number) => run("UPDATE questions SET answer = 'Must be seeded as written.', answered_at = ? WHERE id = ?", now(), id);

  await waitFor(() => openQuestions().length === 1, "the developer's deviation to reach the product owner");
  assert.match(openQuestions()[0].question, /met differently than written.*README/);
  await waitFor(async () => !(await api("GET", `/projects/${p.id}`)).running, "the run to stop and wait");
  assert.ok(!runs.includes("qa:Seed admin"), "QA doesn't test it before the product owner decided");
  assert.notEqual(getItem(s.id)!.state, "Release Ready");

  answer(openQuestions()[0].id);
  await api("POST", `/projects/${p.id}/approve`).catch(() => undefined); // the undelivered-items gate: continue
  await waitFor(() => openQuestions().length === 1, "QA's reinterpretation to reach the product owner");
  assert.match(openQuestions()[0].question, /reading that differs from its wording/);
  assert.notEqual(getItem(s.id)!.state, "Release Ready", "QA can't approve a reinterpreted AC itself");

  answer(openQuestions()[0].id);
  await waitFor(async () => !(await api("GET", `/projects/${p.id}`)).running, "the run to stop again");
  await api("POST", `/projects/${p.id}/approve`).catch(() => undefined);
  await waitFor(() => getItem(s.id)!.state === "Release Ready", "the story to be approved once you decided");
});

test("the same AC failing QA twice in a row pauses the story with a question instead of more rounds", async () => {
  const p = await newProject("LOP", ["developer", "qa"]);
  await api("PATCH", `/projects/${p.id}`, { settings: { maxRework: 5 } });
  const s = story(p.id, "Waiting list", 1);
  scripts["Waiting list"] = { qa: [{ fail: "AC 1" }, { fail: "AC 1 — negative case" }, {}] };
  await api("POST", `/projects/${p.id}/start`);
  await waitFor(async () => !(await api("GET", `/projects/${p.id}`)).running, "the run to stop");
  assert.equal(runs.filter((r) => r === "qa:Waiting list").length, 2, "two QA rounds, not up to six");
  assert.equal(runs.filter((r) => r === "dev:Waiting list").length, 2);
  const q = all<{ question: string }>("SELECT question FROM questions WHERE item_id = ? AND answer IS NULL", s.id);
  assert.equal(q.length, 1);
  assert.match(q[0].question, /failed .* AC 1 in two rounds in a row/);
  assert.notEqual(getItem(s.id)!.state, "Blocked", "paused for a decision, not blocked");
});

/** An answered deviation question, as an earlier run of the story left it. */
function answeredDeviation(s: { id: string; code: string; project_id: string }, ac: string, answer: string) {
  const id = Number(insert("questions", { project_id: s.project_id, item_id: s.id, question: `${s.code} ${ac} is met differently than written: the export is deferred — is that acceptable, or must it be met as written?`, asked_by: "dev", created_at: now() }).lastInsertRowid);
  run("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?", answer, now(), id);
  return id;
}
const openOn = (itemId: string) => all<{ question: string }>("SELECT question FROM questions WHERE item_id = ? AND (answer IS NULL OR answer = '')", itemId);

test("re-running a story whose deviation the product owner accepted asks nothing and goes on to QA, which is told not to fail it", async () => {
  const p = await newProject("ACC", ["developer", "qa"]);
  const s = story(p.id, "Export bookings", 1);
  const accepted = answeredDeviation(s, "AC1", "Accepted — deferred to the next release.");
  scripts["Export bookings"] = { dev: [{ deviation: "The export is deferred to the next release.", ac: "AC 1" }] };

  await api("POST", `/projects/${p.id}/start`);
  await waitFor(async () => !(await api("GET", `/projects/${p.id}`)).running, "the run to finish");
  assert.deepEqual(openOn(s.id), [], "no new question");
  assert.equal(getItem(s.id)!.state, "Release Ready", "not parked");
  assert.ok(all("SELECT 1 FROM activity WHERE item_id = ? AND summary = ?", s.id, `✓ ${s.code} AC 1: already accepted by the product owner (question #${accepted})`).length);
  assert.match(qaTasks["Export bookings"], /## ACs the product owner accepted as met differently or deferred — do not fail these; record them as accepted, citing the question number\n- AC 1 — question #\d+: Accepted/);
});

test("a deviation on another AC, or one the product owner wanted met as written, is still asked", async () => {
  const p = await newProject("ASK", ["developer", "qa"]);
  await api("PATCH", `/projects/${p.id}`, { settings: { parallelism: 1 } }); // one developer script at a time
  const other = story(p.id, "Cancel bookings", 1);
  const written = story(p.id, "Remind bookings", 2);
  answeredDeviation(other, "AC 1", "Accepted.");
  answeredDeviation(written, "AC 1", "Must be met as written.");
  scripts["Cancel bookings"] = { dev: [{ deviation: "Cancelling is by e-mail.", ac: "AC 2" }] };
  scripts["Remind bookings"] = { dev: [{ deviation: "Reminders are manual.", ac: "AC 1" }] };

  await api("POST", `/projects/${p.id}/start`);
  await waitFor(async () => !(await api("GET", `/projects/${p.id}`)).running, "the run to stop and wait");
  assert.match(openOn(other.id).map((q) => q.question).join("\n"), new RegExp(`^${other.code} AC 2 is met differently than written`));
  assert.match(openOn(written.id).map((q) => q.question).join("\n"), new RegExp(`^${written.code} AC 1 is met differently than written`));
  assert.ok(!runs.includes("qa:Cancel bookings") && !runs.includes("qa:Remind bookings"), "both wait for the product owner before QA");
});

test("a second re-run click while the first runs is refused, and the feedback is stored once", async () => {
  const p = await newProject("RRN", ["developer", "qa"]);
  const s = story(p.id, "Rerun once", 1);
  let release!: () => void;
  hold = new Promise((r) => (release = r));
  try {
    await api("POST", `/items/${s.id}/rerun`, { role: "developer", feedback: "Use the new colours." });
    await assert.rejects(api("POST", `/items/${s.id}/rerun`, { role: "developer", feedback: "Use the new colours." }), /409.*already running/);
    assert.equal(all("SELECT 1 FROM comments WHERE item_id = ? AND content LIKE 'Feedback for %'", s.id).length, 1);
    assert.equal(all("SELECT 1 FROM messages WHERE item_id = ? AND kind = 'rework' AND from_agent_id = 'human'", s.id).length, 1);
  } finally {
    hold = null;
    release();
  }
  await waitFor(async () => !(await api("GET", `/projects/${p.id}`)).running, "the re-run to finish");
});
