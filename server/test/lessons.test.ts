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

const { contextFor } = await import("../src/agents/context.ts");
const { defaultAgentFor } = await import("../src/agents/store.ts");
const { findDoc, getProject, upsertDoc } = await import("../src/store.ts");
const { insert, now } = await import("../src/db.ts");

function project(key: string, settings: Record<string, unknown> = {}) {
  const ts = now();
  insert("projects", { id: `prj_${key}`, key, name: key, status: "ready", mode: "simulation", created_at: ts, updated_at: ts, settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1, ...settings } });
  return getProject(`prj_${key}`)!;
}

test("contextFor puts the lessons in front of the developer, QA and architect only", () => {
  const p = project("CTX");
  const roles = ["developer", "qa", "architect", "planner", "writer", "release", "requirements"] as const;
  const shared = (role: (typeof roles)[number]) => contextFor(getProject(p.id)!, defaultAgentFor(role)).shared;
  assert.ok(roles.every((r) => !shared(r).includes("Lessons from earlier stories")), "no lessons yet, no block");
  upsertDoc({ projectId: p.id, kind: "project_lessons", itemId: null, title: "Lessons learned", content: "- Seed data must be idempotent. (US-140, checks)", agentId: null });
  for (const role of roles) {
    const s = shared(role);
    if (["developer", "qa", "architect"].includes(role)) {
      assert.match(s, /## Lessons from earlier stories in this project \(follow them\)\n- Seed data must be idempotent\.$/m, role);
      assert.doesNotMatch(s, /US-140/, "agents get the rule, not its history");
    } else assert.doesNotMatch(s, /Lessons from earlier stories/, role);
  }
  const off = project("OFF", { lessons: false });
  upsertDoc({ projectId: off.id, kind: "project_lessons", itemId: null, title: "Lessons learned", content: "- Rule (product owner)", agentId: null });
  assert.doesNotMatch(contextFor(off, defaultAgentFor("developer")).shared, /Lessons from earlier stories/, "turned off: no block");
});

test("PUT /projects/:id/lessons saves a valid edit with an audit row, and rejects a line over 200 characters", async () => {
  const { createApp } = await import("../src/app.ts");
  const { all } = await import("../src/db.ts");
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api`;
  const put = (pid: string, content: string) => fetch(`${base}/projects/${pid}/lessons`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
  try {
    const p = project("PUT");
    const ok = await put(p.key, "- Use ISO dates (US-1, qa)\nValidation errors return 400 (product owner)");
    assert.equal(ok.status, 200);
    const doc = await ok.json();
    assert.equal(doc.kind, "project_lessons");
    assert.equal(doc.content, "- Use ISO dates (US-1, qa)\n- Validation errors return 400 (product owner)");
    assert.equal(all("SELECT 1 FROM audit WHERE action = 'project.lessons' AND target = ?", p.id).length, 1);
    const long = await put(p.id, `- ${"x".repeat(201)} (product owner)`);
    assert.equal(long.status, 400);
    assert.match((await long.json()).error, /at most 200 characters/);
    assert.equal(findDoc(p.id, "project_lessons", null)!.version, 1, "the rejected edit wasn't saved");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- captureLessons, live, with a scripted model

process.env.ANTHROPIC_API_KEY ??= "test-key-never-sent";
const { captureLessons } = await import("../src/lessons.ts");
const { setAnthropicClientForTests } = await import("../src/agents/runner.ts");
const { saveAppSettings } = await import("../src/settings.ts");
const { createItem } = await import("../src/store.ts");
const { all } = await import("../src/db.ts");

/** The scripted model: each call takes the next answer (a string, or an Error to throw). */
const answers: (string | Error)[] = [];
const prompts: string[] = [];
setAnthropicClientForTests({
  messages: {
    create: async (params: any) => {
      prompts.push(params.messages[0].content);
      const a = answers.shift() ?? '{"lessons": []}';
      if (a instanceof Error) throw a;
      return { model: "claude-opus-5-5", content: [{ type: "text", text: a }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    },
  },
});

function liveStory(key: string, settings: Record<string, unknown> = {}) {
  saveAppSettings({ mode: "live", backend: "api" });
  const ts = now();
  insert("projects", { id: `prj_${key}`, key, name: key, status: "ready", mode: "live", created_at: ts, updated_at: ts, settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1, ...settings } });
  const p = getProject(`prj_${key}`)!;
  return { p, item: createItem(p.id, { type: "story", title: "Create a task" }) };
}
const qaAgent = defaultAgentFor("qa");
const qaRejection = [{ from: "qa" as const, findings: "❌ POST /tasks returns 500 on a missing title instead of 400." }];
const calls = (pid: string) => all<{ stage: string }>("SELECT stage FROM llm_calls WHERE project_id = ?", pid);

test("no rework: no distilling call and no lessons document", async () => {
  const { p, item } = liveStory("NOREW");
  assert.deepEqual(await captureLessons({ project: p, item, reworkLog: [], fix: "", agent: qaAgent }), []);
  assert.equal(calls(p.id).length, 0);
  assert.equal(findDoc(p.id, "project_lessons", null), undefined);
});

test("live: one call recorded under stage lessons; both lessons saved, tagged, and commented on the story", async () => {
  const { p, item } = liveStory("LIVE");
  answers.push('Sure.\n{"lessons": ["Validation errors return 400 with { error, field }, never 500.", "Cover each required field with a test for its missing case."]}');
  const added = await captureLessons({ project: p, item, reworkLog: qaRejection, fix: "Added validation.", agent: qaAgent });
  assert.equal(added.length, 2);
  assert.deepEqual(calls(p.id).map((c) => c.stage), ["lessons"]);
  assert.match(prompts.at(-1)!, /needed 1 rework round\(s\)[\s\S]*### From qa\n❌ POST \/tasks[\s\S]*Added validation\.[\s\S]*\(none\)/);
  const lessons = parseLessons(findDoc(p.id, "project_lessons", null)!.content);
  assert.deepEqual(lessons.map((l) => l.source), [`${item.code}, qa`, `${item.code}, qa`]);
  const comments = all<{ content: string }>("SELECT content FROM comments WHERE item_id = ?", item.id);
  assert.equal(comments.filter((c) => c.content.startsWith("📝 Lesson added: ")).length, 2);
});

test("live: a lesson that repeats an existing one in other words, or names this story, is dropped", async () => {
  const { p, item } = liveStory("DUP");
  upsertDoc({ projectId: p.id, kind: "project_lessons", itemId: null, title: "Lessons learned", content: "- Validation errors return 400 with { error, field }, never 500. (product owner)", agentId: null });
  answers.push(`{"lessons": ["Validation errors must return 400 with { error, field } and never 500.", "Fix ${item.code} first."]}`);
  assert.deepEqual(await captureLessons({ project: p, item, reworkLog: qaRejection, fix: "", agent: qaAgent }), []);
  assert.equal(findDoc(p.id, "project_lessons", null)!.version, 1, "nothing new, nothing saved");
});

test("live: an answer that isn't JSON, or a call that throws, leaves the document unchanged", async () => {
  const { p, item } = liveStory("BAD");
  upsertDoc({ projectId: p.id, kind: "project_lessons", itemId: null, title: "Lessons learned", content: "- Rule (product owner)", agentId: null });
  answers.push("I think the developer should be more careful.");
  await assert.rejects(captureLessons({ project: p, item, reworkLog: qaRejection, fix: "", agent: qaAgent }), /wasn't \{"lessons"/);
  answers.push(new Error("overloaded"));
  await assert.rejects(captureLessons({ project: p, item, reworkLog: qaRejection, fix: "", agent: qaAgent }), /overloaded/);
  assert.equal(findDoc(p.id, "project_lessons", null)!.version, 1);
  assert.equal(all("SELECT 1 FROM comments WHERE item_id = ?", item.id).length, 0);
});

test("live: a secret in a lesson is masked when the document is saved", async () => {
  const { p, item } = liveStory("SECRET");
  const key = `sk-ant-${"a1B2c3D4e5".repeat(3)}`;
  answers.push(JSON.stringify({ lessons: [`Read the API key from the environment, never hard-code it like ${key}.`] }));
  await captureLessons({ project: p, item, reworkLog: [{ from: "review", findings: `Hard-coded ${key} in src/client.ts` }], fix: "", agent: qaAgent });
  const content = findDoc(p.id, "project_lessons", null)!.content;
  assert.ok(!content.includes(key));
  assert.match(content, /\[redacted: Anthropic API key\]/);
});

test("live: turned off, no call and no document", async () => {
  const { p, item } = liveStory("LOFF", { lessons: false });
  answers.push('{"lessons": ["Something."]}');
  assert.deepEqual(await captureLessons({ project: p, item, reworkLog: qaRejection, fix: "", agent: qaAgent }), []);
  assert.equal(calls(p.id).length, 0);
  assert.equal(findDoc(p.id, "project_lessons", null), undefined);
  answers.length = 0;
  saveAppSettings({ mode: "simulation", backend: "auto" });
});
