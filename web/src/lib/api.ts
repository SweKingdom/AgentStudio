export interface ModelPrice { id: string; label: string; input: number; output: number; cacheRead: number; cacheWrite: number; tokensPerSecond: number }
export interface RoleDef { role: string; title: string; stage: string; description: string; defaultName: string; color: string; icon: string; effort: string; knowledge: string[]; tools: string[]; maxTurns: number }
export interface AppSettings {
  mode: "live" | "simulation"; currency: "USD" | "EUR"; usdToEur: number; humanHourlyRateUsd: number; hoursPerStoryPoint: number;
  defaultParallelism: number; defaultBudgetUsd: number; defaultGates: boolean; maxRework: number; refusalFallback: boolean; simulationSpeed: number;
  dailyLimitUsd: number; monthlyLimitUsd: number; autoResumeLimits: boolean; backend: "auto" | "api" | "subscription";
}
export interface Meta {
  mode: "live" | "simulation"; hasApiKey: boolean; backend: "api" | "subscription";
  globalPause: { reason: string; kind: string; since: string; resumeAt: string | null; autoResume: boolean; projects: string[]; jobs: unknown[] } | null;
  spend: { today: number; month: number; dailyLimitUsd: number; monthlyLimitUsd: number }; settings: AppSettings; models: ModelPrice[]; roles: RoleDef[];
  pipelineRoles: string[]; tools: { name: string; label: string; description: string }[]; categories: string[]; states: string[];
  pseudoAgents: { id: string; name: string; color: string; icon: string; role: string; title: string }[];
}
export interface AgentStats { calls: number; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; busyMs: number; runs: number; active: number; itemsTouched: number; messagesSent: number; projects: number }
export interface Agent {
  id: string; name: string; role: string; title: string; description: string; system_prompt: string; model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max"; color: string; icon: string; knowledge: string[]; custom_knowledge: string; name_story?: string; tools: string[]; config: AgentConfig;
  max_turns: number; is_builtin: boolean; enabled: boolean; version: number; created_at: string; updated_at: string; promptTokens: number; stats: AgentStats;
}
export interface AgentDetail extends Agent { systemPrompt: string; recentRuns: Run[] }
export interface Run { id: string; project_id: string; agent_id: string; stage: string; item_id: string | null; status: string; turns: number; agent_version?: number; kind?: string; summary: string | null; error: string | null; started_at: string; ended_at: string | null; project_key?: string; item_code?: string }
export interface Knowledge { id: string; title: string; summary: string; content: string; tokens: number; custom: boolean }
export interface StageState { key: string; role: string; label: string; status: "pending" | "running" | "done" | "skipped" | "awaiting_approval" | "failed"; gate?: boolean }
export interface ProjectSettings { gates: boolean; parallelism: number; budgetUsd: number; maxRework: number; repo?: { url: string; branch: string; push?: boolean } | null; codeReview?: "off" | "complex" | "all"; checks?: Partial<ChecksSettings>; ado?: AdoConfig | null }
/** Azure DevOps project the backlog syncs to. The token lives only in .env (AZURE_DEVOPS_PAT). */
export interface AdoConfig { orgUrl: string; project: string; areaPath?: string; iterationRoot?: string; stateMode: "same" | "agile" }
export interface RepoInfo { url: string; branch: string; push?: boolean; provider: "github" | "azure" | "gitlab" | "bitbucket" | "other"; name: string; webUrl: string | null }
export interface Commit { hash: string; short: string; author: string; email: string; date: string; subject: string; files: { path: string; added: number; removed: number }[]; tags: string[]; branches: string[]; parents?: string[] }
export interface BranchInfo { name: string; head: string; date: string; subject: string; base: boolean; merged: boolean; ahead: number; active: boolean }
/** A command the project must pass (run in the story's worktree); the team sets defaults, a project can override. */
export interface CheckCommand { name: string; command: string }
export interface ChecksSettings { commands: CheckCommand[]; timeoutMinutes: number; install: string }
/** A reusable project setup: team roles and run settings. */
export interface NetworkTemplate { id: string; name: string; description: string; builtin: boolean; roles: string[]; settings: { gates: boolean; parallelism: number; maxRework: number; budgetUsd: number } }
export type AgentConfig = Record<string, never>;
export interface Project {
  id: string; key: string; name: string; description: string; status: string; stage: string | null; stages: StageState[];
  pdf_file: string | null; pdf_name: string | null; pdf_pages: number | null; pdf_tokens: number | null; agent_ids: string[];
  settings: ProjectSettings; estimate: Estimate | null; mode: "live" | "simulation"; error: string | null; created_at: string;
  started_at: string | null; finished_at: string | null; running: boolean;
  counts: { epics: number; features: number; stories: number; done: number; releaseReady: number; inProgress: number; blocked: number; points: number };
  costUsd: number; tokens: number; openQuestions: number; install: string | null; undelivered: { id: string; code: string; title: string; state: string; reason: string }[]; activeRuns: { agent_id: string; item_id: string | null; stage: string }[];
  pipelineRunning: boolean; pausing: boolean; jobs: { key: string; label: string; itemId: string | null }[]; checks: CheckCommand[]; repoInfo: RepoInfo | null;
  liveEstimate?: Estimate | null;
}
export interface AgentEstimate { agentId: string; name: string; role: string; model: string; runs: number; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; minutes: number;
  detail: { effort: string; thinkingPerCall: number; callsPerRun: number; systemTokens: number; perRun: { input: number; output: number; cacheRead: number; cacheWrite: number }; prices: { input: number; output: number; cacheRead: number; cacheWrite: number }; costPerRun: number; basis: string; review?: { runs: number; callsPerRun: number; perRun: { input: number; output: number; cacheRead: number; cacheWrite: number }; costPerRun: number; costUsd: number; basis: string } } }
