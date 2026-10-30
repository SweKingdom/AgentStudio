// Live agents on the user's own Claude plan: the Claude Agent SDK drives the loop through the local `claude` login
// instead of an API key. Same inputs and outputs as the API loop in runner.ts, so the orchestrator can't tell them apart.
import { createSdkMcpServer, query as sdkQuery, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { logActivity } from "../store.js";
import { AbortedError, BudgetExceededError, LimitReachedError } from "../errors.js";
import type { Usage } from "../pricing.js";
import { executeTool, toolDefs, type ToolContext } from "./tools.js";
import type { Agent } from "./store.js";

type QueryFn = (p: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => AsyncIterable<SDKMessage>;

let query: QueryFn = sdkQuery;

/** Tests only: replace the Agent SDK with a scripted stand-in (no `claude` process, no plan usage). */
export function setSdkQueryForTests(q: unknown) {
  query = (q as QueryFn | null) ?? sdkQuery;
}

const SERVER = "arm";
const mcpName = (tool: string) => `mcp__${SERVER}__${tool}`;

/** One finished model call, reported back so runner.ts records it like an API call. */
export interface SdkCall {
  model: string;
  usage: Usage;
  durationMs: number;
}

export interface SdkRun {
  text: string;
  calls: SdkCall[];
}

/** The app's tool registry as an in-process MCP server. The SDK wants zod shapes; the registry has JSON Schema. */
export function toolServer(ctx: ToolContext, itemId?: string) {
  const tools = toolDefs(ctx.agent.tools, false).map((def) => ({
    name: def.name,
    description: def.description ?? "",
    inputSchema: zodShape(def.input_schema as Record<string, unknown>),
    handler: async (input: Record<string, unknown>) => {
      const r = await executeTool(def.name, input, ctx);
      if (!r.ok) logActivity({ projectId: ctx.project.id, agentId: ctx.agent.id, runId: ctx.runId, itemId, type: "tool_error", summary: `${def.name}: ${r.content}` });
      return { content: [{ type: "text" as const, text: r.content }], isError: !r.ok };
    },
  }));
  return { server: createSdkMcpServer({ name: SERVER, tools, alwaysLoad: true }), allowed: tools.map((t) => mcpName(t.name)) };
}

export function zodShape(schema: Record<string, unknown>): z.ZodRawShape {
  const s = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  return s instanceof z.ZodObject ? s.shape : {};
}

/**
 * The child `claude` process must use the plan login, not a key: an API key in the environment would win and bill the
 * API account. Everything else is passed through (PATH, HOME/USERPROFILE for the login).
 */
function planEnv() {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/** Isolation: no built-in tools (Bash, Read, Edit…), no settings, CLAUDE.md, MCP servers or session files from this machine. */
function baseOptions(agent: Agent, system: string, signal?: AbortSignal): Options {
  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }
  return {
    model: agent.model,
    systemPrompt: system,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    permissionMode: "dontAsk",
    thinking: { type: "adaptive" },
    abortController,
    env: planEnv(),
  };
}

export async function sdkRun(o: {
  agent: Agent;
  system: string;
  content: Array<Record<string, unknown>>;
  ctx?: ToolContext;
  itemId?: string;
  maxTurns: number;
  effort: Agent["effort"];
  /** What is left of the project budget (USD, estimated); the SDK stops the run when it is spent. */
  budgetLeftUsd?: number;
  signal?: AbortSignal;
  onText?: (text: string) => void;
}): Promise<SdkRun> {
  const options = baseOptions(o.agent, o.system, o.signal);
  options.maxTurns = o.maxTurns;
  options.effort = o.effort;
  if (o.budgetLeftUsd !== undefined && o.budgetLeftUsd > 0) options.maxBudgetUsd = o.budgetLeftUsd;
  if (o.ctx && o.agent.tools.length) {
    const { server, allowed } = toolServer(o.ctx, o.itemId);
    options.mcpServers = { [SERVER]: server };
    options.allowedTools = allowed;
  }

  async function* prompt(): AsyncIterable<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: o.content as never }, parent_tool_use_id: null };
  }

  const started = Date.now();
  let text = "";
  try {
    for await (const m of query({ prompt: prompt(), options })) {
      if (o.signal?.aborted) throw new AbortedError("Stopped by user");
      if (m.type === "rate_limit_event" && m.rate_limit_info.status === "rejected") {
        throw planLimit(m.rate_limit_info.resetsAt, m.rate_limit_info.rateLimitType);
      }
      if (m.type === "assistant" && m.parent_tool_use_id === null) {
        if (m.error) throw assistantError(m.error);
        const t = m.message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
        if (t) {
          text = t;
          o.onText?.(t);
        }
      }
      if (m.type === "result") {
        const calls = Object.entries(m.modelUsage).map(([model, u]) => ({
          model,
          usage: { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_tokens: u.cacheReadInputTokens, cache_write_tokens: u.cacheCreationInputTokens },
          durationMs: Date.now() - started,
        }));
        if (m.subtype === "error_max_budget_usd") throw Object.assign(new BudgetExceededError("Project budget reached during the run."), { calls });
        if (m.subtype === "error_during_execution") throw Object.assign(new Error(m.errors.join("; ") || "The agent run failed."), { calls });
        if (m.subtype === "success" && m.is_error) throw Object.assign(textError(m.result), { calls });
        if (m.subtype === "success" && m.result.trim()) text = m.result.trim();
        if (m.subtype === "error_max_turns" && !text) text = `Stopped after ${o.maxTurns} turns.`;
        return { text, calls };
      }
    }
  } catch (e) {
    if (o.signal?.aborted) throw new AbortedError("Stopped by user");
    throw e;
  }
  throw new Error("The Claude process ended without a result.");
}

/** Hitting the plan's 5-hour or weekly window pauses the work until it resets, like an API rate limit. */
function planLimit(resetsAt?: number, type?: string) {
  const when = resetsAt ? new Date(resetsAt * 1000).toISOString() : new Date(Date.now() + 15 * 60_000).toISOString();
  const window = type === "five_hour" ? "5-hour" : type?.startsWith("seven_day") ? "weekly" : "usage";
  return new LimitReachedError(`Your Claude plan's ${window} limit is reached — resumes when it resets.`, "rate_limit", when);
}

function assistantError(err: string) {
  switch (err) {
    case "rate_limit":
      return planLimit();
    case "overloaded":
      return new LimitReachedError("Claude is overloaded — retrying in 3 min.", "overloaded", new Date(Date.now() + 180_000).toISOString());
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return new LimitReachedError("Claude login failed — run `claude /login` on this machine, then resume.", "auth", null);
    case "billing_error":
    case "account_on_hold":
      return new LimitReachedError("Your Claude account can't take more work (billing or plan) — check it, then resume.", "credits", null);
    default:
      return new Error(`Claude returned an error: ${err}`);
  }
}

function textError(result: string) {
  if (/rate.?limit|usage limit|limit reached/i.test(result)) return planLimit();
  if (/not logged in|log ?in|authenticat|invalid api key/i.test(result)) return assistantError("authentication_failed");
  return new Error(result || "The agent run failed.");
}
