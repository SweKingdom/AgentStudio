/**
 * Who builds an item. AgentStudio builds what it owns; an item owned by a person is never built, but AgentStudio still
 * knows it: its own stories that depend on it wait until it is delivered, and it doesn't keep the project open.
 *
 * An item given explicitly (owner "agentstudio" or "person") stays that way. Otherwise the project's rule decides —
 * "everything assigned to Philip in iteration 2026-23 tagged Zephyr" — and is checked every time, so items that are
 * imported, edited or reassigned later follow it. Without a rule, every item is AgentStudio's.
 */
import type { Project, WorkItem } from "./store.js";

/** Within a field any value matches; across fields all must match. An empty field doesn't filter. */
export interface WorkRule {
  assignees?: string[];
  iterations?: string[];
  tags?: string[];
}

type Owned = Pick<WorkItem, "owner"> & Partial<Pick<WorkItem, "assignee" | "iteration" | "sprint" | "tags">>;

/** The item's iteration: the imported one, else AgentStudio's own sprint. */
export const iterationOf = (item: Partial<Pick<WorkItem, "iteration" | "sprint">>) => item.iteration?.trim() || (item.sprint ? `Sprint ${item.sprint}` : null);

const same = (a: string | null | undefined, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

export function matchesRule(rule: WorkRule, item: Omit<Owned, "owner">) {
  const has = (list?: string[]) => !!list?.filter((x) => x.trim()).length;
  if (has(rule.assignees) && !rule.assignees!.some((a) => same(item.assignee, a))) return false;
  if (has(rule.iterations) && !rule.iterations!.some((i) => same(iterationOf(item), i))) return false;
  if (has(rule.tags) && !rule.tags!.some((t) => (item.tags ?? []).some((x) => same(x, t)))) return false;
  return true;
}

export const ruleIsSet = (rule?: WorkRule | null): rule is WorkRule => !!rule && [rule.assignees, rule.iterations, rule.tags].some((l) => l?.some((x) => x.trim()));

/** True when AgentStudio should build this item. */
export function ownedByStudio(project: Pick<Project, "settings">, item: Owned) {
  if (item.owner === "person") return false;
  if (item.owner === "agentstudio") return true;
  const rule = project.settings.workRule;
  return ruleIsSet(rule) ? matchesRule(rule, item) : true;
}

/** Who builds it, for messages: "AgentStudio", the assignee's name, or "someone else". */
export function ownerName(project: Pick<Project, "settings">, item: Owned) {
  return ownedByStudio(project, item) ? "AgentStudio" : item.assignee?.trim() || "someone else";
}

/** A rule from a request body: lists of at most 50 names of at most 120 characters, or null to remove it. */
export function cleanWorkRule(input: unknown): WorkRule | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") throw new Error("The rule must be an object with assignees, iterations and tags.");
  const list = (v: unknown, what: string) => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) throw new Error(`${what} must be a list.`);
    const out = [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))];
    if (out.length > 50 || out.some((x) => x.length > 120)) throw new Error(`${what}: at most 50 values of at most 120 characters.`);
    return out.length ? out : undefined;
  };
  const r = input as Record<string, unknown>;
  const rule: WorkRule = { assignees: list(r.assignees, "Assignees"), iterations: list(r.iterations, "Iterations"), tags: list(r.tags, "Tags") };
  return ruleIsSet(rule) ? rule : null;
}
