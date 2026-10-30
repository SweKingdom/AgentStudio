import { buildSystemPrompt } from "./agents/runner.js";
import type { Agent } from "./agents/store.js";
import { costOf, priceFor } from "./pricing.js";
import { appSettings } from "./settings.js";

/**
 * Estimate of what a project will cost and how long it will take, per agent.
 *
 * It's driven by the requirements themselves: before the run, by the stories a local analysis finds in the document
 * (type and size of each); once the analyst has built the backlog, by the real backlog. Token use per story scales
 * with its points and type (an integration costs more than a configuration). Shown as a low/expected/high range.
 */
export interface DetectedStory {
  title: string;
  category: string;
  points: number;
  /** Why it got those points (base by type, modifiers). */
  pointsWhy?: string[];
  /** Effort weight used for tokens: type factor × (points ÷ 3)^0.7. */
  weight?: number;
  feature?: string;
  epic?: string;
}

export interface EstimateInput {
  agents: Agent[];
  pdfPages: number | null;
  pdfTokens: number | null;
  descriptionChars: number;
  /** Characters of requirements text actually read (PDF text or description). */
  textChars?: number;
  /** Stories found in the requirements (document analysis) or in the backlog. */
  stories?: DetectedStory[];
  epics?: number;
  features?: number;
  /** "backlog" once the analyst has built it; otherwise the document analysis. */
  source?: "document" | "backlog";
  storyCount?: number; // legacy: count only
  storyPoints?: number;
  parallelism: number;
  maxRework: number;
  /** Architect code review after QA (project setting): adds one smaller architect run per reviewed story. */
  codeReview?: "off" | "complex" | "all";
}

/** Relative build + test effort per story type (configuration is the cheapest, integrations the most expensive). */
export const CATEGORY_WEIGHT: Record<string, number> = {
  integration: 1.35,
  data_migration: 1.25,
  development: 1.15,
  devops: 1,
  script: 0.9,
  testing: 0.85,
  reporting: 0.8,
  configuration: 0.8,
  security: 0.7,
  documentation: 0.6,
};

export interface AgentEstimate {
  agentId: string;
  name: string;
  role: string;
  model: string;
  runs: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  minutes: number;
  /** How the figures were obtained (shown under "How this is calculated"). */
  detail: {
    effort: string;
    thinkingPerCall: number;
    callsPerRun: number;
    systemTokens: number;
    perRun: { input: number; output: number; cacheRead: number; cacheWrite: number };
    prices: { input: number; output: number; cacheRead: number; cacheWrite: number };
    costPerRun: number;
    basis: string;
    /** Architect only, when code review is on: the review runs included in the totals above. */
    review?: { runs: number; callsPerRun: number; perRun: { input: number; output: number; cacheRead: number; cacheWrite: number }; costPerRun: number; costUsd: number; basis: string };
  };
}

export interface Estimate {
  basis: "document" | "backlog" | "length";
  detected: { epics: number; features: number; stories: DetectedStory[]; byCategory: Record<string, number> } | null;
  stories: number;
  features: number;
  storyPoints: number;
  pdfTokens: number;
  agents: AgentEstimate[];
  totalUsd: number;
  lowUsd: number;
  highUsd: number;
  minutes: number;
  human: { hours: number; costUsd: number; weeks: number; teamSize: number };
  speedup: number;
  savingsUsd: number;
  assumptions: string[];
  breakdown: {
    reworkRate: number;
    avgWeight: number;
    categoryWeights: Record<string, number>;
    human: { points: number; hoursPerPoint: number; overhead: number; hours: number; teamSize: number; hoursPerWeek: number; weeks: number; rate: number; cost: number };
    wallClock: { stage: string; agentMinutes: number; parallel: number; minutes: number }[];
    range: { low: number; high: number };
    pdf: { pages: number; textTokens: number; perPage: number; counted: boolean };
    /** Stories the architect code-reviews (settings.codeReview) and the review runs that adds. */
    codeReview: { mode: "off" | "complex" | "all"; stories: number; runs: number };
  };
}

/** What one "run" of each role is, in plain words. */
const RUN_BASIS: Record<string, string> = {
  requirements: "1 run: reads the requirements and creates every epic, feature and story",
  architect: "1 run per feature: designs it and completes each story's technical specification",
  planner: "1 run: estimates, prioritises and plans every story",
  developer: "1 run per story, plus QA rework; tokens scale with the story's weight",
  qa: "1 run per story, plus re-tests after rework; tokens scale with the story's weight",
  writer: "1 run per story: task document and the living documents' sections",
  release: "1 run: manifest, validation, smoke tests and release notes",
};

