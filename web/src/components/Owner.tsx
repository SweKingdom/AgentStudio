import { useEffect, useState } from "react";
import { Bot, Filter, User } from "lucide-react";
import type { WorkItem } from "../lib/api";
import { t } from "../lib/i18n";
import { Hint } from "./Hint";

type Owned = Pick<WorkItem, "owner" | "assignee"> & { ours?: boolean };

/** Not given to anyone by hand, and outside AgentStudio's rule (from the items list): AgentStudio doesn't build it. */
export const outsideRule = (it: Pick<WorkItem, "owner"> & { ours?: boolean }) => it.owner == null && it.ours === false;
/** AgentStudio doesn't build it: given to someone else by hand, or outside AgentStudio's rule. */
export const isSomeoneElses = (it: Pick<WorkItem, "owner"> & { ours?: boolean }) => it.owner === "person" || outsideRule(it);
/** Who builds it: AgentStudio, the person it was given to, or nobody yet because the rule leaves it out. */
export const ownerLabel = (it: Owned) => (it.owner === "person" ? it.assignee?.trim() || t("Someone else") : outsideRule(it) ? t("Not in the rule") : "AgentStudio");

/** A small chip for cards and lists: only shown when AgentStudio doesn't build the item. */
export function OwnerChip({ item }: { item: Owned }) {
  if (!isSomeoneElses(item)) return null;
  const rule = outsideRule(item);
  return (
    <span className="chip" title={rule ? t("Outside AgentStudio's rule, so AgentStudio doesn't build it. Change the rule in the Backlog, or give it to AgentStudio.") : t("Someone else builds this; AgentStudio doesn't, but waits for it when its own stories depend on it.")} style={{ background: "var(--panel-3)" }}>
      {rule ? <Filter size={11} /> : <User size={11} />} {ownerLabel(item)}
    </span>
  );
}

/** Who the item is assigned to and who builds it, edited separately in the story drawer: a story can be assigned to
 *  Anna and still be built by AgentStudio (that's what a rule like "assigned to Anna" is for). */
export function OwnerField({ item, rule, disabled, onSave }: { item: Owned; rule: boolean; disabled?: boolean; onSave: (patch: { owner?: WorkItem["owner"]; assignee?: string | null }) => void }) {
  const [name, setName] = useState(item.assignee ?? "");
  useEffect(() => setName(item.assignee ?? ""), [item.assignee]);
  const value = item.owner ?? (rule ? "rule" : "agentstudio");
  const who = item.assignee?.trim();
  return (
    <span className="row" style={{ gap: 6 }}>
      <Hint text={t("Who the story is assigned to, as on your team's board. It doesn't decide who builds it: that's Built by.")}>
        <span className="row" style={{ gap: 6 }}>
          <User size={13} />
          <input className="input" style={{ width: 150, height: 28 }} placeholder={t("Assigned to")} aria-label={t("Assigned to")} maxLength={120} disabled={disabled} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if ((item.assignee ?? "") !== name.trim()) onSave({ assignee: name.trim() || null }); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        </span>
      </Hint>
      <Hint text={t("Who builds it. AgentStudio builds its own; someone else's it never builds, but its own stories wait for them. With a rule, Follow the rule lets the rule decide.")}>
        <span className="row" style={{ gap: 6 }}>
          {isSomeoneElses(item) ? <User size={13} /> : <Bot size={13} />}
          <select className="select" style={{ width: 210, height: 28, padding: "2px 8px" }} disabled={disabled} aria-label={t("Built by")} value={value} onChange={(e) => onSave({ owner: e.target.value === "rule" ? null : (e.target.value as "agentstudio" | "person") })}>
            {rule && <option value="rule">{item.ours === false ? t("Follow the rule (not built)") : t("Follow the rule (AgentStudio)")}</option>}
            <option value="agentstudio">{t("Built by AgentStudio")}</option>
            <option value="person">{who ? t("Built by {n}, not AgentStudio", { n: who }) : t("Built by someone else")}</option>
          </select>
        </span>
      </Hint>
    </span>
  );
}
