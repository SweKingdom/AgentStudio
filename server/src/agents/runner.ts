import Anthropic from "@anthropic-ai/sdk";
import { get, insert, now, uid, update } from "../db.js";
import { emit } from "../events.js";
import { knowledgeById } from "../knowledge.js";
import { costOf, type Usage } from "../pricing.js";
import { appSettings, claudeBackend, effectiveMode } from "../settings.js";
import { sdkRun, type SdkCall } from "./runner-sdk.js";
import { answeredQuestions, findDoc, getItem, getProject, logActivity, type Project, type WorkItem } from "../store.js";
import { agentEmail, renderPrompt, type Agent } from "./store.js";
import { executeTool, toolDefs, type ToolContext } from "./tools.js";
import { simulateConsult, simulateRun } from "./simulator.js";
import { changedOnBranch, commitWork, pushRefs } from "../git.js";
import { consultContext, contextFor, type RunContext } from "./context.js";
import { fill, teamSettings } from "../team.js";

let client: Anthropic | null = null;
function anthropic() {
  client ??= new Anthropic({ maxRetries: 4 });
  return client;
}

/** Tests only: replace the Claude client with a scripted stand-in (no network, no spend). */
export function setAnthropicClientForTests(c: unknown) {
  client = c as Anthropic;
}

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export { AbortedError, BudgetExceededError, LimitReachedError, PauseRequestedError } from "../errors.js";
import { AbortedError, BudgetExceededError, LimitReachedError } from "../errors.js";
import { checkSpendLimits, limitFromApiError } from "../pause.js";

export interface RunOptions {
  project: Project;
  agent: Agent;
  stage: string;
  item?: WorkItem;
  iteration?: number;
  task: string;
  pdfBase64?: string | null;
  signal?: AbortSignal;
  /** pipeline | rerun | bugfix | release — shown in run history. */
  kind?: string;
  /** Free-text feedback from the product owner for re-runs. */
  feedback?: string;
  /** Attempt number within this delivery (1 = first build, >1 = QA rework); `iteration` is the item's global count. */
  attempt?: number;
}

export interface RunResult {
  runId: string;
  summary: string;
  outcome: ToolContext["outcome"];
}

/** Full system prompt = role prompt + knowledge packs + agent's own custom knowledge. Stable per agent → cacheable. */
export function buildSystemPrompt(agent: Agent) {
  const packs = knowledgeById(agent.knowledge);
  const parts = [renderPrompt(agent)];
  if (packs.length) {
    parts.push("# Knowledge\nThe following knowledge packs are your working standards. Follow them.");
    for (const p of packs) parts.push(`<knowledge id="${p.id}" title="${p.title}">\n${p.content}\n</knowledge>`);
  }
  if (agent.custom_knowledge?.trim()) {
    parts.push(`<knowledge id="custom" title="${agent.name}'s own skills (written by the product owner — highest priority)">\n${agent.custom_knowledge.trim()}\n</knowledge>`);
  }
  return parts.join("\n\n");
}

export function projectCost(projectId: string) {
  return get<{ c: number }>("SELECT COALESCE(SUM(cost_usd),0) AS c FROM llm_calls WHERE project_id = ?", projectId)!.c;
}

export function recordCall(c: {
  runId: string | null;
  projectId: string;
  agentId: string;
  itemId?: string | null;
  stage: string;
  model: string;
  usage: Usage;
  durationMs: number;
  simulated: boolean;
}) {
  const cost = costOf(c.model, c.usage);
  insert("llm_calls", {
    run_id: c.runId,
    project_id: c.projectId,
    agent_id: c.agentId,
    item_id: c.itemId ?? null,
    stage: c.stage,
    model: c.model,
    input_tokens: c.usage.input_tokens,
    output_tokens: c.usage.output_tokens,
    cache_read_tokens: c.usage.cache_read_tokens,
    cache_write_tokens: c.usage.cache_write_tokens,
    cost_usd: cost,
    duration_ms: c.durationMs,
    simulated: c.simulated ? 1 : 0,
    created_at: now(),
  });
  if (c.runId) {
    update("runs", c.runId, { turns: (get<{ turns: number }>("SELECT turns FROM runs WHERE id = ?", c.runId)?.turns ?? 0) + 1 });
  }
  emit({ type: "cost", projectId: c.projectId, data: { agentId: c.agentId, cost } });
  return cost;
}

