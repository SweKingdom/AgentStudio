/**
 * The saved mapping between an Azure DevOps project and AgentStudio: worked out once from the project's own process
 * (its work item types, their states with Azure DevOps' state categories, and their fields), saved on the project, and
 * then used by every import, refresh and write-back — so neither the code nor a model has to work it out again, and
 * you can see and correct it (Import from Azure DevOps → How it maps).
 */
import { adoFetch, boardState, ok, type AdoConfig } from "./ado.js";
import type { WorkItem } from "./store.js";

/** What an Azure DevOps state means to AgentStudio when it imports an item. */
export type StateCategory = "new" | "started" | "done" | "dropped";
export const STATE_CATEGORIES: StateCategory[] = ["new", "started", "done", "dropped"];

/** Which Azure DevOps field each piece of a story comes from (reference names such as System.Title). */
export interface FieldMap {
  title: string;
  description: string;
  acceptance: string;
  points: string;
  assignee: string;
  iteration: string;
  tags: string;
}

export interface AdoMapping {
  fields: FieldMap;
  /** Azure DevOps work item type → AgentStudio type. Types not listed aren't imported. */
  types: Record<string, WorkItem["type"]>;
  /** Azure DevOps state → what it means on import. States not listed fall back to their names. */
  states: Record<string, StateCategory>;
  /** AgentStudio state → the board state a story is moved to when states are written back. */
  writeBack: Record<string, string>;
  /** Every state of the story type on the board, in workflow order (the choices for write-back). */
  boardStates: string[];
  computedAt: string;
}

export const DEFAULT_FIELDS: FieldMap = {
  title: "System.Title",
  description: "System.Description",
  acceptance: "Microsoft.VSTS.Common.AcceptanceCriteria",
  points: "Microsoft.VSTS.Scheduling.StoryPoints",
  assignee: "System.AssignedTo",
  iteration: "System.IterationPath",
  tags: "System.Tags",
};

export const DEFAULT_TYPES: Record<string, WorkItem["type"]> = { Epic: "epic", Feature: "feature", "User Story": "story", "Product Backlog Item": "story", Requirement: "story", Task: "task", Bug: "bug" };

/** AgentStudio's states whose progress is written back (the rest leave the board as it is). */
export const WRITE_BACK_STATES = ["In Progress", "In Peer Testing", "Ready for UAT", "In Review", "Changes Requested", "Release Ready", "Smoke Testing", "Deployed (Done)"];

/** By name, for states the saved mapping doesn't know (any process). */
export function categoryByName(state: string): StateCategory {
  if (/^(done|closed|resolved|completed)$/i.test(state)) return "done";
  if (/^(removed|cut)$/i.test(state)) return "dropped";
  if (/^(active|committed|in progress|doing|design|develop|development|test|testing|in review)$/i.test(state)) return "started";
  return "new";
}

export const categoryOf = (state: string, m?: AdoMapping | null): StateCategory => m?.states[state] ?? categoryByName(state);

/** Azure DevOps' own state categories, as import categories. */
const FROM_CATEGORY: Record<string, StateCategory> = { Proposed: "new", InProgress: "started", Resolved: "done", Completed: "done", Removed: "dropped" };

/** The mapping without asking Azure DevOps: the standard field names and type names, states by name. */
export function defaultMapping(): AdoMapping {
  return { fields: { ...DEFAULT_FIELDS }, types: { ...DEFAULT_TYPES }, states: {}, writeBack: {}, boardStates: [], computedAt: new Date().toISOString() };
}

/** Works the mapping out from the project's process: one call for every work item type with its states and fields. */
export async function computeMapping(cfg: AdoConfig): Promise<AdoMapping> {
  const r = await adoFetch(cfg, "GET", `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_apis/wit/workitemtypes?api-version=7.1`);
  if (!ok(r)) throw new Error(`Couldn't read the work item types: ${r.message}`);
  const all: { name: string; states?: { name: string; category: string }[]; fields?: { referenceName: string }[] }[] = r.body?.value ?? [];
  const m = defaultMapping();
  const present = all.filter((t) => DEFAULT_TYPES[t.name]);
  m.types = Object.fromEntries(present.map((t) => [t.name, DEFAULT_TYPES[t.name]]));
  for (const t of present) for (const s of t.states ?? []) m.states[s.name] ??= FROM_CATEGORY[s.category] ?? categoryByName(s.name);
  // The story type decides the effort field (Agile: Story Points; Scrum: Effort; CMMI: Size) and the write-back states.
  const story = present.find((t) => DEFAULT_TYPES[t.name] === "story");
  const has = (f: string) => !!story?.fields?.some((x) => x.referenceName === f);
  if (story?.fields?.length) m.fields.points = ["Microsoft.VSTS.Scheduling.StoryPoints", "Microsoft.VSTS.Scheduling.Effort", "Microsoft.VSTS.Scheduling.Size"].find(has) ?? m.fields.points;
  const storyStates = (story?.states ?? []).map((s) => ({ name: s.name, category: s.category }));
  m.boardStates = storyStates.map((s) => s.name);
  for (const st of WRITE_BACK_STATES) {
    const target = boardState(st, storyStates);
    if (target) m.writeBack[st] = target;
  }
  return m;
}

/** A mapping from a request (edited in the import dialog), checked: known categories and types, field names only. */
export function cleanMapping(input: unknown, base: AdoMapping = defaultMapping()): AdoMapping {
  if (!input || typeof input !== "object") throw new Error("The mapping must be an object.");
  const o = input as Partial<AdoMapping>;
  const ref = (v: unknown, fallback: string) => {
    const s = String(v ?? "").trim();
    if (!s) return fallback;
    if (!/^[A-Za-z][\w.]{1,120}$/.test(s)) throw new Error(`"${s.slice(0, 60)}" isn't an Azure DevOps field name (like System.Title).`);
    return s;
  };
  const fields = Object.fromEntries((Object.keys(DEFAULT_FIELDS) as (keyof FieldMap)[]).map((k) => [k, ref(o.fields?.[k], base.fields[k])])) as unknown as FieldMap;
  const types: Record<string, WorkItem["type"]> = {};
  for (const [k, v] of Object.entries(o.types ?? base.types)) {
    if (!["epic", "feature", "story", "task", "bug"].includes(v)) throw new Error(`Unknown type for ${k}: ${v}`);
    types[k.trim().slice(0, 80)] = v;
  }
  const states: Record<string, StateCategory> = {};
  for (const [k, v] of Object.entries(o.states ?? base.states)) {
    if (!STATE_CATEGORIES.includes(v)) throw new Error(`Unknown meaning for the state ${k}: ${v}`);
    states[k.trim().slice(0, 80)] = v;
  }
  const writeBack: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.writeBack ?? base.writeBack)) {
    if (!WRITE_BACK_STATES.includes(k)) throw new Error(`AgentStudio has no state called ${k}.`);
    if (v && String(v).trim()) writeBack[k] = String(v).trim().slice(0, 80);
  }
  return { fields, types, states, writeBack, boardStates: (o.boardStates ?? base.boardStates).map(String).slice(0, 50), computedAt: base.computedAt };
}

/** The fields an import reads: the mapped ones and what AgentStudio always needs. Nothing else is downloaded. */
export const fieldsToRead = (m: AdoMapping) => [...new Set(["System.Id", "System.WorkItemType", "System.State", "System.Parent", "System.Rev", ...Object.values(m.fields)])];