export interface Estimate {
  basis: "document" | "backlog" | "length";
  detected: { epics: number; features: number; stories: { title: string; category: string; points: number; pointsWhy?: string[]; weight?: number; feature?: string; epic?: string }[]; byCategory: Record<string, number> } | null;
  breakdown: {
    reworkRate: number; avgWeight: number; categoryWeights: Record<string, number>;
    human: { points: number; hoursPerPoint: number; overhead: number; hours: number; teamSize: number; hoursPerWeek: number; weeks: number; rate: number; cost: number };
    wallClock: { stage: string; agentMinutes: number; parallel: number; minutes: number }[];
    range: { low: number; high: number };
    pdf: { pages: number; textTokens: number; perPage: number; counted: boolean };
    /** Optional on estimates saved before code review existed. */
    codeReview?: { mode: "off" | "complex" | "all"; stories: number; runs: number };
  };
  stories: number; features: number; storyPoints: number; pdfTokens: number; agents: AgentEstimate[];
  totalUsd: number; lowUsd: number; highUsd: number; minutes: number; human: { hours: number; costUsd: number; weeks: number; teamSize: number };
  speedup: number; savingsUsd: number; assumptions: string[];
}
export interface Phase { item_id: string; phase: string; agent_id: string; iteration: number; started_at: string; ended_at: string | null; outcome: string | null }
export interface WorkItem {
  id: string; project_id: string; code: string; type: "epic" | "feature" | "story" | "task" | "bug"; parent_id: string | null; title: string;
  category: string; state: string; priority: number | null; moscow: string | null; story_points: number | null; wsjf: number | null;
  sprint: number | null; rank: number | null; user_story: string; background: string; business_rules: string; dependencies: string;
  out_of_scope: string; acceptance_criteria: string; tech_spec: string; how_to_test: string; manual_steps: string; solution_components: string;
  tags: string[]; depends_on: string[]; assigned_agent_id: string | null; rework_count: number; branch?: string | null; pr_url?: string | null; ado_id?: number | null; human_hours: number | null; created_by: string | null;
  created_at: string; updated_at: string; costUsd?: number; phases?: Phase[]; tests?: { pass: number; fail: number; blocked: number } | null; activeAgent?: string | null; openQuestions?: number;
}
export interface Message { id: number; project_id: string; from_agent_id: string; to_agent_id: string; item_id: string | null; kind: string; content: string; created_at: string; item_code?: string }
export interface Activity { id: number; project_id: string | null; agent_id: string | null; run_id: string | null; item_id: string | null; type: string; summary: string; detail: string | null; created_at: string; item_code?: string; project_key?: string }
export interface TestResult { id: number; item_id: string; kind: string; ac_ref: string; result: "pass" | "fail" | "blocked"; notes: string; iteration: number; agent_id: string; created_at: string; item_code?: string }
export interface ItemDetail extends Omit<WorkItem, "tests" | "phases"> {
  parent: { id: string; code: string; title: string; type: string } | null;
  children: { id: string; code: string; title: string; type: string; state: string; category: string }[];
  phases: Phase[]; tests: TestResult[]; messages: Message[]; activity: Activity[];
  files: { path: string; agent_id: string; bytes: number; updated_at: string }[];
  documents: { id: string; kind: string; title: string; version: number; updated_at: string }[];
  questions: Question[]; cost: { costUsd: number; calls: number; inputTokens: number; outputTokens: number };
  comments: Comment[]; bugs: { id: string; code: string; title: string; state: string }[]; busy: boolean;
  costByAgent: { agent_id: string; costUsd: number; calls: number }[];
}
export interface Question { id: number; project_id: string; item_id: string | null; question: string; answer: string | null; asked_by: string; created_at: string; answered_at: string | null; item_code?: string }
export interface DocMeta { id: string; kind: string; title: string; version: number; agent_id: string | null; item_id: string | null; updated_at: string; item_code?: string }
export interface Doc extends DocMeta { content: string; created_at: string }