export function checkBudget(projectId: string) {
  checkSpendLimits();
  const p = getProject(projectId);
  if (!p) return;
  const spent = projectCost(projectId);
  if (p.settings.budgetUsd > 0 && spent >= p.settings.budgetUsd) {
    throw new BudgetExceededError(`Budget of $${p.settings.budgetUsd.toFixed(2)} reached ($${spent.toFixed(2)} spent).`);
  }
}

function startRun(o: RunOptions) {
  const runId = uid("run");
  insert("runs", {
    id: runId,
    project_id: o.project.id,
    agent_id: o.agent.id,
    stage: o.stage,
    item_id: o.item?.id ?? null,
    status: "running",
    agent_version: o.agent.version,
    kind: o.kind ?? "pipeline",
    started_at: now(),
  });
  emit({ type: "run", projectId: o.project.id, data: { runId, agentId: o.agent.id, status: "running", itemId: o.item?.id } });
  return runId;
}

function finishRun(projectId: string, runId: string, agentId: string, status: string, summary: string | null, error?: string) {
  update("runs", runId, { status, summary, error: error ?? null, ended_at: now() });
  emit({ type: "run", projectId, data: { runId, agentId, status } });
}

/** Shared context block every agent receives in its first message. */
export function projectContext(project: Project) {
  const brief = findDoc(project.id, "project_brief", null);
  const answers = answeredQuestions(project.id);
  const parts = [`# Project ${project.key} — ${project.name}`];
  if (project.description) parts.push(`## Description from the product owner\n${project.description}`);
  if (brief) parts.push(`## Project brief\n${brief.content}`);
  if (answers.length) {
    parts.push(`## Answers from the product owner\n${answers.map((a) => `- **Q:** ${a.question}\n  **A:** ${a.answer}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

export async function runAgent(o: RunOptions): Promise<RunResult> {
  const runId = startRun(o);
  const ctx: ToolContext = {
    project: o.project,
    agent: o.agent,
    runId,
    item: o.item,
    iteration: o.iteration ?? 1,
    outcome: {},
    consult: consultAgent,
  };
  logActivity({
    projectId: o.project.id,
    agentId: o.agent.id,
    runId,
    itemId: o.item?.id,
    type: "run_started",
    summary: `${o.agent.name} started ${o.stage}${o.item ? ` on ${o.item.code}` : ""}${(o.iteration ?? 1) > 1 ? ` (iteration ${o.iteration})` : ""}`,
  });
  try {
    const summary =
      o.project.mode === "simulation" || effectiveMode() === "simulation"
        ? await simulateRun(ctx, o)
        : claudeBackend() === "subscription"
          ? await sdkLoop(ctx, o)
          : await liveLoop(ctx, o);
    finishRun(o.project.id, runId, o.agent.id, "done", summary);
    // Each agent run becomes a commit authored by that agent (only when it changed files).
    try {
      const first = summary.split("\n").find((l) => l.trim())?.trim().slice(0, 90) ?? o.stage;
      const hash = await commitWork(getProject(o.project.id) ?? o.project, {
        author: `${o.agent.name} (${o.agent.title})`,
        email: agentEmail(o.agent.name),
        message: `${fill(teamSettings().conventions.commitPattern, { code: o.item?.code ?? o.project.key, stage: o.stage, summary: first, agent: o.agent.name }).split("\n")[0].slice(0, 200)}\n\nAgent: ${o.agent.name} v${o.agent.version} · run ${runId}${o.kind && o.kind !== "pipeline" ? ` · ${o.kind}` : ""}`,
        itemCode: o.item?.code,
      });
      const branch = o.item ? getItem(o.item.id)?.branch : null;
      if (hash) logActivity({ projectId: o.project.id, agentId: o.agent.id, runId, itemId: o.item?.id, type: "file", summary: `Committed ${hash}${branch ? ` on ${branch}` : ""}: ${o.item?.code ?? o.project.key} ${o.stage}` });
      // Teams push their task branch as they go — only when the project opted in to pushing.
      if (hash && branch && getProject(o.project.id)?.settings.repo?.push) {
        const pushed = await pushRefs(getProject(o.project.id)!, [branch]);
        logActivity({ projectId: o.project.id, agentId: o.agent.id, runId, itemId: o.item?.id, type: pushed.pushed ? "file" : "tool_error", summary: pushed.pushed ? `Pushed ${branch} to origin` : `Push of ${branch} failed: ${pushed.output.split("\n")[0]}`, detail: pushed.output });
      }
    } catch (e) {
      logActivity({ projectId: o.project.id, agentId: o.agent.id, runId, type: "tool_error", summary: `git commit failed: ${e instanceof Error ? e.message.split("\n")[0] : e}` });
    }
    logActivity({ projectId: o.project.id, agentId: o.agent.id, runId, itemId: o.item?.id, type: "run_done", summary: `${o.agent.name} finished ${o.stage}${o.item ? ` on ${o.item.code}` : ""}`, detail: summary });
    return { runId, summary, outcome: ctx.outcome };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    finishRun(o.project.id, runId, o.agent.id, e instanceof AbortedError || e instanceof LimitReachedError || e instanceof BudgetExceededError ? "stopped" : "failed", null, msg);
    logActivity({ projectId: o.project.id, agentId: o.agent.id, runId, itemId: o.item?.id, type: "run_failed", summary: `${o.agent.name}: ${msg}` });
    throw e;
  }
}

/** What this run is told up front (see context.ts). QA and the writer also get the files the story changed. */
export async function runContext(ctx: Pick<ToolContext, "project" | "agent" | "item">, o: Pick<RunOptions, "item">): Promise<RunContext> {
  const item = o.item ? getItem(o.item.id) ?? o.item : undefined;
  const role = ctx.agent.role;
  const changedFiles = item && (role === "qa" || role === "writer") ? await changedOnBranch(ctx.project, item.code).catch(() => []) : undefined;
  return contextFor(getProject(ctx.project.id) ?? ctx.project, ctx.agent, item, { changedFiles });
}

const WORKING_RULES =
  "Working rules: the context above is current — don't re-fetch it with tools (get_item, read_document, list_files) unless you need something it doesn't show. Batch independent tool calls in the same turn. Keep messages and summaries short; put detail in documents and work items, not in chat.";

export function firstMessageTail(c: RunContext, o: Pick<RunOptions, "task">) {
  return `${c.specific ? `${c.specific}\n\n` : ""}---\n\n# Your task\n${o.task}\n\n${WORKING_RULES}`;
}

async function liveLoop(ctx: ToolContext, o: RunOptions): Promise<string> {
  const { agent, project } = ctx;
  const system = buildSystemPrompt(agent);
  const tools = toolDefs(agent.tools, true);
  const firstContent: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (o.pdfBase64) {
    firstContent.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: o.pdfBase64 }, title: project.pdf_name ?? "Requirements" });
  }
  const c = await runContext(ctx, o);
  // Project context first, with its own cache breakpoint: every run of this role in this project re-reads it from cache.
  firstContent.push({ type: "text", text: c.shared, cache_control: { type: "ephemeral" } });
  firstContent.push({ type: "text", text: firstMessageTail(c, o) });
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: firstContent }];
  const useFallback = appSettings().refusalFallback && FALLBACK_MODELS.has(agent.model);
  let finalText = "";

  for (let turn = 0; turn < agent.max_turns; turn++) {
    if (o.signal?.aborted) throw new AbortedError("Stopped by user");
    checkBudget(project.id);
    const started = Date.now();
    const stream = anthropic().beta.messages.stream(
      {
        model: agent.model,
        max_tokens: 32000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        cache_control: { type: "ephemeral" },
        thinking: { type: "adaptive" },
        output_config: { effort: agent.effort },
        tools: tools as Anthropic.Beta.BetaTool[],
        messages,
        ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal: o.signal },
    );
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await stream.finalMessage();
    } catch (e) {
      if (o.signal?.aborted) throw new AbortedError("Stopped by user");
      throw limitFromApiError(e) ?? e;
    }
    const u = response.usage;
    recordCall({
      runId: ctx.runId,
      projectId: project.id,
      agentId: agent.id,
      itemId: o.item?.id,
      stage: o.stage,
      model: response.model || agent.model,
      usage: {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_tokens: u.cache_read_input_tokens ?? 0,
        cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      },
      durationMs: Date.now() - started,
      simulated: false,
    });

    messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
    const text = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
    if (text) {
      finalText = text;
      logActivity({ projectId: project.id, agentId: agent.id, runId: ctx.runId, itemId: o.item?.id, type: "note", summary: text.slice(0, 300), detail: text });
    }

    if (response.stop_reason === "refusal") throw new Error("The model declined this request (refusal).");
    if (response.stop_reason === "pause_turn") continue;
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason === "max_tokens") {
      // Never execute a possibly truncated tool input; answer every tool_use so the conversation stays valid.
      const note = "Your last response hit the output limit and was cut off. Continue, sending one file or item per tool call.";
      messages.push({
        role: "user",
        content: toolUses.length
          ? toolUses.map((tu) => ({ type: "tool_result" as const, tool_use_id: tu.id, content: `Not executed — input was truncated. ${note}`, is_error: true }))
          : note,
      });
      continue;
    }
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) return finalText;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const r = await executeTool(tu.name, tu.input, ctx);
      if (!r.ok) {
        logActivity({ projectId: project.id, agentId: agent.id, runId: ctx.runId, itemId: o.item?.id, type: "tool_error", summary: `${tu.name}: ${r.content}` });
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: !r.ok });
    }
    messages.push({ role: "user", content: results });
  }
  return finalText || `Stopped after ${agent.max_turns} turns.`;
}

