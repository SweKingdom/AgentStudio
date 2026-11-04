/**
 * Who builds an item. AgentStudio builds what it owns; an item owned by a person is never built, but AgentStudio still
 * knows it: its own stories that depend on it wait until it is delivered, and it doesn't keep the project open.
 */
import type { Project, WorkItem } from "./store.js";

/** True when AgentStudio should build this item. Unset means AgentStudio, as before owners existed. */
export function ownedByStudio(_project: Pick<Project, "settings">, item: Pick<WorkItem, "owner">) {
  return item.owner !== "person";
}

/** Who builds it, for messages: "AgentStudio", the assignee's name, or "someone else". */
export function ownerName(project: Pick<Project, "settings">, item: Pick<WorkItem, "owner" | "assignee">) {
  return ownedByStudio(project, item) ? "AgentStudio" : item.assignee?.trim() || "someone else";
}
