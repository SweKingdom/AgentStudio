// The product owner's answers: agents see the newest first, a deviation they accepted isn't asked again, and the
// changelog only grows.
import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const { executeTool } = await import("../src/agents/tools.ts");
const { defaultAgentFor } = await import("../src/agents/store.ts");
const { itemCard } = await import("../src/agents/context.ts");
const { acceptedAnswers, priorAcDecision, rejectsDeviation } = await import("../src/questions.ts");
const { addQuestion, createItem, findDoc, upsertDoc } = await import("../src/store.ts");
const { get, insert, now, run } = await import("../src/db.ts");

function project(key: string) {
  const ts = now();
  const settings = { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1, repo: null };
  insert("projects", { id: `prj_${key}`, key, name: key, status: "ready", mode: "simulation", created_at: ts, updated_at: ts, settings });
  return { id: `prj_${key}`, key, name: key, mode: "simulation", settings } as any;
}
const answer = (id: number, text: string, at: string) => run("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?", text, at, id);

test("the story card lists the product owner's answers newest first, with their dates, under a heading that says so", () => {
  const p = project("ANS");
  const s = createItem(p.id, { type: "story", title: "Book a slot", state: "To Do" });
  const older = addQuestion(p.id, "How long is a slot?", s.id, "analyst");
  const newer = addQuestion(p.id, "How long is a slot, really?", s.id, "analyst");
  // Answered out of order: the newer answer is on the older question.
  answer(newer, "30 minutes.", "2026-10-01T09:00:00.000Z");
  answer(older, "45 minutes.", "2026-10-02T09:00:00.000Z");
  const card = itemCard(s);
  assert.match(card, /### Answers from the product owner \(newest first — a newer answer on the same topic replaces older ones; follow the newest\)/);
  assert.ok(card.indexOf("45 minutes.") < card.indexOf("30 minutes."), "newest first");
  assert.match(card, new RegExp(`#${older}, answered 2026-10-02 09:00`));
});

test("a deviation the product owner accepted is found for the same AC only — and only when the newest answer accepts it", () => {
  const p = project("PAD");
  const s = createItem(p.id, { type: "story", title: "Seed admin", state: "To Do" });
  const q1 = addQuestion(p.id, `${s.code} AC 1 is met differently than written: documented, not seeded — is that acceptable, or must it be met as written?`, s.id, "dev");
  answer(q1, "Accepted — deferred to the next release.", "2026-10-01T09:00:00.000Z");
  const q2 = addQuestion(p.id, `${s.code} AC 1-4 is met differently than written: x — is that acceptable, or must it be met as written?`, s.id, "dev");
  answer(q2, "Must be met as written.", "2026-10-01T09:00:00.000Z");

  assert.equal(priorAcDecision(p.id, s.id, s.code, "AC1")?.id, q1, '"AC 1" = "AC1"');
  assert.equal(priorAcDecision(p.id, s.id, s.code, "ac 1")?.accepted, true);
  assert.equal(priorAcDecision(p.id, s.id, s.code, "AC 1-4")?.accepted, false, "AC 1-4 matches only AC 1-4");
  assert.equal(priorAcDecision(p.id, s.id, s.code, "AC 2"), undefined);
  answer(addQuestion(p.id, "Should the export be CSV?", s.id, "analyst"), "Yes.", "2026-10-01T10:00:00.000Z");
  assert.deepEqual(acceptedAnswers(p.id, s.id, s.code).map((q) => q.id), [q1], "what QA is told it may not fail: AC answers only");

  // QA's reinterpretation of AC 1, answered later, overrules the earlier acceptance.
  const q3 = addQuestion(p.id, `QA would approve ${s.code} AC 1 only on a reading that differs from its wording: y — do you accept that, or must it be met as written?`, s.id, "qa");
  answer(q3, "No — it must be seeded.", "2026-10-03T09:00:00.000Z");
  assert.deepEqual([priorAcDecision(p.id, s.id, s.code, "AC 1")?.id, priorAcDecision(p.id, s.id, s.code, "AC 1")?.accepted], [q3, false]);

  // Only a clear "no" is asked again; a short decision without the word "accept" is a decision (real answers).
  const decided = [
    "Accepted",
    "Yes, fine",
    "deferred to the first real docker compose up.",
    "the config checks are enough until that first run",
    "belongs to US-130.",
    "Move AC 5 out of US-127 and into US-130, the story that adds the seed data.",
    "render-realms.mjs with .sh and .ps1 wrappers, not added to scripts/check.",
    "No problem, keep it like that.",
  ];
  for (const a of decided) assert.ok(!rejectsDeviation(a), a);
  for (const a of ["Must be met as written", "Meet it as written.", "Not accepted — fix it", "It isn't acceptable", "Rejected.", "No", "No, seed it."]) assert.ok(rejectsDeviation(a), a);
});

test("a deviation answered with a short decision isn't asked again; one answered with a clear no is", () => {
  const p = project("DEC");
  const s = createItem(p.id, { type: "story", title: "Compose up", state: "To Do" });
  const ask = (ac: string, a: string) => {
    const id = addQuestion(p.id, `${s.code} ${ac} is met differently than written: x — is that acceptable, or must it be met as written?`, s.id, "dev");
    answer(id, a, now());
    return id;
  };
  const deferred = ask("AC 1", "deferred to the first real docker compose up.");
  ask("AC 2", "Not accepted — fix it");
  const moved = ask("AC 5", "belongs to US-130.");
  assert.equal(priorAcDecision(p.id, s.id, s.code, "AC 1")?.accepted, true);
  assert.equal(priorAcDecision(p.id, s.id, s.code, "AC 2")?.accepted, false);
  assert.equal(priorAcDecision(p.id, s.id, s.code, "AC5")?.accepted, true);
  assert.deepEqual(acceptedAnswers(p.id, s.id, s.code).map((q) => q.id).sort(), [deferred, moved].sort(), "QA is told not to fail AC 1 and AC 5");
});

test("a changelog write that drops an existing entry is refused, naming it; one that adds a line is saved", async () => {
  const p = project("CHL");
  const writer = { ...defaultAgentFor("writer"), tools: ["write_document", "update_document_section"] };
  const ctx = { project: p, agent: writer, runId: "run_chl", iteration: 1, outcome: {} } as any;
  upsertDoc({ projectId: p.id, kind: "changelog", itemId: null, title: "Changelog", content: "# Changelog\n\n## Unreleased\n\n- CHL-1 Book a slot\n", agentId: writer.id });

  const dropped = await executeTool("update_document_section", { kind: "changelog", heading: "Unreleased", content: "- CHL-2 Cancel a slot" }, ctx);
  assert.equal(dropped.ok, false);
  assert.match(dropped.content, /- CHL-1 Book a slot/, "the error names the missing line");
  const replaced = await executeTool("write_document", { kind: "changelog", title: "Changelog", content: "# Changelog\n\n## Unreleased\n\n- CHL-2 Cancel a slot\n" }, ctx);
  assert.equal(replaced.ok, false);
  assert.match(findDoc(p.id, "changelog", null)!.content, /CHL-1/, "nothing was saved");

  const added = await executeTool("update_document_section", { kind: "changelog", heading: "Unreleased", content: "- CHL-1 Book a slot\n- CHL-2 Cancel a slot" }, ctx);
  assert.equal(added.ok, true, added.content);
  const whole = await executeTool("write_document", { kind: "changelog", title: "Changelog", content: `${findDoc(p.id, "changelog", null)!.content}- CHL-3 Remind me\n` }, ctx);
  assert.equal(whole.ok, true, whole.content);
  assert.match(findDoc(p.id, "changelog", null)!.content, /CHL-1[\s\S]*CHL-2[\s\S]*CHL-3/);
});

test("the one-off script answers open deviation questions the product owner already accepted, citing the earlier one", () => {
  const p = project("FIX");
  const s = createItem(p.id, { type: "story", title: "Export", state: "In Peer Testing" });
  const ask = (ac: string) => addQuestion(p.id, `${s.code} ${ac} is met differently than written: deferred — is that acceptable, or must it be met as written?`, s.id, "dev");
  const accepted = ask("AC 1");
  answer(accepted, "Accepted.", "2026-10-01T09:00:00.000Z");
  const repeat = ask("AC1");
  const other = ask("AC 2");
  const script = path.resolve(import.meta.dirname, "../scripts/resolve-accepted.ts");
  const runScript = (...args: string[]) => execFileSync(process.execPath, ["--no-warnings", "--import", "tsx", script, ...args], { env: process.env, encoding: "utf8" });
  const answerOf = (id: number) => get<{ answer: string | null }>("SELECT answer FROM questions WHERE id = ?", id)!.answer;

  assert.match(runScript("--dry-run"), /1 question\(s\) would be answered/);
  assert.equal(answerOf(repeat), null, "a dry run saves nothing");
  runScript();
  assert.match(answerOf(repeat)!, new RegExp(`^Accepted — already accepted by the product owner in question #${accepted}`));
  assert.equal(answerOf(other), null, "another AC stays open");
});
