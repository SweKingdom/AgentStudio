// Measured time and spend (timing.ts): what the agents actually did, what waited on whom, and what became of the money.
import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const { projectTime, projectSpend, itemSpend } = await import("../src/timing.ts");
const { createItem, getProject, patchItem, patchProject } = await import("../src/store.ts");
const { all, insert, keepRunTimeOnMainModel, now, setSetting } = await import("../src/db.ts");

const T0 = Date.parse("2026-11-01T08:00:00.000Z");
const at = (h: number) => new Date(T0 + h * 3_600_000).toISOString();

function project(key: string, hours = 10) {
  insert("projects", { id: `prj_${key}`, key, name: key, status: "completed", mode: "live", created_at: at(0), updated_at: at(0), started_at: at(0), finished_at: at(hours), settings: { gates: true, parallelism: 2, budgetUsd: 0, maxRework: 2 } });
  return `prj_${key}`;
}
let runN = 0;
function runOf(pid: string, o: { from: number; to: number; item?: string; stage?: string; kind?: string; attempt?: number | null; iteration?: number | null; cost?: number }) {
  const id = `run_${++runN}`;
  insert("runs", { id, project_id: pid, agent_id: "agt_dev", stage: o.stage ?? "development", item_id: o.item ?? null, status: "done", kind: o.kind ?? "pipeline", attempt: o.attempt ?? null, iteration: o.iteration ?? null, started_at: at(o.from), ended_at: at(o.to) });
  insert("llm_calls", { run_id: id, project_id: pid, agent_id: "agt_dev", item_id: o.item ?? null, stage: o.stage ?? "development", model: "claude-sonnet-5-5", cost_usd: o.cost ?? 0, duration_ms: (o.to - o.from) * 3_600_000, created_at: at(o.from) });
  return id;
}

test("elapsed time splits into working, waiting for you, limits, paused and other, each moment counted once", () => {
  const pid = project("TIM");
  runOf(pid, { from: 0, to: 2 });
  runOf(pid, { from: 1, to: 3 }); // a second lane overlapping the first: wall clock counts once
  insert("project_waits", { project_id: pid, kind: "you", started_at: at(3), ended_at: at(5) });
  insert("project_waits", { project_id: pid, kind: "limit", started_at: at(5), ended_at: at(7) });
  insert("project_waits", { project_id: pid, kind: "paused", started_at: at(8), ended_at: at(9) });
  // An open question while an agent works doesn't count as waiting; only the part when nothing runs does.
  insert("questions", { project_id: pid, item_id: null, question: "Which currency?", created_at: at(2.5), answered_at: at(3.5), asked_by: "agt_dev" });
  const t = projectTime(pid);
  const h = (s: number) => s / 3600;
  assert.equal(h(t.elapsedSeconds), 10);
  assert.equal(h(t.workingSeconds), 3, "0–3 h, lanes merged");
  assert.equal(h(t.agentSeconds), 4, "2 h + 2 h across the two lanes");
  assert.equal(h(t.waitingForYouSeconds), 2, "3–5 h (the question overlaps it)");
  assert.equal(h(t.limitSeconds), 2);
  assert.equal(h(t.pausedSeconds), 1);
  assert.equal(h(t.otherSeconds), 2, "7–8 h and 9–10 h");
  assert.equal(t.limitPauses, 1);
  assert.equal(t.workingSeconds + t.waitingForYouSeconds + t.limitSeconds + t.pausedSeconds + t.otherSeconds, t.elapsedSeconds);
});

test("a status change records the wait it starts: an approval gate, a limit pause or a pause by hand", () => {
  const pid = project("WAI");
  patchProject(pid, { status: "running" });
  patchProject(pid, { status: "awaiting_approval" });
  patchProject(pid, { status: "running" });
  setSetting("globalPause", { kind: "tokens", reason: "5-hour limit", since: now(), resumeAt: null, projects: [pid], jobs: [] });
  patchProject(pid, { status: "paused", error: "5-hour limit" });
  setSetting("globalPause", null);
  patchProject(pid, { status: "running" });
  patchProject(pid, { status: "paused", error: null });
  const waits = all<{ kind: string; ended_at: string | null }>("SELECT kind, ended_at FROM project_waits WHERE project_id = ? ORDER BY id", pid);
  assert.deepEqual(waits.map((w) => w.kind), ["you", "limit", "paused"]);
  assert.ok(waits[0].ended_at && waits[1].ended_at, "a wait ends when the status changes again");
  assert.equal(waits[2].ended_at, null, "the current pause is still open");
  patchProject(pid, { status: "paused", error: null });
  assert.equal(all("SELECT 1 FROM project_waits WHERE project_id = ?", pid).length, 3, "the same status again isn't a new wait");
  assert.ok(getProject(pid));
});