/** Records each model the SDK used, also when the run ended in an error that carried usage. */
function recordSdkCalls(calls: SdkCall[], c: { runId: string | null; projectId: string; agentId: string; itemId?: string | null; stage: string }) {
  for (const call of calls) recordCall({ ...c, model: call.model, usage: call.usage, durationMs: call.durationMs, simulated: false });
}

async function withSdkCalls<T extends { calls: SdkCall[] }>(run: Promise<T>, c: Parameters<typeof recordSdkCalls>[1]): Promise<T> {
  try {
    const r = await run;
    recordSdkCalls(r.calls, c);
    return r;
  } catch (e) {
    const calls = (e as { calls?: SdkCall[] }).calls;
    if (calls) recordSdkCalls(calls, c);
    throw e;
  }
}

/** The same run as liveLoop, on the user's Claude plan through the Agent SDK. */
async function sdkLoop(ctx: ToolContext, o: RunOptions): Promise<string> {
  const { agent, project } = ctx;
  checkBudget(project.id);
  const content: Array<Record<string, unknown>> = [];
  if (o.pdfBase64) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: o.pdfBase64 }, title: project.pdf_name ?? "Requirements" });
  const c = await runContext(ctx, o);
  content.push({ type: "text", text: c.shared });
  content.push({ type: "text", text: firstMessageTail(c, o) });
  const budget = getProject(project.id)?.settings.budgetUsd ?? 0;
  const r = await withSdkCalls(
    sdkRun({
      agent,
      system: buildSystemPrompt(agent),
      content,
      ctx,
      itemId: o.item?.id,
      maxTurns: agent.max_turns,
      effort: agent.effort,
      budgetLeftUsd: budget > 0 ? Math.max(0.01, budget - projectCost(project.id)) : undefined,
      signal: o.signal,
      onText: (text) => logActivity({ projectId: project.id, agentId: agent.id, runId: ctx.runId, itemId: o.item?.id, type: "note", summary: text.slice(0, 300), detail: text }),
      onRateLimit: (l) =>
        logActivity({
          projectId: project.id,
          agentId: agent.id,
          runId: ctx.runId,
          itemId: o.item?.id,
          type: "note",
          summary: `Claude plan: ${l.rateLimitType ?? "usage"} window ${l.status === "rejected" ? "reported as used up" : "close to its limit"}${l.utilization !== undefined ? ` (${Math.round(l.utilization * 100)} %)` : ""}${l.resetsAt ? `, resets ${new Date(l.resetsAt * 1000).toLocaleTimeString("en-GB")}` : ""}${l.isUsingOverage || l.overageStatus === "allowed" ? " — continuing on extra usage" : " — work continues until Claude refuses a call"}`,
          detail: JSON.stringify(l),
        }),
    }),
    { runId: ctx.runId, projectId: project.id, agentId: agent.id, itemId: o.item?.id, stage: o.stage },
  );
  return r.text;
}

