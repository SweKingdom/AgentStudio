import { all, get, insert, now, parseJson, run, uid, update } from "../db.js";
import { ROLES, PIPELINE_ROLES, type Role } from "./roles.js";

/** Role-specific settings. Release agent: where and how to deploy. */
export interface AgentConfig {
  targetOrg?: string;
  deployMode?: "validate" | "deploy";
  testLevel?: "RunLocalTests" | "RunSpecifiedTests" | "NoTestRun" | "RunAllTestsInOrg";
}

export interface Agent {
  id: string;
  name: string;
  role: Role;
  title: string;
  description: string;
  system_prompt: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  color: string;
  icon: string;
  knowledge: string[];
  /** Agent-specific skills/knowledge written by the user; always injected into the prompt. */
  custom_knowledge: string;
  /** Why this name (myth + how it fits the role). */
  name_story: string;
  tools: string[];
  config: AgentConfig;
  max_turns: number;
  is_builtin: boolean;
  enabled: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

type AgentRow = Omit<Agent, "knowledge" | "tools" | "is_builtin" | "enabled" | "config"> & {
  knowledge: string;
  tools: string;
  config: string;
  is_builtin: number;
  enabled: number;
};

function hydrate(r: AgentRow): Agent {
  return {
    ...r,
    knowledge: parseJson(r.knowledge, []),
    tools: parseJson(r.tools, []),
    config: parseJson(r.config, {}),
    is_builtin: Boolean(r.is_builtin),
    enabled: Boolean(r.enabled),
  };
}

export function listAgents(): Agent[] {
  return all<AgentRow>("SELECT * FROM agents ORDER BY is_builtin DESC, created_at").map(hydrate);
}

export function getAgent(id: string): Agent | undefined {
  const r = get<AgentRow>("SELECT * FROM agents WHERE id = ?", id);
  return r ? hydrate(r) : undefined;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

export function defaultAgentFor(role: Role, overrides: Partial<Agent> = {}): Agent {
  const def = ROLES[role];
  const ts = now();
  return {
    id: uid("agt"),
    name: def.defaultName,
    role,
    title: def.title,
    description: def.description,
    system_prompt: def.prompt,
    model: DEFAULT_MODEL,
    effort: def.effort,
    color: def.color,
    icon: def.icon,
    knowledge: def.knowledge,
    custom_knowledge: "",
    name_story: def.nameStory,
    tools: def.tools,
    config: role === "release" ? { deployMode: "validate", testLevel: "RunLocalTests" } : {},
    max_turns: def.maxTurns,
    is_builtin: false,
    enabled: true,
    version: 1,
    created_at: ts,
    updated_at: ts,
    ...overrides,
  };
}

/** Fields that define how an agent behaves — any change to them creates a new version. */
export const VERSIONED_FIELDS = ["name", "name_story", "title", "description", "system_prompt", "model", "effort", "knowledge", "custom_knowledge", "tools", "max_turns", "config"] as const;
type Versioned = Pick<Agent, (typeof VERSIONED_FIELDS)[number]>;

function snapshot(a: Agent): Versioned {
  return Object.fromEntries(VERSIONED_FIELDS.map((k) => [k, a[k]])) as Versioned;
}

function recordVersion(a: Agent, changed: string[], note?: string) {
  insert("agent_versions", {
    agent_id: a.id,
    version: a.version,
    snapshot: snapshot(a),
    changed,
    note: note ?? null,
    created_at: now(),
  });
}

export function createAgent(a: Agent) {
  insert("agents", { ...a, version: 1 });
  const saved = getAgent(a.id)!;
  recordVersion(saved, ["created"], "Created");
  return saved;
}

export function updateAgent(id: string, patch: Partial<Agent>, note?: string) {
  const { id: _id, created_at: _c, is_builtin: _b, version: _v, ...rest } = patch;
  const before = getAgent(id);
  if (!before) return undefined;
  const changed = VERSIONED_FIELDS.filter((k) => rest[k] !== undefined && JSON.stringify(rest[k]) !== JSON.stringify(before[k]));
  update("agents", id, { ...rest, ...(changed.length ? { version: before.version + 1 } : {}), updated_at: now() });
  const after = getAgent(id)!;
  if (changed.length) recordVersion(after, changed, note);
  return after;
}

export interface AgentVersion {
  version: number;
  snapshot: Versioned;
  changed: string[];
  note: string | null;
  created_at: string;
}

export function listVersions(agentId: string): AgentVersion[] {
  return all<{ version: number; snapshot: string; changed: string; note: string | null; created_at: string }>(
    "SELECT version, snapshot, changed, note, created_at FROM agent_versions WHERE agent_id = ? ORDER BY version DESC",
    agentId,
  ).map((r) => ({ ...r, snapshot: parseJson(r.snapshot, {} as Versioned), changed: parseJson(r.changed, []) }));
}

export function restoreVersion(agentId: string, version: number) {
  const v = listVersions(agentId).find((x) => x.version === version);
  if (!v) return undefined;
  return updateAgent(agentId, v.snapshot as Partial<Agent>, `Restored from v${version}`);
}

export function deleteAgent(id: string) {
  run("DELETE FROM agents WHERE id = ?", id);
}

export function resetAgent(id: string) {
  const a = getAgent(id);
  if (!a) return undefined;
  const def = ROLES[a.role];
  return updateAgent(id, {
    system_prompt: def.prompt,
    knowledge: def.knowledge,
    tools: def.tools,
    effort: def.effort,
    max_turns: def.maxTurns,
    description: def.description,
    title: def.title,
  }, "Reset to role defaults");
}

/** Seed the default delivery team on first start. */
/** Tools added to a role after agents were created; existing built-in agents receive them once (as a new version). */
const ADDED_TOOLS: Partial<Record<Role, string[]>> = {
  requirements: ["describe_object"],
  architect: ["describe_object", "run_soql", "update_document_section", "submit_code_review"],
  writer: ["update_document_section"],
  developer: ["describe_object", "run_soql", "deploy_story"],
  qa: ["capture_evidence", "write_document", "read_document", "run_apex_tests", "run_soql", "capture_screenshot"],
  release: ["run_soql", "run_anonymous_apex", "update_document_section"],
};

/** Names before the Iberian-mythology rename (agents still carrying them are renamed once, as a restorable version). */
const PREVIOUS_NAMES: Partial<Record<Role, string>> = { requirements: "Iris", architect: "Atlas", planner: "Nova", developer: "Forge", qa: "Rudolf", writer: "Quill", release: "Helm" };

/** Commit email for an agent: accents folded, safe characters only (e.g. "Cuélebre" → cuelebre@siroccoarm.local). */
export function agentEmail(name: string) {
  const local = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
  return `${local || "agent"}@siroccoarm.local`;
}

export function seedAgents() {
  for (const a of listAgents().filter((x) => x.is_builtin)) {
    const def = ROLES[a.role];
    if (def && PREVIOUS_NAMES[a.role] && a.name === PREVIOUS_NAMES[a.role]) {
      updateAgent(
        a.id,
        { name: def.defaultName, name_story: def.nameStory, system_prompt: a.system_prompt.replace("{{name}} 🦌", "{{name}} 🐉") },
        `Renamed ${a.name} → ${def.defaultName} (Iberian mythology)`,
      );
    } else if (def && !a.name_story && a.name === def.defaultName && def.nameStory) {
      updateAgent(a.id, { name_story: def.nameStory }, "Added the story behind the name");
    }
  }
  for (const a of listAgents().filter((x) => x.is_builtin)) {
    const missing = (ADDED_TOOLS[a.role] ?? []).filter((t) => !a.tools.includes(t));
    if (missing.length) updateAgent(a.id, { tools: [...a.tools, ...missing] }, `Added tools: ${missing.join(", ")}`);
  }
  // Agents created before versioning existed get their current state as the baseline version.
  for (const a of listAgents()) {
    if (!get("SELECT 1 FROM agent_versions WHERE agent_id = ?", a.id)) recordVersion(a, ["created"], "Baseline");
  }
  const count = get<{ n: number }>("SELECT COUNT(*) AS n FROM agents")!.n;
  if (count > 0) return;
  for (const role of PIPELINE_ROLES) {
    createAgent(defaultAgentFor(role, { id: `agt_${role}`, is_builtin: true }));
  }
}

export function renderPrompt(a: Agent) {
  return a.system_prompt.replaceAll("{{name}}", a.name);
}
