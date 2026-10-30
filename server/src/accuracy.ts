import { all } from "./db.js";
import type { Estimate } from "./estimate.js";
import { ROLES, type Role } from "./agents/roles.js";
import { getAgent } from "./agents/store.js";
import { appSettings } from "./settings.js";
import { getProject, listItems } from "./store.js";

/**
 * Estimate vs actual: compares the up-front estimate saved when the project was created with what the agents really
 * spent (llm_calls), how long they really worked (runs) and what the analyst really built (the backlog).
 *
 * Estimates from older versions lack `detail`, `breakdown` or `detected` — every part that needs them is optional.
 */

export const STAGES = ["requirements", "architecture", "planning", "development", "qa", "documentation", "release"] as const;
type StageKey = (typeof STAGES)[number] | "other";

const STAGE_LABEL: Record<StageKey, string> = {
  requirements: "Requirements",
  architecture: "Architecture",
  planning: "Planning",
  development: "Development",
  qa: "Testing",
  documentation: "Documentation",
  release: "Release",
  other: "Consultations & chat",
};

/** Which project pipeline stage (see buildStages) must be finished before a stage's figures are final. */
const PIPELINE_STAGE: Record<string, string> = {
  requirements: "requirements",
  architecture: "architecture",
  planning: "planning",
  development: "delivery",
  qa: "delivery",
  documentation: "delivery",
  release: "release",
};

export interface Interval {
  start: number;
  end: number;
}

