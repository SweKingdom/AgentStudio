// Fewer questions: the same question asked again is answered from the earlier answer, or shares the open one.
import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const { similarity, askOnce, SIMILAR } = await import("../src/questions.ts");
const { createItem, openQuestionCount, answeredQuestions } = await import("../src/store.ts");
const { insert, now, run, all } = await import("../src/db.ts");

test("similar questions are found by the words they share, not by exact wording", () => {
  const a = "Which time zone should booking times be shown in?";
  assert.ok(similarity(a, "What time zone are the booking times shown in?") >= SIMILAR);
  assert.ok(similarity(a, "Should bookings show times in the club's time zone?") >= SIMILAR);
  assert.ok(similarity(a, "Who may cancel a class?") < SIMILAR);
  assert.ok(similarity("Which payment provider do we use?", "Which payment provider should refunds go through, and within how many days?") < 0.9);
  assert.equal(similarity("ok", "ok"), 0, "too short to compare");
});

function project(key: string) {
  const ts = now();
  insert("projects", { id: `prj_${key}`, key, name: key, status: "ready", mode: "simulation", created_at: ts, updated_at: ts, settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1 } });
  return `prj_${key}`;
}

test("an answered question is reused; an open one is shared by the next story that asks it", () => {
  const pid = project("QDD");
  const a = createItem(pid, { type: "story", title: "Book a class" });
  const b = createItem(pid, { type: "story", title: "Cancel a booking" });
  const c = createItem(pid, { type: "story", title: "Weekly report" });

  const first = askOnce(pid, "Which time zone should booking times be shown in?", a.id, "agt_requirements");
  assert.equal(first.kind, "new");
  const again = askOnce(pid, "What time zone are the booking times shown in?", b.id, "agt_architect");
  assert.equal(again.kind, "open");
  assert.equal(openQuestionCount(b.id), 1, "the second story waits for the same answer");
  assert.equal(all("SELECT 1 FROM questions WHERE project_id = ?", pid).length, 1, "no duplicate was created");

  run("UPDATE questions SET answer = 'Europe/Stockholm', reasoning = 'All clubs are in Sweden.', answered_at = ? WHERE id = ?", now(), first.id);
  assert.equal(openQuestionCount(b.id), 0);
  const reused = askOnce(pid, "Booking times: which time zone?", c.id, "agt_developer");
  assert.equal(reused.kind, "answered");
  assert.equal(reused.kind === "answered" && reused.answer, "Europe/Stockholm — Reasoning: All clubs are in Sweden.");
  assert.equal(openQuestionCount(c.id), 0, "nothing new to wait for");
  assert.deepEqual(answeredQuestions(pid)[0].items.sort(), [a.id, b.id].sort(), "the answer belongs to both stories that asked");

  assert.equal(askOnce(pid, "Who may cancel a class — instructors, managers or both?", a.id, "agt_requirements").kind, "new");
});