/** Categories reviewed under codeReview "complex" (same list as review.ts — kept here so estimate.ts stays dependency-free). */
const REVIEWED_CATEGORIES = ["integration", "development", "data_migration"];

export const THINKING_PER_CALL: Record<string, number> = { low: 150, medium: 500, high: 1100, xhigh: 1800, max: 2800 };

interface Profile {
  runs: number;
  calls: number; // per run
  out: number; // per run (visible output, i.e. tool inputs)
  firstInput: number; // per run
  toolResults: number; // per run
}

export function estimateProject(i: EstimateInput): Estimate {
  const s = appSettings();
  // A PDF is read as text plus an image of each page (~1,500 tokens a page); counted exactly by the API in live mode.
  const textTokens = Math.round((i.textChars ?? i.descriptionChars) / 3.6);
  const pdfTokens = i.pdfTokens ?? (i.pdfPages ? textTokens + i.pdfPages * 1500 : textTokens + 300);
  const pages = i.pdfPages ?? 0;
  const found = i.stories?.length ? i.stories : null;
  // Without a recognisable structure: ~1 story per 900 characters of requirements text (bounded).
  const stories = found ? found.length : i.storyCount ?? Math.min(80, Math.max(1, Math.round((i.textChars ?? i.descriptionChars) / 900)));
  const features = i.features ?? Math.max(1, Math.round(stories / 2.6));
  const epics = i.epics ?? Math.max(1, Math.round(features / 2.5));
  const points = found ? found.reduce((n, s) => n + (s.points || 3), 0) : i.storyPoints ?? stories * 4;
  const reworkRate = Math.min(0.35, 0.2 * Math.max(1, i.maxRework) / 2 + 0.05);
  // Per-story effort: grows with points (sub-linearly) and with the story type.
  const sized = (found ?? Array.from({ length: stories }, () => ({ title: "", category: "development", points: points / Math.max(1, stories) }))).map((s) => {
    const w = (CATEGORY_WEIGHT[s.category] ?? 1) * Math.pow(Math.max(1, s.points || 3) / 3, 0.7);
    return { ...s, w };
  });
  if (found) found.forEach((s, k) => (s.weight = Math.round(sized[k].w * 100) / 100));
  const effort = sized.reduce((n, s) => n + s.w, 0) || stories;
  const avgW = effort / Math.max(1, stories);

  const byRole = (role: string) => i.agents.filter((a) => a.role === role);
  const profiles: Record<string, Profile> = {
    requirements: { runs: 1, calls: 3 + epics + features + Math.ceil(stories / 3), out: 2500 + stories * 950 + (epics + features) * 150, firstInput: pdfTokens + 1500, toolResults: (epics + features + stories) * 40 },
    architect: { runs: features, calls: 3 + stories / features, out: (stories / features) * 800 + 1500, firstInput: 4000, toolResults: (stories / features) * 1300 + 1500 },
    planner: { runs: 1, calls: 3 + Math.ceil(stories / 3), out: stories * 130 + 1800, firstInput: 4000, toolResults: stories * 160 + 600 },
    // One file per call; output = the files written plus summaries (reasoning tokens are added per call below).
    developer: { runs: stories * (1 + reworkRate), calls: 3 + 3.5 * avgW, out: 5000 * avgW, firstInput: 4500, toolResults: 3000 * avgW },
    qa: { runs: stories * (1 + reworkRate), calls: 3 + avgW, out: 1700 * avgW, firstInput: 4500, toolResults: 4500 * avgW },
    // The writer updates only the sections a story changes (update_document_section), so its work doesn't grow with
    // the size of the living documents.
    writer: { runs: stories, calls: 4, out: 2400, firstInput: 3500, toolResults: 1500 },
    release: { runs: 1, calls: 5 + Math.ceil(stories / 4), out: 3200 + stories * 160, firstInput: 3500, toolResults: stories * 320 + 2500 },
  };

  // Optional architect code review: a smaller QA-like run per reviewed story (diff + checklist), re-run after rework.
  const reviewMode = i.codeReview === "complex" || i.codeReview === "all" ? i.codeReview : "off";
  const reviewed = reviewMode === "off" || !byRole("architect").length ? [] : sized.filter((x) => reviewMode === "all" || REVIEWED_CATEGORIES.includes(x.category));
  const reviewW = reviewed.length ? reviewed.reduce((n, x) => n + x.w, 0) / reviewed.length : 0;
  const reviewProfile: Profile | null = reviewed.length
    ? { runs: reviewed.length * (1 + reworkRate / 2), calls: 2 + reviewW * 0.5, out: 700 * reviewW, firstInput: 4000 + 3500 * reviewW, toolResults: 300 }
    : null;

  const agents: AgentEstimate[] = [];
  for (const [role, prof] of Object.entries(profiles)) {
    const team = byRole(role);
    if (!team.length) continue;
    for (const a of team) agents.push(agentRow(a, role, prof, prof.runs / team.length));
  }
  let reviewMinutes = 0;
  if (reviewProfile) {
    const team = byRole("architect");
    for (const a of team) {
      const r = agentRow(a, "architect", reviewProfile, reviewProfile.runs / team.length);
      const row = agents.find((x) => x.agentId === a.id && x.role === "architect");
      if (!row) continue;
      reviewMinutes += r.minutes;
      row.runs = Math.round((row.runs + r.runs) * 10) / 10;
      row.calls += r.calls;
      row.inputTokens += r.inputTokens;
      row.outputTokens += r.outputTokens;
      row.cacheReadTokens += r.cacheReadTokens;
      row.cacheWriteTokens += r.cacheWriteTokens;
      row.costUsd += r.costUsd;
      row.minutes += r.minutes;
      const basis = `1 run per reviewed story (${reviewMode === "all" ? "every story" : "integration, development and data migration stories"}), plus re-reviews after rework`;
      row.detail.review = { runs: r.runs, callsPerRun: r.detail.callsPerRun, perRun: r.detail.perRun, costPerRun: r.detail.costPerRun, costUsd: r.costUsd, basis };
      row.detail.basis = `${row.detail.basis}; plus ${r.runs} code review run(s)`;
    }
  }

  function agentRow(a: Agent, role: string, prof: Profile, runs: number): AgentEstimate {
    const sys = Math.round(buildSystemPrompt(a).length / 3.6);
    const c = Math.max(1, prof.calls);
    const thinking = THINKING_PER_CALL[a.effort] ?? 600;
    const outPerRun = prof.out + thinking * c;
    const perRun = {
      input: c * 60,
      output: outPerRun,
      cacheWrite: sys + prof.firstInput + prof.out + prof.toolResults,
      cacheRead: c * (sys + prof.firstInput) + ((c - 1) * (prof.out + prof.toolResults)) / 2,
    };
    const usage = {
      input_tokens: Math.round(perRun.input * runs),
      output_tokens: Math.round(perRun.output * runs),
      cache_read_tokens: Math.round(perRun.cacheRead * runs),
      cache_write_tokens: Math.round(perRun.cacheWrite * runs),
    };
    const price = priceFor(a.model);
    const tps = price.tokensPerSecond;
    const minutesPerRun = (outPerRun / tps + c * 3) / 60;
    const roundRun = { input: Math.round(perRun.input), output: Math.round(perRun.output), cacheRead: Math.round(perRun.cacheRead), cacheWrite: Math.round(perRun.cacheWrite) };
    return {
      agentId: a.id,
      name: a.name,
      role,
      model: a.model,
      runs: Math.round(runs * 10) / 10,
      calls: Math.round(runs * c),
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_tokens,
      cacheWriteTokens: usage.cache_write_tokens,
      costUsd: costOf(a.model, usage),
      minutes: minutesPerRun * runs,
      detail: {
        effort: a.effort,
        thinkingPerCall: thinking,
        callsPerRun: Math.round(c * 10) / 10,
        systemTokens: sys,
        perRun: roundRun,
        prices: { input: price.input, output: price.output, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite },
        costPerRun: costOf(a.model, { input_tokens: roundRun.input, output_tokens: roundRun.output, cache_read_tokens: roundRun.cacheRead, cache_write_tokens: roundRun.cacheWrite }),
        basis: RUN_BASIS[role] ?? "",
      },
    };
  }

  // Wall-clock: sequential stages; architecture and delivery run in parallel lanes.
  const mins = (role: string) => agents.filter((a) => a.role === role).reduce((n, a) => n + a.minutes, 0);
  const lanes = Math.max(1, i.parallelism);
  const minutes =
    mins("requirements") +
    (mins("architect") - reviewMinutes) / Math.min(lanes, features) +
    mins("planner") +
    (mins("developer") + mins("qa") + mins("writer") + reviewMinutes) / lanes +
    mins("release");

  const wallClock = [
    { stage: "Requirements", agentMinutes: mins("requirements"), parallel: 1 },
    { stage: "Architecture", agentMinutes: mins("architect") - reviewMinutes, parallel: Math.min(lanes, features) },
    { stage: "Planning", agentMinutes: mins("planner"), parallel: 1 },
    { stage: reviewMinutes ? "Build · test · review · document" : "Build · test · document", agentMinutes: mins("developer") + mins("qa") + mins("writer") + reviewMinutes, parallel: lanes },
    { stage: "Release", agentMinutes: mins("release"), parallel: 1 },
  ].map((w) => ({ ...w, minutes: w.agentMinutes / w.parallel }));
  const totalUsd = agents.reduce((n, a) => n + a.costUsd, 0);
  // Human team: hours per point covers build + test; +35 % for analysis, planning, documentation and release.
  const hours = points * s.hoursPerStoryPoint * 1.35;
  const teamSize = 4;
  const weeks = hours / (teamSize * 32);
  const humanCost = hours * s.humanHourlyRateUsd;

  const byCategory: Record<string, number> = {};
  for (const s of found ?? []) byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;
  const mix = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} ${c.replace(/_/g, " ")}`).join(", ");
  const basis: Estimate["basis"] = i.source === "backlog" || (i.storyCount && !found) ? "backlog" : found ? "document" : "length";
  return {
    basis,
    detected: found ? { epics, features, stories: found, byCategory } : null,
    stories,
    features,
    storyPoints: points,
    pdfTokens,
    agents,
    totalUsd,
    lowUsd: totalUsd * 0.6,
    highUsd: totalUsd * 1.7,
    minutes,
    human: { hours, costUsd: humanCost, weeks, teamSize },
    speedup: minutes > 0 ? (hours * 60) / teamSize / minutes : 0,
    savingsUsd: humanCost - totalUsd,
    breakdown: {
      reworkRate,
      avgWeight: Math.round(avgW * 100) / 100,
      categoryWeights: CATEGORY_WEIGHT,
      human: { points, hoursPerPoint: s.hoursPerStoryPoint, overhead: 1.35, hours, teamSize, hoursPerWeek: 32, weeks, rate: s.humanHourlyRateUsd, cost: humanCost },
      wallClock,
      range: { low: 0.6, high: 1.7 },
      pdf: { pages, textTokens, perPage: 1500, counted: !!i.pdfTokens },
      codeReview: { mode: reviewMode, stories: reviewed.length, runs: Math.round((reviewProfile?.runs ?? 0) * 10) / 10 },
    },
    assumptions: [
      basis === "backlog"
        ? `${stories} stories in the backlog (${points} points)${mix ? `: ${mix}` : ""}.`
        : basis === "document"
          ? `${stories} stories (${points} points) found in the requirements by a local analysis: ${mix}. The analyst may split or merge them — the estimate is refined once the backlog exists.`
          : `No clear requirement structure found — ~${stories} stories estimated from the length of the requirements (≈1 per 900 characters).`,
      `Each story's work scales with its points and type (integration ×${CATEGORY_WEIGHT.integration}, configuration ×${CATEGORY_WEIGHT.configuration}).`,
      `${pages ? `PDF (${pages} page${pages === 1 ? "" : "s"})` : "Requirements"} ≈ ${pdfTokens.toLocaleString("en-US")} input tokens${i.pdfTokens ? " (counted exactly by the Claude API, free)" : " (estimated: text + ~1,500 per page; counted exactly in live mode)"}.`,
      `QA rework on ~${Math.round(reworkRate * 100)} % of stories; prompt caching on system prompts and conversation history.`,
      ...(reviewed.length ? [`Architect code review on ${reviewed.length} stor${reviewed.length === 1 ? "y" : "ies"} (${reviewMode === "all" ? "all" : "complex ones"}): one extra, smaller architect run each, plus re-reviews after rework.`] : []),
      `Human baseline: ${s.hoursPerStoryPoint} h per point + 35 % overhead, team of ${teamSize}, $${s.humanHourlyRateUsd}/h.`,
      "Wall-clock excludes time waiting at approval gates.",
    ],
  };
}