test("spend splits by what became of the work, and rework is only rounds after a story was sent back", () => {
  const pid = project("SPD");
  const done = createItem(pid, { type: "story", title: "Book a class", story_points: 3 });
  const wip = createItem(pid, { type: "story", title: "Cancel a class", story_points: 2 });
  const stopped = createItem(pid, { type: "story", title: "Import members", story_points: 5 });
  patchItem(done.id, { state: "Deployed (Done)", rework_count: 1 });
  patchItem(wip.id, { state: "In Progress" });
  patchItem(stopped.id, { state: "Blocked" });
  runOf(pid, { from: 0, to: 1, stage: "requirements", cost: 1 });
  runOf(pid, { from: 1, to: 2, item: done.id, attempt: 1, iteration: 1, cost: 2 });
  runOf(pid, { from: 2, to: 3, item: done.id, stage: "qa", attempt: 1, iteration: 1, cost: 0.5 });
  runOf(pid, { from: 3, to: 4, item: done.id, attempt: 2, iteration: 2, cost: 1.5 }); // QA sent it back
  runOf(pid, { from: 4, to: 5, item: done.id, kind: "fix", attempt: null, iteration: 3, cost: 0.25 }); // a merge fix, not rework
  runOf(pid, { from: 1, to: 2, item: wip.id, attempt: 1, iteration: 1, cost: 1 });
  runOf(pid, { from: 3, to: 4, item: wip.id, attempt: 1, iteration: 2, cost: 1 }); // resumed after an answer: not rework
  runOf(pid, { from: 1, to: 2, item: stopped.id, attempt: 1, iteration: 1, cost: 3 });
  const s = projectSpend(pid);
  assert.equal(s.totalUsd, 10.25);
  assert.equal(s.projectWideUsd, 1);
  assert.equal(s.deliveredUsd, 4.25);
  assert.equal(s.inProgressUsd, 2);
  assert.equal(s.stoppedUsd, 3);
  assert.equal(s.reworkUsd, 1.5);
  assert.deepEqual(itemSpend(done.id), { totalUsd: 4.25, reworkUsd: 1.5 });
  assert.deepEqual(itemSpend(wip.id), { totalUsd: 2, reworkUsd: 0 });
});

test("runs from before the attempt was recorded count as rework only for items that were sent back", () => {
  const pid = project("LEG");
  const sent = createItem(pid, { type: "story", title: "Search" });
  const resumed = createItem(pid, { type: "story", title: "Export" });
  patchItem(sent.id, { state: "Release Ready", rework_count: 1 });
  patchItem(resumed.id, { state: "Release Ready", rework_count: 0 });
  for (const it of [sent, resumed]) {
    insert("item_phases", { project_id: pid, item_id: it.id, phase: "development", iteration: 1, started_at: at(0), ended_at: at(1) });
    insert("item_phases", { project_id: pid, item_id: it.id, phase: "development", iteration: 2, started_at: at(2), ended_at: at(3) });
    runOf(pid, { from: 0, to: 1, item: it.id, cost: 1 });
    runOf(pid, { from: 2, to: 3, item: it.id, cost: 2 });
  }
  assert.equal(itemSpend(sent.id).reworkUsd, 2);
  assert.equal(itemSpend(resumed.id).reworkUsd, 0, "a second round without being sent back: a resume, not rework");
});

test("a run's time stays on its main model: the plan backend's per-model copies are cleared", () => {
  const pid = project("DUR");
  const id = runOf(pid, { from: 0, to: 1, cost: 2 });
  insert("llm_calls", { run_id: id, project_id: pid, agent_id: "agt_dev", stage: "development", model: "claude-haiku-5-5", cost_usd: 0.01, duration_ms: 3_600_000, created_at: at(0) });
  keepRunTimeOnMainModel();
  const rows = all<{ model: string; duration_ms: number }>("SELECT model, duration_ms FROM llm_calls WHERE run_id = ? ORDER BY id", id);
  assert.deepEqual(rows.map((r) => [r.model, r.duration_ms]), [["claude-sonnet-5-5", 3_600_000], ["claude-haiku-5-5", 0]]);
  keepRunTimeOnMainModel();
  assert.equal(all<{ ms: number }>("SELECT SUM(duration_ms) ms FROM llm_calls WHERE run_id = ?", id)[0].ms, 3_600_000, "running it again changes nothing");
});
