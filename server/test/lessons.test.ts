// Lessons learned: what earlier stories in a project were sent back for, kept as a short per-project document.
import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const { parseLessons, renderLessons, capLessons, lessonsProblem, lessonsEnabled, MAX_LESSONS } = await import("../src/lessons.ts");

test("parseLessons and renderLessons round-trip text and tags", () => {
  const md = [
    "- Dates in API responses are ISO 8601 strings; format them with `src/utils/date.ts`. (US-121, qa)",
    "- Seed data must be idempotent: running the seed twice must not duplicate rows. (US-140, checks)",
    "- Validation errors return 400 with `{ error, field }`, never 500. (product owner)",
  ].join("\n");
  const lessons = parseLessons(md);
  assert.deepEqual(lessons.map((l) => [l.source, l.manual]), [["US-121, qa", false], ["US-140, checks", false], ["product owner", true]]);
  assert.equal(lessons[0].text, "Dates in API responses are ISO 8601 strings; format them with `src/utils/date.ts`.");
  assert.equal(renderLessons(lessons), md);
});

test("a hand-written line without a tag survives as a manual lesson", () => {
  const lessons = parseLessons("Always run the migrations before the seed\n\n* Use pnpm, not npm (TK-7, review)");
  assert.deepEqual(lessons[0], { text: "Always run the migrations before the seed", source: "", manual: true });
  assert.deepEqual(lessons[1], { text: "Use pnpm, not npm", source: "TK-7, review", manual: false });
  assert.equal(renderLessons(lessons), "- Always run the migrations before the seed\n- Use pnpm, not npm (TK-7, review)");
});

test("the 21st lesson drops the oldest automatic one; the product owner's stay", () => {
  const owner = { text: "Owner rule", source: "product owner", manual: true };
  const auto = Array.from({ length: MAX_LESSONS }, (_, i) => ({ text: `Rule ${i}`, source: `US-${i}, qa`, manual: false }));
  const capped = capLessons([owner, ...auto]);
  assert.equal(capped.length, MAX_LESSONS);
  assert.equal(capped[0], owner);
  assert.ok(!capped.some((l) => l.text === "Rule 0"));
  assert.ok(capped.some((l) => l.text === `Rule ${MAX_LESSONS - 1}`));
});

test("lessonsProblem rejects too many or too long lessons instead of truncating", () => {
  assert.equal(lessonsProblem(parseLessons("- short (product owner)")), null);
  assert.match(lessonsProblem([{ text: "x".repeat(201), source: "", manual: true }])!, /at most 200 characters/);
  assert.match(lessonsProblem(Array.from({ length: 21 }, () => ({ text: "a", source: "", manual: true })))!, /At most 20 lessons/);
});

test("lessons are on unless the project turns them off", () => {
  assert.equal(lessonsEnabled({ settings: {} as any }), true);
  assert.equal(lessonsEnabled({ settings: { lessons: false } as any }), false);
});
