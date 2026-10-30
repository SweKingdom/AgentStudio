import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GripVertical, Play, Plus, RotateCcw } from "lucide-react";
import { api, type Project, type WorkItem } from "../../lib/api";
import { toast } from "../../lib/toast";
import { Hint } from "../../components/Hint";
import { NewItemModal, StartWorkModal } from "../../components/Modals";
import { useFresh } from "../../lib/motion";
import { CATEGORY, LANES, STATE_GROUP, category } from "../../lib/constants";
import { useAgentLookup } from "../../lib/queries";
import { money } from "../../lib/format";
import { AgentAvatar, Empty, TestBadge, TypeIcon } from "../../components/ui";
import { useItems, useOpenItem } from "./hooks";

export function WorkCard({ it, onOpen, onDragStart, onDragEnd, onDropOn, dragging, changed }: { it: WorkItem; onOpen: () => void; onDragStart?: () => void; onDragEnd?: () => void; onDropOn?: () => void; dragging?: boolean; changed?: boolean }) {
  const agent = useAgentLookup();
  const c = category(it.category);
  const active = it.activeAgent ? agent(it.activeAgent) : null;
  const [over, setOver] = useState(false);
  return (
    <div
      className={`wcard ${changed ? "flash" : "fadein"} ${active ? "active" : ""} ${dragging ? "dragging" : ""} ${over ? "drop-before" : ""}`}
      style={{ ["--cat" as string]: c.color }}
      onClick={onOpen}
      draggable={!active && !!onDragStart}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.id); onDragStart?.(); }}
      onDragEnd={() => onDragEnd?.()}
      onDragOver={(e) => { if (onDropOn) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { if (onDropOn) { e.preventDefault(); e.stopPropagation(); setOver(false); onDropOn(); } }}
      title={active ? `${active.name} is working on it — it can't be moved right now` : "Click to open · drag within the column to re-prioritise, or onto In Progress to start work"}
    >
      <div className="row" style={{ gap: 6 }}>
        {onDragStart && !active && <GripVertical size={12} className="grip" />}
        <TypeIcon type={it.type} size={13} />
        <span className="mono tiny" style={{ color: "var(--text-2)" }}>{it.code}</span>
        <span className="chip" style={{ background: `color-mix(in srgb, ${c.color} 15%, transparent)`, color: c.color, height: 18, fontSize: 10.5 }}>{c.label}</span>
        <span className="spacer" />
        {it.story_points != null && <span className="tiny strong" style={{ background: "var(--panel-3)", borderRadius: 10, padding: "0 6px" }}>{it.story_points}</span>}
      </div>
      <div className="wcard-title">{it.title}</div>
      <div className="wcard-meta">
        {it.sprint != null && <span>S{it.sprint}</span>}
        {it.moscow && <span>· {it.moscow}</span>}
        <TestBadge t={it.tests} />
        {it.rework_count > 0 && <span style={{ color: "var(--bad)" }} className="row"><RotateCcw size={11} />{it.rework_count}</span>}
        {(it.openQuestions ?? 0) > 0 && (
          <span className="chip" title="Held: it won't advance until its questions are answered" style={{ background: "color-mix(in srgb, var(--warn) 18%, transparent)", color: "var(--warn)", height: 18 }}>❓ {it.openQuestions} open</span>
        )}
        <span className="spacer" />
        {(it.costUsd ?? 0) > 0 && <span className="num">{money(it.costUsd)}</span>}
        {active && <AgentAvatar agent={active} size={20} active />}
      </div>
      {active && <div className="tiny" style={{ color: active.color }}>● {active.name} is working on it</div>}
    </div>
  );
}

