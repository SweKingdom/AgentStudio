export const CATEGORY: Record<string, { label: string; color: string }> = {
  development: { label: "Development", color: "#4f8ff7" },
  configuration: { label: "Configuration", color: "#22b8a7" },
  data_migration: { label: "Data migration", color: "#f2a33a" },
  script: { label: "Script", color: "#f2733a" },
  integration: { label: "Integration", color: "#a66cf5" },
  security: { label: "Security", color: "#ef5b6b" },
  reporting: { label: "Reporting", color: "#2cc2de" },
  testing: { label: "Testing", color: "#3ecf8e" },
  documentation: { label: "Documentation", color: "#9aa3b5" },
  devops: { label: "DevOps", color: "#e85aa8" },
};

export function category(c: string) {
  return CATEGORY[c] ?? { label: c, color: "#8a92a6" };
}

/** Azure DevOps work item type colours (lightened slightly for dark surfaces). */
export const TYPE: Record<string, { label: string; color: string; prefix: string }> = {
  epic: { label: "Epic", color: "#ff8a1f", prefix: "EP" },
  feature: { label: "Feature", color: "#a86fd0", prefix: "FT" },
  story: { label: "User Story", color: "#1ea7d8", prefix: "US" },
  task: { label: "Task", color: "#f2cb1d", prefix: "TK" },
  bug: { label: "Bug", color: "#e0485a", prefix: "BG" },
};

export const STATE_GROUP: Record<string, { lane: string; color: string }> = {
  New: { lane: "Backlog", color: "#8a92a6" },
  "Requires additional information": { lane: "Backlog", color: "#f5b84a" },
  "Ready for Refinement": { lane: "Backlog", color: "#a66cf5" },
  "Ready for Sprint": { lane: "Backlog", color: "#2cc2de" },
  "To Do": { lane: "To Do", color: "#9aa3b5" },
  "In Progress": { lane: "In Progress", color: "#4f8ff7" },
  "In Peer Testing": { lane: "Peer Testing", color: "#ef5b6b" },
  "Ready for UAT": { lane: "Documenting", color: "#3ecf8e" },
  "Release Ready": { lane: "Release Ready", color: "#b2a792" },
  "Smoke Testing": { lane: "Releasing", color: "#e85aa8" },
  "Deployed (Done)": { lane: "Done", color: "#3ecf8e" },
  Blocked: { lane: "Blocked", color: "#f2555a" },
  Cancelled: { lane: "Cancelled", color: "#5c6478" },
};

export const LANES = ["Backlog", "To Do", "In Progress", "Peer Testing", "Documenting", "Release Ready", "Releasing", "Done", "Blocked"];

export function stateColor(s: string) {
  return STATE_GROUP[s]?.color ?? "#8a92a6";
}

export const PHASES: { key: string; label: string; color: string }[] = [
  { key: "analysis", label: "Analysis", color: "#3987e5" },
  { key: "architecture", label: "Architecture", color: "#d95926" },
  { key: "planning", label: "Planning", color: "#199e70" },
  { key: "development", label: "Development", color: "#c98500" },
  { key: "qa", label: "Testing", color: "#d55181" },
  { key: "review", label: "Code review", color: "#1aa3b8" },
  { key: "documentation", label: "Documentation", color: "#008300" },
  { key: "release", label: "Release", color: "#9085e9" },
];

export const DOC_KINDS: Record<string, string> = {
  project_brief: "Project brief",
  solution_design: "Solution design",
  delivery_plan: "Delivery plan",
  user_manual: "User manual",
  technical_overview: "Technical overview",
  changelog: "Changelog",
  release_notes: "Release notes",
  task_doc: "Task document",
  test_report: "Test report",
};

/** Validated categorical palette (dataviz reference, dark steps) — agent identity colours in pipeline order. */
export const AGENT_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
export const AGENT_ICONS = ["ScrollText", "Compass", "ListOrdered", "Code2", "ShieldCheck", "BookOpen", "Rocket", "Sparkles", "Bot", "Brain", "Database", "Wrench", "Network", "Cpu", "Cloud", "Zap"];

/** Short role names for charts and legends (the agent's full title is shown in tooltips). */
export const ROLE_SHORT: Record<string, string> = {
  requirements: "Requirements analyst",
  architect: "Solution architect",
  planner: "Delivery planner",
  developer: "Developer",
  qa: "QA tester",
  writer: "Technical writer",
  release: "Release manager",
  specialist: "Specialist",
  orchestrator: "Orchestrator",
  human: "Product owner",
};

export function roleLabel(a: { role: string; title?: string }) {
  return ROLE_SHORT[a.role] ?? a.title ?? a.role;
}
