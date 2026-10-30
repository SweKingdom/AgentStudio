// The subscription backend (Agent SDK) with a scripted stand-in for `query`: isolation options, results, usage and
// plan limits — no `claude` process, no plan usage.
import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";

process.env.ANTHROPIC_API_KEY = "key-that-must-not-reach-the-child";

const { sdkRun, setSdkQueryForTests, zodShape } = await import("../src/agents/runner-sdk.ts");
const { toolCatalog, toolDefs } = await import("../src/agents/tools.ts");
const { defaultAgentFor } = await import("../src/agents/store.ts");
const { LimitReachedError, BudgetExceededError } = await import("../src/errors.ts");

after(() => {
  setSdkQueryForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
});

const agent = defaultAgentFor("developer");
const usage = { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 500, cacheCreationInputTokens: 0 };
const result = (extra: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", is_error: false, result: "Done.", modelUsage: { "claude-opus-5-5": usage }, errors: [], ...extra });

function script(messages: unknown[], seen?: { options?: any }) {
  setSdkQueryForTests(async function* (p: { options?: unknown }) {
    if (seen) seen.options = p.options;
    for (const m of messages) yield m;
  });
}

test("every registry tool converts to a zod shape with its properties", () => {
  for (const def of toolDefs(toolCatalog().map((t) => t.name), false)) {
    const props = Object.keys((def.input_schema as { properties?: object }).properties ?? {});
    assert.deepEqual(Object.keys(zodShape(def.input_schema as Record<string, unknown>)).sort(), props.sort(), def.name);
  }
});

test("an empty tool result is still text (MCP rejects a missing string)", async () => {
  const { executeTool } = await import("../src/agents/tools.ts");
  const dev = { ...agent, tools: ["list_items"] };
  const r = await executeTool("list_items", {}, { project: { id: "prj_none" }, agent: dev, runId: "run_x", iteration: 1, outcome: {} } as never);
  assert.deepEqual(r, { ok: true, content: "[]" });
});

test("runs isolated on the plan login and returns the final text and usage", async () => {
  const seen: { options?: any } = {};
  script([{ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Working on it" }] } }, result()], seen);
  const notes: string[] = [];
  const r = await sdkRun({ agent, system: "sys", content: [{ type: "text", text: "task" }], maxTurns: 5, effort: "high", budgetLeftUsd: 3, onText: (t) => notes.push(t) });
  assert.equal(r.text, "Done.");
  assert.deepEqual(notes, ["Working on it"]);
  assert.equal(r.calls[0].model, "claude-opus-5-5");
  assert.equal(r.calls[0].usage.cache_read_tokens, 500);
  const o = seen.options;
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
  assert.equal(o.persistSession, false);
  assert.equal(o.permissionMode, "dontAsk");
  assert.equal(o.maxBudgetUsd, 3);
  assert.equal(o.env.ANTHROPIC_API_KEY, undefined, "an API key would bill the API account instead of the plan");
});

test("a window report alone doesn't stop the run; it is reported", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const reports: unknown[] = [];
  script([{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour", overageStatus: "allowed" } }, result()]);
  const r = await sdkRun({ agent, system: "s", content: [], maxTurns: 1, effort: "low", onRateLimit: (l) => reports.push(l) });
  assert.equal(r.text, "Done.", "the calls kept going (e.g. on extra usage)");
  assert.equal(reports.length, 1);
});

test("a refused call pauses until the reported window resets", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  script([
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" } },
    { type: "assistant", parent_tool_use_id: null, error: "rate_limit", message: { content: [] } },
  ]);
  await assert.rejects(sdkRun({ agent, system: "s", content: [], maxTurns: 1, effort: "low" }), (e: unknown) => {
    assert.ok(e instanceof LimitReachedError);
    assert.equal(e.kind, "rate_limit");
    assert.equal(e.resumeAt, new Date(resetsAt * 1000).toISOString());
    return true;
  });
});

test("a failed login pauses instead of failing the run", async () => {
  script([{ type: "assistant", parent_tool_use_id: null, error: "authentication_failed", message: { content: [] } }]);
  await assert.rejects(sdkRun({ agent, system: "s", content: [], maxTurns: 1, effort: "low" }), (e: unknown) => e instanceof LimitReachedError && e.kind === "auth");
});

test("a spent budget stops the run and still reports its usage", async () => {
  script([result({ subtype: "error_max_budget_usd", is_error: true })]);
  await assert.rejects(sdkRun({ agent, system: "s", content: [], maxTurns: 1, effort: "low" }), (e: unknown) => e instanceof BudgetExceededError && (e as { calls?: unknown[] }).calls?.length === 1);
});