export default function Board({ p }: { p: Project }) {
  const { data: items } = useItems(p.id);
  const open = useOpenItem();
  const qc = useQueryClient();
  const [cat, setCat] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [overLane, setOverLane] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const changed = useFresh((items ?? []).map((i) => `${i.id}:${i.state}`), 2600);

  const refresh = () => qc.invalidateQueries({ queryKey: ["items", p.id] });
  const [starting, setStarting] = useState<WorkItem | null>(null);
  const laneOf = (it: WorkItem) => STATE_GROUP[it.state]?.lane ?? "Backlog";
  const startable = (it: WorkItem) => ["Backlog", "To Do", "Blocked"].includes(laneOf(it)) && it.state !== "Cancelled" && !(it.openQuestions ?? 0);
  const dragged = items?.find((i) => i.id === drag);
  /** The only column change a person can make: drop on In Progress = start work (agents run every step in order). */
  const canDropOn = (lane: string) => !!dragged && lane === "In Progress" && startable(dragged);
  const dropOnLane = (id: string, lane: string) => {
    const it = items?.find((i) => i.id === id);
    if (!it || laneOf(it) === lane) return;
    if (lane === "In Progress" && (it.openQuestions ?? 0) > 0) toast(`${it.code} has ${it.openQuestions} open question(s) — answer them on the Questions tab first.`, "bad");
    else if (lane === "In Progress" && startable(it)) setStarting(it);
    else toast(`Cards move through the pipeline in order — agents move ${it.code} to “${lane}” when they finish the previous step.`, "bad");
  };
  const dropBefore = async (id: string, target: WorkItem) => {
    if (id === target.id || !items) return;
    const it = items.find((i) => i.id === id);
    if (!it || laneOf(it) !== laneOf(target)) {
      if (it) dropOnLane(id, laneOf(target));
      return;
    }
    const ordered = items.filter((i) => i.type === "story" || i.type === "task" || i.type === "bug").sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9)).map((i) => i.id).filter((x) => x !== id);
    ordered.splice(ordered.indexOf(target.id), 0, id);
    try {
      await api.post(`/projects/${p.id}/items/reorder`, { ids: ordered });
      toast(`${it.code} moved before ${target.code}`);
    } catch (e) {
      toast((e as Error).message, "bad");
    }
    refresh();
  };
  const deliverables = (items ?? []).filter((i) => i.type === "story" || i.type === "task" || i.type === "bug").filter((i) => !cat || i.category === cat);
  if (items && !items.length)
    return (
      <>
        <Empty title="The board is empty" action={<button className="btn" onClick={() => setCreating(true)}><Plus size={14} /> Add an item yourself</button>}>The requirements analyst creates the backlog when the project starts.</Empty>
        {creating && <NewItemModal projectId={p.id} items={[]} onClose={() => setCreating(false)} />}
      </>
    );
  const lanes = LANES.filter((l) => l !== "Blocked" || deliverables.some((i) => STATE_GROUP[i.state]?.lane === "Blocked"));
  const usedCats = Object.keys(CATEGORY).filter((k) => (items ?? []).some((i) => i.category === k && i.type !== "epic" && i.type !== "feature"));
  return (
    <>
      {creating && <NewItemModal projectId={p.id} items={items ?? []} onClose={() => setCreating(false)} />}
      {starting && <StartWorkModal item={starting} onClose={() => setStarting(null)} />}
      <div className="row wrap" style={{ marginBottom: 12, gap: 6 }}>
        <Hint text="Show only cards of one category. Colours on the cards follow the same legend."><span className="small muted" style={{ marginRight: 4 }}>Category</span></Hint>
        <button className={`btn sm ${cat ? "ghost" : ""}`} onClick={() => setCat(null)}>All</button>
        {usedCats.map((k) => (
          <button key={k} className={`btn sm ${cat === k ? "" : "ghost"}`} onClick={() => setCat(cat === k ? null : k)}>
            <span className="dot" style={{ background: CATEGORY[k].color }} /> {CATEGORY[k].label}
          </button>
        ))}
        <span className="spacer" />
        <Hint text="Cards move through the pipeline in order, so no step between agents is skipped. You can reorder cards within a column (priority) and drop a card on In Progress to start work — the right agents then run each missing step.">
          <span className="tiny faint">Drag within a column to re-prioritise · drop on <b>In Progress</b> to start work</span>
        </Hint>
        <button className="btn sm" onClick={() => setCreating(true)}><Plus size={13} /> New item</button>
      </div>
      <div className="board">
        {lanes.map((lane) => {
          const its = deliverables.filter((i) => (STATE_GROUP[i.state]?.lane ?? "Backlog") === lane).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
          return (
            <div
              key={lane}
              className={`lane ${drag && canDropOn(lane) ? (overLane === lane ? "drop-target" : "drop-allowed") : ""} ${drag && dragged && !canDropOn(lane) && laneOf(dragged) !== lane ? "drop-locked" : ""}`}
              onDragOver={(e) => { if (drag && canDropOn(lane)) { e.preventDefault(); setOverLane(lane); } }}
              onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOverLane(null); }}
              onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); setOverLane(null); setDrag(null); if (id) dropOnLane(id, lane); }}
            >
              {drag && canDropOn(lane) && <div className="lane-hint"><Play size={13} /> Drop to start work</div>}
              <div className="lane-head">
                <span className="dot" style={{ background: STATE_GROUP[Object.keys(STATE_GROUP).find((s) => STATE_GROUP[s].lane === lane)!]?.color }} />
                {lane} <span className="n">{its.length}</span>
                <span className="spacer" />
                <span className="tiny faint">{its.reduce((n, i) => n + (i.story_points ?? 0), 0) || ""}{its.some((i) => i.story_points) ? " pts" : ""}</span>
              </div>
              <div className="lane-body">
                {its.map((it) => (
                  <WorkCard
                    key={it.id}
                    it={it}
                    dragging={drag === it.id}
                    changed={changed.has(`${it.id}:${it.state}`)}
                    onOpen={() => open(it.id)}
                    onDragStart={() => setDrag(it.id)}
                    onDragEnd={() => { setDrag(null); setOverLane(null); }}
                    onDropOn={() => { const id = drag; setDrag(null); setOverLane(null); if (id) void dropBefore(id, it); }}
                  />
                ))}
                {!its.length && <div className="tiny faint" style={{ padding: 8, textAlign: "center" }}>—</div>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