/** Synchronous consultation: the target agent answers one question with its own prompt and knowledge. */
export async function consultAgent(target: Agent, question: string, ctx: ToolContext): Promise<string> {
  const project = ctx.project;
  const runId = uid("run");
  insert("runs", { id: runId, project_id: project.id, agent_id: target.id, stage: "consult", item_id: ctx.item?.id ?? null, status: "running", agent_version: target.version, kind: "consult", started_at: now() });
  emit({ type: "run", projectId: project.id, data: { runId, agentId: target.id, status: "running" } });
  try {
    let answer: string;
    if (project.mode === "simulation" || effectiveMode() === "simulation") {
      answer = await simulateConsult(target, question, ctx, runId);
    } else if (claudeBackend() === "subscription") {
      checkBudget(project.id);
      const r = await withSdkCalls(
        sdkRun({
          agent: target,
          system: buildSystemPrompt(target),
          content: [{ type: "text", text: `${consultContext(project, ctx.item)}\n\n---\n\n${ctx.agent.name} (${ctx.agent.title}) asks you:\n\n${question}\n\nAnswer directly and concisely (a few sentences or a short list). You cannot use tools in a consultation.` }],
          maxTurns: 1,
          effort: "low",
        }),
        { runId, projectId: project.id, agentId: target.id, itemId: ctx.item?.id, stage: "consult" },
      );
      answer = r.text;
    } else {
      checkBudget(project.id);
      const started = Date.now();
      const itemBlock = "";
      const response = await anthropic().messages.create({
        model: target.model,
        max_tokens: 4000,
        system: [{ type: "text", text: buildSystemPrompt(target), cache_control: { type: "ephemeral" } }],
        output_config: { effort: "low" },
        messages: [
          {
            role: "user",
            content: `${consultContext(project, ctx.item)}${itemBlock}\n\n---\n\n${ctx.agent.name} (${ctx.agent.title}) asks you:\n\n${question}\n\nAnswer directly and concisely (a few sentences or a short list). You cannot use tools in a consultation.`,
          },
        ],
      });
      recordCall({
        runId,
        projectId: project.id,
        agentId: target.id,
        itemId: ctx.item?.id,
        stage: "consult",
        model: response.model || target.model,
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
          cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
        },
        durationMs: Date.now() - started,
        simulated: false,
      });
      answer =
        response.stop_reason === "refusal"
          ? "(The consulted agent declined to answer.)"
          : response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
    }
    update("runs", runId, { status: "done", summary: answer.slice(0, 2000), ended_at: now() });
    emit({ type: "run", projectId: project.id, data: { runId, agentId: target.id, status: "done" } });
    return answer;
  } catch (e) {
    const limit = e instanceof LimitReachedError ? e : limitFromApiError(e);
    update("runs", runId, { status: limit ? "stopped" : "failed", error: String(e), ended_at: now() });
    if (limit) throw limit;
    return `Consultation failed: ${e instanceof Error ? e.message : e}`;
  }
}