/** Total length of the union of intervals (ms): time when at least one of them was open. Overlaps count once. */
export function unionMs(intervals: Interval[]): number {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const i of sorted) {
    if (i.start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = i.start;
      curEnd = i.end;
    } else if (i.end > curEnd) curEnd = i.end;
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

/** Signed % difference of actual vs estimated; null when there's nothing to compare against. */
export function deltaPct(estimated: number | null | undefined, actual: number): number | null {
  if (!estimated || estimated <= 0) return null;
  return ((actual - estimated) / estimated) * 100;
}

interface Usage {
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tokens: number;
}

export interface AgentAccuracy {
  agentId: string;
  name: string;
  role: string;
  title: string;
  color: string;
  estimated: (Usage & { runs: number; minutes: number | null }) | null;
  actual: Usage & { runs: number; busyMs: number };
  deltaPct: number | null;
  tokensDeltaPct: number | null;
  /** One of the biggest misses (largest absolute cost gap, ≥ 25 % off). */
  miss: boolean;
}

export interface StageAccuracy {
  stage: StageKey;
  label: string;
  estimatedUsd: number | null;
  actualUsd: number;
  estimatedTokens: number | null;
  actualTokens: number;
  calls: number;
  deltaPct: number | null;
  tokensDeltaPct: number | null;
  /** The stage has finished, so its figures are final (otherwise still accumulating). */
  complete: boolean;
}

export interface CategoryScope {
  category: string;
  estimatedStories: number | null;
  estimatedPoints: number | null;
  actualStories: number;
  actualPoints: number;
}

export interface Accuracy {
  available: true;
  status: { state: "in_progress" | "final"; projectStatus: string; pctDone: number; done: number; total: number };
  basis: Estimate["basis"] | null;
  simulated: boolean;
  totals: {
    estimated: { expected: number; low: number; high: number; calls: number | null; tokens: number | null };
    actual: { costUsd: number; calls: number; tokens: number; inputTokens: number; outputTokens: number };
    withinRange: boolean;
    position: "under" | "over" | "on";
    deltaPct: number | null;
  };
  agents: AgentAccuracy[];
  stages: StageAccuracy[];
  scope: {
    estimated: { stories: number | null; points: number | null; epics: number | null; features: number | null };
    actual: { stories: number; points: number; epics: number; features: number; unpointed: number };
    storiesDeltaPct: number | null;
    pointsDeltaPct: number | null;
    byCategory: CategoryScope[];
  };
  time: {
    estimatedMinutes: number | null;
    /** Union of all run intervals: time when at least one agent was working (approval waits excluded). */
    aiWallClockMs: number;
    /** Sum of every run's duration (agents working in parallel count separately). */
    agentMs: number;
    /** From the first run (or project start) to the end, including time waiting for approvals. */
    elapsedMs: number;
    deltaPct: number | null;
  };
  verdict: string;
}

export type AccuracyResult = Accuracy | { available: false; reason: string };

/** Money in the app's display currency (Settings), so the verdict reads like the rest of the UI. */
function usd(n: number) {
  const s = appSettings();
  const eur = s.currency === "EUR";
  const v = eur ? n * (s.usdToEur || 0.92) : n;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: eur ? "EUR" : "USD", minimumFractionDigits: v < 1 ? 3 : 2, maximumFractionDigits: v < 1 ? 3 : 2 }).format(v);
}
const pct = (n: number) => `${Math.round(Math.abs(n))} %`;
const mins = (ms: number) => {
  const m = ms / 60000;
  return m < 1 ? `${Math.round(ms / 1000)} s` : m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`;
};
const ts = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);

function emptyUsage(): Usage {
  return { costUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, tokens: 0 };
}

type EstAgent = Estimate["agents"][number];
const estTokens = (a: Pick<EstAgent, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">) =>
  (a.inputTokens ?? 0) + (a.outputTokens ?? 0) + (a.cacheReadTokens ?? 0) + (a.cacheWriteTokens ?? 0);

function stageOfRole(role: string): StageKey {
  const s = ROLES[role as Role]?.stage;
  return (STAGES as readonly string[]).includes(s) ? (s as StageKey) : "other";
}

export function projectAccuracy(projectId: string, nowMs = Date.now()): AccuracyResult {
  const p = getProject(projectId);
  if (!p) return { available: false, reason: "Project not found." };
  const est = p.estimate as Partial<Estimate> | null;
  if (!est || typeof est.totalUsd !== "number" || !Array.isArray(est.agents)) {
    return { available: false, reason: "No up-front estimate was saved when this project was created." };
  }
  const calls = all<{ agent_id: string; stage: string | null; cost_usd: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; simulated: number }>(
    "SELECT agent_id, stage, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, simulated FROM llm_calls WHERE project_id = ?",
    p.id,
  );
  if (!calls.length) return { available: false, reason: "No agent activity yet — the comparison appears once the agents start working." };
  const runs = all<{ agent_id: string; status: string; started_at: string; ended_at: string | null }>(
    "SELECT agent_id, status, started_at, ended_at FROM runs WHERE project_id = ?",
    p.id,
  );

  // ---- actual usage, per agent and per stage
  const add = (u: Usage, c: (typeof calls)[number]) => {
    u.costUsd += c.cost_usd;
    u.calls += 1;
    u.inputTokens += c.input_tokens;
    u.outputTokens += c.output_tokens;
    u.cacheReadTokens += c.cache_read_tokens;
    u.cacheWriteTokens += c.cache_write_tokens;
    u.tokens += c.input_tokens + c.output_tokens + c.cache_read_tokens + c.cache_write_tokens;
  };
  const total = emptyUsage();
  const byAgent = new Map<string, Usage>();
  const byStage = new Map<StageKey, Usage>();
  for (const c of calls) {
    add(total, c);
    if (!byAgent.has(c.agent_id)) byAgent.set(c.agent_id, emptyUsage());
    add(byAgent.get(c.agent_id)!, c);
    const st: StageKey = (STAGES as readonly string[]).includes(c.stage ?? "") ? (c.stage as StageKey) : "other";
    if (!byStage.has(st)) byStage.set(st, emptyUsage());
    add(byStage.get(st)!, c);
  }

  // ---- run intervals: an unfinished run counts up to now only while it is still running
  const intervals: (Interval & { agent: string })[] = [];
  for (const r of runs) {
    const start = ts(r.started_at);
    const end = r.ended_at ? ts(r.ended_at) : r.status === "running" ? nowMs : NaN;
    if (Number.isFinite(start) && Number.isFinite(end)) intervals.push({ start, end, agent: r.agent_id });
  }
  const runsOf = (id: string) => runs.filter((r) => r.agent_id === id).length;
  const busyOf = (id: string) => intervals.filter((i) => i.agent === id).reduce((n, i) => n + Math.max(0, i.end - i.start), 0);

  // ---- per agent
  const estAgents = est.agents as EstAgent[];
  const ids = [...new Set([...estAgents.map((a) => a.agentId), ...byAgent.keys()])];
  const agents: AgentAccuracy[] = ids.map((id) => {
    const e = estAgents.find((a) => a.agentId === id);
    const ag = getAgent(id);
    const actual = { ...(byAgent.get(id) ?? emptyUsage()), runs: runsOf(id), busyMs: busyOf(id) };
    const estimated = e
      ? {
          costUsd: e.costUsd ?? 0,
          calls: e.calls ?? 0,
          runs: e.runs ?? 0,
          inputTokens: e.inputTokens ?? 0,
          outputTokens: e.outputTokens ?? 0,
          cacheReadTokens: e.cacheReadTokens ?? 0,
          cacheWriteTokens: e.cacheWriteTokens ?? 0,
          tokens: estTokens(e),
          minutes: typeof e.minutes === "number" ? e.minutes : null,
        }
      : null;
    return {
      agentId: id,
      name: ag?.name ?? e?.name ?? id,
      role: ag?.role ?? e?.role ?? "specialist",
      title: ag?.title ?? "",
      color: ag?.color ?? "#8a92a6",
      estimated,
      actual,
      deltaPct: deltaPct(estimated?.costUsd, actual.costUsd),
      tokensDeltaPct: deltaPct(estimated?.tokens, actual.tokens),
      miss: false,
    };
  });
  // Pipeline order (requirements → release), then anything else.
  const order = (r: string) => {
    const k = (["requirements", "architect", "planner", "developer", "qa", "writer", "release"] as string[]).indexOf(r);
    return k < 0 ? 99 : k;
  };
  agents.sort((a, b) => order(a.role) - order(b.role) || a.name.localeCompare(b.name));
  // The biggest misses: the two largest absolute cost gaps that are also ≥ 25 % off.
  [...agents]
    .filter((a) => a.deltaPct != null && Math.abs(a.deltaPct) >= 25)
    .sort((a, b) => Math.abs(b.actual.costUsd - (b.estimated?.costUsd ?? 0)) - Math.abs(a.actual.costUsd - (a.estimated?.costUsd ?? 0)))
    .slice(0, 2)
    .forEach((a) => (a.miss = true));

  // ---- per stage
  const stageDone = (st: StageKey) => {
    if (p.status === "completed") return true;
    const key = PIPELINE_STAGE[st];
    const s = key ? p.stages.find((x) => x.key === key) : undefined;
    return !!s && (s.status === "done" || s.status === "skipped");
  };
  const estByStage = new Map<StageKey, { usd: number; tokens: number }>();
  for (const a of estAgents) {
    const st = stageOfRole(a.role);
    const cur = estByStage.get(st) ?? { usd: 0, tokens: 0 };
    cur.usd += a.costUsd ?? 0;
    cur.tokens += estTokens(a);
    estByStage.set(st, cur);
  }
  const stages: StageAccuracy[] = ([...STAGES, "other"] as StageKey[])
    .filter((st) => estByStage.has(st) || byStage.has(st))
    .map((st) => {
      const e = estByStage.get(st);
      const a = byStage.get(st) ?? emptyUsage();
      return {
        stage: st,
        label: STAGE_LABEL[st],
        estimatedUsd: e ? e.usd : null,
        actualUsd: a.costUsd,
        estimatedTokens: e ? e.tokens : null,
        actualTokens: a.tokens,
        calls: a.calls,
        deltaPct: deltaPct(e?.usd, a.costUsd),
        tokensDeltaPct: deltaPct(e?.tokens, a.tokens),
        complete: st === "other" ? p.status === "completed" : stageDone(st),
      };
    });

  // ---- scope: the up-front story analysis vs the backlog the analyst built
  const items = listItems(p.id);
  const backlog = items.filter((i) => (i.type === "story" || i.type === "task") && !["Cancelled", "Removed"].includes(i.state));
  const detected = est.detected ?? null;
  const cats = new Set<string>([...backlog.map((i) => i.category), ...Object.keys(detected?.byCategory ?? {})]);
  const byCategory: CategoryScope[] = [...cats]
    .map((c) => ({
      category: c,
      estimatedStories: detected ? detected.byCategory?.[c] ?? 0 : null,
      estimatedPoints: detected?.stories ? detected.stories.filter((s) => s.category === c).reduce((n, s) => n + (s.points || 0), 0) : null,
      actualStories: backlog.filter((i) => i.category === c).length,
      actualPoints: backlog.filter((i) => i.category === c).reduce((n, i) => n + (i.story_points ?? 0), 0),
    }))
    .sort((a, b) => Math.max(b.actualStories, b.estimatedStories ?? 0) - Math.max(a.actualStories, a.estimatedStories ?? 0));
  const actualPoints = backlog.reduce((n, i) => n + (i.story_points ?? 0), 0);
  const scope = {
    estimated: {
      stories: typeof est.stories === "number" ? est.stories : null,
      points: typeof est.storyPoints === "number" ? est.storyPoints : null,
      epics: detected?.epics ?? null,
      features: typeof est.features === "number" ? est.features : null,
    },
    actual: {
      stories: backlog.length,
      points: actualPoints,
      epics: items.filter((i) => i.type === "epic").length,
      features: items.filter((i) => i.type === "feature").length,
      unpointed: backlog.filter((i) => i.story_points == null).length,
    },
    storiesDeltaPct: backlog.length ? deltaPct(est.stories, backlog.length) : null,
    pointsDeltaPct: actualPoints ? deltaPct(est.storyPoints, actualPoints) : null,
    byCategory,
  };

  // ---- time
  const aiWallClockMs = unionMs(intervals);
  const agentMs = intervals.reduce((n, i) => n + (i.end - i.start), 0);
  const firstStart = Math.min(...intervals.map((i) => i.start), ts(p.started_at) || Infinity);
  const lastEnd = Math.max(...intervals.map((i) => i.end), 0);
  const waiting = ["running", "paused", "awaiting_approval"].includes(p.status);
  const end = p.status === "completed" ? Math.max(ts(p.finished_at) || 0, lastEnd) : waiting ? nowMs : lastEnd;
  const elapsedMs = Number.isFinite(firstStart) ? Math.max(aiWallClockMs, end - firstStart) : aiWallClockMs;
  const estimatedMinutes = typeof est.minutes === "number" ? est.minutes : null;
  const time = { estimatedMinutes, aiWallClockMs, agentMs, elapsedMs, deltaPct: deltaPct(estimatedMinutes ? estimatedMinutes * 60000 : null, aiWallClockMs) };

  // ---- status
  const deliverables = items.filter((i) => ["story", "task", "bug"].includes(i.type) && !["Cancelled", "Removed"].includes(i.state));
  const done = deliverables.filter((i) => i.state === "Deployed (Done)").length;
  const final = p.status === "completed";
  const status = {
    state: (final ? "final" : "in_progress") as "final" | "in_progress",
    projectStatus: p.status,
    pctDone: deliverables.length ? Math.round((done / deliverables.length) * 100) : 0,
    done,
    total: deliverables.length,
  };

  // ---- totals
  const expected = est.totalUsd;
  const low = typeof est.lowUsd === "number" ? est.lowUsd : expected * 0.6;
  const high = typeof est.highUsd === "number" ? est.highUsd : expected * 1.7;
  const d = deltaPct(expected, total.costUsd);
  const totals = {
    estimated: {
      expected,
      low,
      high,
      calls: estAgents.length ? estAgents.reduce((n, a) => n + (a.calls ?? 0), 0) : null,
      tokens: estAgents.length ? estAgents.reduce((n, a) => n + estTokens(a), 0) : null,
    },
    actual: { costUsd: total.costUsd, calls: total.calls, tokens: total.tokens, inputTokens: total.inputTokens, outputTokens: total.outputTokens },
    withinRange: total.costUsd >= low && total.costUsd <= high,
    position: (d == null || Math.abs(d) < 1 ? "on" : d < 0 ? "under" : "over") as "under" | "over" | "on",
    deltaPct: d,
  };

  const result: Accuracy = {
    available: true,
    status,
    basis: est.basis ?? null,
    simulated: calls.some((c) => c.simulated === 1),
    totals,
    agents,
    stages,
    scope,
    time,
    verdict: "",
  };
  result.verdict = verdictOf(result);
  return result;
}

/** One plain-English line summarising the comparison. */
export function verdictOf(a: Accuracy): string {
  const t = a.totals;
  const parts: string[] = [];
  if (a.status.state === "final") {
    const where = t.withinRange ? "inside the range" : t.actual.costUsd < t.estimated.low ? "below the range" : "above the range";
    parts.push(
      t.position === "on"
        ? `Actual cost ${usd(t.actual.costUsd)} matches the estimate and is ${where}`
        : `Actual cost ${usd(t.actual.costUsd)} is ${pct(t.deltaPct!)} ${t.position} the estimate of ${usd(t.estimated.expected)} and ${where} (${usd(t.estimated.low)}–${usd(t.estimated.high)})`,
    );
  } else {
    const share = t.estimated.expected > 0 ? Math.round((t.actual.costUsd / t.estimated.expected) * 100) : 0;
    parts.push(
      `In progress (${a.status.pctDone} % of items done): ${usd(t.actual.costUsd)} spent so far, ${share} % of the expected ${usd(t.estimated.expected)}${t.actual.costUsd > t.estimated.high ? " — already above the high end of the range" : ""}`,
    );
  }
  // The finished stage with the largest token gap (≥ 15 %) — open stages are still accumulating.
  const stage = a.stages
    .filter((s) => s.complete && s.stage !== "other" && s.tokensDeltaPct != null && Math.abs(s.tokensDeltaPct) >= 15)
    .sort((x, y) => Math.abs(y.actualTokens - (y.estimatedTokens ?? 0)) - Math.abs(x.actualTokens - (x.estimatedTokens ?? 0)))[0];
  if (stage) parts.push(`${stage.label.toLowerCase()} took ${pct(stage.tokensDeltaPct!)} ${stage.tokensDeltaPct! > 0 ? "more" : "fewer"} tokens than estimated`);
  if (a.scope.storiesDeltaPct != null && Math.abs(a.scope.storiesDeltaPct) >= 10 && a.scope.estimated.stories != null) {
    parts.push(`the backlog has ${a.scope.actual.stories} stories vs ${a.scope.estimated.stories} estimated`);
  }
  if (a.status.state === "final" && a.status.done < a.status.total) {
    parts.push(`${a.status.done} of ${a.status.total} items were delivered (the rest are still open)`);
  }
  // Simulated time follows the simulation speed setting, not real model speed — comparing it would mislead.
  if (a.time.estimatedMinutes != null && a.status.state === "final" && !a.simulated) {
    parts.push(`AI wall-clock was ${mins(a.time.aiWallClockMs)} vs ${mins(a.time.estimatedMinutes * 60000)} estimated`);
  }
  const line = parts.join("; ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.${a.simulated ? " (Simulation: costs are computed at real prices, not billed; times follow the simulation speed, so they aren't compared.)" : ""}`;
}
