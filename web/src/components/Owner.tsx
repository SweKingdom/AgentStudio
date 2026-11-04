import { useEffect, useState } from "react";
import { Bot, User } from "lucide-react";
import type { WorkItem } from "../lib/api";
import { t } from "../lib/i18n";
import { Hint } from "./Hint";

/** AgentStudio builds the item, unless it's given to someone else (ownership.ts). */
export const isSomeoneElses = (it: Pick<WorkItem, "owner">) => it.owner === "person";
export const ownerLabel = (it: Pick<WorkItem, "owner" | "assignee">) => (isSomeoneElses(it) ? it.assignee?.trim() || t("Someone else") : "AgentStudio");

/** A small chip for cards and lists: only shown when someone else builds the item. */
export function OwnerChip({ item }: { item: Pick<WorkItem, "owner" | "assignee"> }) {
  if (!isSomeoneElses(item)) return null;
  return (
    <span className="chip" title={t("Someone else builds this; AgentStudio doesn't, but waits for it when its own stories depend on it.")} style={{ background: "var(--panel-3)" }}>
      <User size={11} /> {ownerLabel(item)}
    </span>
  );
}

/** Who builds the item, editable in the story drawer. */
export function OwnerField({ item, disabled, onSave }: { item: Pick<WorkItem, "owner" | "assignee">; disabled?: boolean; onSave: (patch: { owner: WorkItem["owner"]; assignee?: string | null }) => void }) {
  const [name, setName] = useState(item.assignee ?? "");
  useEffect(() => setName(item.assignee ?? ""), [item.assignee]);
  const theirs = isSomeoneElses(item);
  return (
    <Hint text={t("Who builds this item. AgentStudio only builds its own; for someone else's it waits when its own stories depend on them.")}>
      <span className="row" style={{ gap: 6 }}>
        {theirs ? <User size={13} /> : <Bot size={13} />}
        <select className="select" style={{ width: 150, height: 28, padding: "2px 8px" }} disabled={disabled} aria-label={t("Built by")} value={theirs ? "person" : "agentstudio"} onChange={(e) => onSave(e.target.value === "person" ? { owner: "person", assignee: name.trim() || null } : { owner: "agentstudio" })}>
          <option value="agentstudio">AgentStudio</option>
          <option value="person">{t("Someone else")}</option>
        </select>
        {theirs && (
          <input className="input" style={{ width: 150, height: 28 }} placeholder={t("Name (optional)")} aria-label={t("Assigned to")} maxLength={120} disabled={disabled} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if ((item.assignee ?? "") !== name.trim()) onSave({ owner: "person", assignee: name.trim() || null }); }} />
        )}
      </span>
    </Hint>
  );
}
