// The model by story size: the developer and QA use the project's model for small or large stories, else their own.
import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ANTHROPIC_API_KEY ??= "test-key-never-sent";

const { modelForRun, runAgent, setAnthropicClientForTests } = await import("../src/agents/runner.ts");
const { defaultAgentFor } = await import("../src/agents/store.ts");
const { createItem, getProject } = await import("../src/store.ts");
const { saveAppSettings } = await import("../src/settings.ts");
const { all, insert, now } = await import("../src/db.ts");

const sized = { settings: { modelBySize: { small: "claude-haiku-5-5", large: "claude-opus-5-5" } } } as any;
const dev = { role: "developer", model: "claude-sonnet-5-5" } as const;

test("small and large stories get the project's models; the rest keep the agent's own", () => {
  assert.equal(modelForRun(sized, dev, { story_points: 1 }), "claude-haiku-5-5");
  assert.equal(modelForRun(sized, dev, { story_points: 2 }), "claude-haiku-5-5");
  assert.equal(modelForRun(sized, dev, { story_points: 5 }), "claude-sonnet-5-5");
  assert.equal(modelForRun(sized, dev, { story_points: 8 }), "claude-opus-5-5");
  assert.equal(modelForRun(sized, { role: "qa", model: "claude-sonnet-5-5" }, { story_points: 1 }), "claude-haiku-5-5");
  assert.equal(modelForRun(sized, { role: "writer", model: "claude-sonnet-5-5" }, { story_points: 1 }), "claude-sonnet-5-5", "only the developer and QA");
  assert.equal(modelForRun(sized, dev, { story_points: null }), "claude-sonnet-5-5", "unestimated: the agent's own");
  assert.equal(modelForRun(sized, dev, undefined), "claude-sonnet-5-5");
  assert.equal(modelForRun({ settings: {} } as any, dev, { story_points: 1 }), "claude-sonnet-5-5", "not set: the agent's own");
  assert.equal(modelForRun({ settings: { modelBySize: { small: null, large: "claude-opus-5-5" } } } as any, dev, { story_points: 1 }), "claude-sonnet-5-5");
});

test("a live run on a small story calls Claude with the small-story model and records it", async () => {
  const sent: string[] = [];
  setAnthropicClientForTests({
    beta: {
      messages: {
        stream: (params: any) => ({
          finalMessage: async () => {
            sent.push(params.model);
            return { id: "msg_1", type: "message", role: "assistant", model: params.model, content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
          },
        }),
      },
    },
  });
  saveAppSettings({ mode: "live", backend: "api" });
  try {
    const ts = now();
    insert("projects", { id: "prj_MDL", key: "MDL", name: "MDL", status: "ready", mode: "live", created_at: ts, updated_at: ts, settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1, modelBySize: { small: "claude-haiku-5-5" } } });
    const p = getProject("prj_MDL")!;
    const agent = defaultAgentFor("developer", { model: "claude-sonnet-5-5" });
    const small = createItem(p.id, { type: "story", title: "Rename a label", story_points: 1 });
    const medium = createItem(p.id, { type: "story", title: "Book a class", story_points: 5 });
    await runAgent({ project: p, agent, stage: "development", item: small, task: "Implement it." });
    await runAgent({ project: p, agent, stage: "development", item: medium, task: "Implement it." });
    assert.deepEqual(sent, ["claude-haiku-5-5", "claude-sonnet-5-5"]);
    assert.deepEqual(all<{ model: string }>("SELECT model FROM llm_calls WHERE project_id = ? ORDER BY id", p.id).map((r) => r.model), ["claude-haiku-5-5", "claude-sonnet-5-5"]);
    assert.equal(all("SELECT 1 FROM activity WHERE project_id = ? AND summary LIKE '%uses claude-haiku-5-5 for%'", p.id).length, 1);
  } finally {
    saveAppSettings({ mode: "simulation", backend: "auto" });
  }
});