/** Base URL for images inside a story's documents (test evidence lives in docs/stories/<code>/evidence). */
export function storyAssetBase(projectId: string, code: string) {
  return `/api/projects/${projectId}/raw?path=${encodeURIComponent(`docs/stories/${code}/`)}`;
}
export interface FileMeta { path: string; agent_id?: string; item_id?: string; item_code?: string; bytes?: number; updated_at?: string }
export interface GraphNode { id: string; name: string; role: string; title: string; color: string; icon: string; model: string | null; costUsd: number; calls: number; tokens: number; active: number; activeStage: string | null; activeItem: string | null }
export interface GraphEdge { from: string; to: string; count: number; last: string; kinds: string[] }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }
export interface Release { id: string; project_id: string; version: string; notes: string; status: string; validation: string | null; created_at: string }
export interface ItemMetrics { id: string; code: string; title: string; category: string; state: string; points: number | null; rework: number; humanHours: number | null; seconds: Record<string, number>; leadTimeSeconds: number | null; phases: Phase[] }
export interface Costs {
  totals: { costUsd: number; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; busyMs: number; simulatedUsd: number };
  byAgent: { agent_id: string; costUsd: number; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; busyMs: number; runs: number; items: number }[];
  byProject: { project_id: string; key: string; name: string; costUsd: number; calls: number }[];
  byItem: { item_id: string; code: string; title: string; type: string; category: string; points: number | null; costUsd: number; calls: number; project_key: string }[];
  byItemAgent: { item_id: string; agent_id: string; costUsd: number }[];
  byModel: { model: string; costUsd: number; calls: number }[];
  byStage: { stage: string; costUsd: number; calls: number; busyMs: number }[];
  timeline: { bucket: string; agent_id: string; costUsd: number; calls: number }[];
  /** Every bucket start (ISO), gaps included, and the bucket size in seconds. */
  timelineBuckets: string[];
  timelineStep: number;
}
export interface Comment { id: number; item_id: string; author_id: string; content: string; created_at: string }
export interface ChatMessage { id: number; agent_id: string; project_id: string | null; sender: "human" | "agent"; content: string; created_at: string }
export interface AgentVersion {
  version: number; changed: string[]; note: string | null; created_at: string; runs: number; costUsd: number; avgTurns: number; reworkRate: number | null;
  snapshot: Pick<Agent, "name" | "title" | "description" | "system_prompt" | "model" | "effort" | "knowledge" | "custom_knowledge" | "tools" | "max_turns">;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(`/api${url}`, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  // Session missing or expired: the app shell listens for this and shows the sign-in page (lib/auth.ts).
  // /auth/* answers 401 for a wrong password too — that's the login form's business, not a sign-out.
  if (res.status === 401 && !url.startsWith("/auth/")) window.dispatchEvent(new Event("arm:unauthorized"));
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body),
  del: <T>(url: string) => request<T>("DELETE", url),
};
