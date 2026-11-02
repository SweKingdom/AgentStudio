// The cost guard and the repeated-failure check, on recorded data.
import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const { costGuard, repeatedQaFailures, stageEstimateUsd, storyEstimateUsd } = await import("../src/orchestrator.ts");
const { createItem } = await import("../src/store.ts");
const { all, insert, now } = await import("../src/db.ts");

function project(key: string, estimate: unknown) {
  const ts = now();
  insert("projects", { id: `prj_${key}`, key, name: key, status: "ready", mode: "live", created_at: ts, updated_at: ts, settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1 }, estimate });
  return `prj_${key}`;
}
const qa = (pid: string, itemId: string, iteration: number, ac: string, result: string) =>
  insert("test_results", { project_id: pid, item_id: itemId, kind: "qa", ac_ref: ac, result, notes: "", iteration, agent_id: "agt_qa", created_at: now() });

test("repeated failures: the same AC (whatever its suffix) failed in the last two QA rounds", () => {
  const pid = project("RPT", null);
  const it = createItem(pid, { type: "story", title: "Cancel" });
  qa(pid, it.id, 1, "AC 1", "fail");
  assert.deepEqual(repeatedQaFailures(it.id), [], "one round isn't a pattern");
  qa(pid, it.id, 2, "AC 2", "fail");
  qa(pid, it.id, 2, "AC 1", "pass");
  assert.deepEqual(repeatedQaFailures(it.id), []);
  qa(pid, it.id, 3, "AC 2 — negative", "fail");
  assert.deepEqual(repeatedQaFailures(it.id), ["AC 2"]);
});

test("the cost guard alerts once when a story costs more than twice its share of the estimate", () => {
  const pid = project("CST", { storyPoints: 10, agents: [{ role: "developer", costUsd: 6 }, { role: "qa", costUsd: 3 }, { role: "writer", costUsd: 1 }, { role: "requirements", costUsd: 50 }] });
  const it = createItem(pid, { type: "story", title: "Book", story_points: 2 });
  assert.equal(storyEstimateUsd(pid, it.id), 2, "(6 + 3 + 1) × 2 / 10 — not the backlog work");
  const call = (cost: number) => insert("llm_calls", { project_id: pid, agent_id: "agt_developer", item_id: it.id, stage: "development", model: "claude-sonnet-5-5", cost_usd: cost, created_at: now() });
  call(3.5);
  costGuard(pid, it.id);
  assert.equal(all("SELECT 1 FROM activity WHERE item_id = ? AND type = 'cost'", it.id).length, 0, "under twice the estimate");
  call(1);
  costGuard(pid, it.id);
  costGuard(pid, it.id);
  const alerts = all<{ summary: string }>("SELECT summary FROM activity WHERE item_id = ? AND type = 'cost'", it.id);
  assert.equal(alerts.length, 1, "alerted once");
  assert.match(alerts[0].summary, /\$4\.50, more than twice its estimate \(\$2\.00\)/);
  assert.equal(storyEstimateUsd(project("NOE", null), it.id), null, "no estimate, no guard");
});

test("a stage's estimate: its agents' share; delivery counts only the stories not delivered yet", () => {
  const pid = project("STG", { storyPoints: 10, agents: [{ role: "developer", costUsd: 6 }, { role: "qa", costUsd: 3 }, { role: "writer", costUsd: 1 }, { role: "requirements", costUsd: 4 }] });
  createItem(pid, { type: "story", title: "Done one", story_points: 5, state: "Deployed (Done)" });
  createItem(pid, { type: "story", title: "Left one", story_points: 5, state: "To Do" });
  assert.equal(stageEstimateUsd(pid, "requirements"), 4);
  assert.equal(stageEstimateUsd(pid, "delivery"), 5, "half the points are left: half of $10");
  assert.equal(stageEstimateUsd(pid, "approve_plan"), null);
});