/** Real token count of the requirements PDF (live mode only). */
export async function countPdfTokens(pdfBase64: string, model: string): Promise<number | null> {
  // Token counting is an API endpoint; on the plan the estimate uses its page-based guess.
  if (claudeBackend() === "subscription") return null;
  try {
    const r = await anthropic().messages.countTokens({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
            { type: "text", text: "Analyse." },
          ],
        },
      ],
    });
    return r.input_tokens;
  } catch {
    return null;
  }
}

/** Live chat with one agent (only used when the app runs in live mode). */
export async function liveChat(agent: Agent, project: Project | null, history: { sender: string; content: string }[], message: string): Promise<string> {
  const started = Date.now();
  const context = project ? `${consultContext(project)}\n\n---\n\n` : "";
  const messages: Anthropic.MessageParam[] = history.slice(-20, -1).map((h) => ({ role: h.sender === "human" ? "user" : "assistant", content: h.content }));
  messages.push({ role: "user", content: `${context}${message}\n\n(You are chatting with the product owner. Answer directly; you cannot use tools here.)` });
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (claudeBackend() === "subscription") {
    // The SDK takes one prompt, so earlier turns go in as a transcript.
    const transcript = messages.slice(0, -1).map((m) => `${m.role === "user" ? "Product owner" : agent.name}: ${m.content}`).join("\n\n");
    const r = await sdkRun({
      agent,
      system: buildSystemPrompt(agent),
      content: [{ type: "text", text: `${transcript ? `# Conversation so far\n${transcript}\n\n---\n\n` : ""}${messages[messages.length - 1].content}` }],
      maxTurns: 1,
      effort: "low",
    });
    if (project) recordSdkCalls(r.calls, { runId: null, projectId: project.id, agentId: agent.id, stage: "chat" });
    return r.text;
  }
  const response = await anthropic().messages.create({
    model: agent.model,
    max_tokens: 4000,
    system: [{ type: "text", text: buildSystemPrompt(agent), cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low" },
    messages,
  });
  if (project) {
    recordCall({
      runId: null,
      projectId: project.id,
      agentId: agent.id,
      stage: "chat",
      model: response.model || agent.model,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      durationMs: Date.now() - started,
      simulated: false,
    });
  }
  if (response.stop_reason === "refusal") return "(I can't help with that request.)";
  return response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
}
