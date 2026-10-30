import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Search } from "lucide-react";
import { Hint } from "../../components/Hint";
import { NewItemModal } from "../../components/Modals";
import { useFresh } from "../../lib/motion";
import type { Project, WorkItem } from "../../lib/api";
import { CATEGORY } from "../../lib/constants";
import { money } from "../../lib/format";
import { CategoryChip, Empty, StatePill, TestBadge, TypeIcon } from "../../components/ui";
import { useItems, useOpenItem } from "./hooks";
import { AdoSyncButton } from "../../components/AdoSettings";

export default function Backlog({ p }: { p: Project }) {
  const { data: items } = useItems(p.id);
  const open = useOpenItem();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [flat, setFlat] = useState(false);
  const [creating, setCreating] = useState(false);
  const changed = useFresh((items ?? []).map((i) => `${i.id}:${i.state}:${i.rank ?? ""}`), 2600);

  const match = (i: WorkItem) => (!q || `${i.code} ${i.title}`.toLowerCase().includes(q.toLowerCase())) && (!cat || i.category === cat);
  const rows = useMemo(() => {
    const all = items ?? [];
    if (flat) return all.filter((i) => i.type !== "epic" && i.type !== "feature" && match(i)).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9)).map((i) => ({ it: i, depth: 0 }));
    const out: { it: WorkItem; depth: number }[] = [];
    const children = (pid: string | null) => all.filter((i) => i.parent_id === pid).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.code.localeCompare(b.code, undefined, { numeric: true }));
    const visible = (i: WorkItem): boolean => match(i) || all.some((c) => c.parent_id === i.id && visible(c));
    const walk = (pid: string | null, depth: number) => {
      for (const c of children(pid)) {
        if (!visible(c)) continue;
        out.push({ it: c, depth });
        if (!collapsed.has(c.id)) walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    // Orphans whose parent no longer exists
    for (const i of all) if (i.parent_id && !all.some((x) => x.id === i.parent_id) && match(i)) out.push({ it: i, depth: 0 });
    return out;
  }, [items, q, cat, collapsed, flat]);

  if (items && !items.length) return <Empty title="No backlog yet">Start the project and the requirements analyst builds epics, features and stories from the PDF.</Empty>;
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const points = (items ?? []).reduce((n, i) => n + (i.story_points ?? 0), 0);

  return (
    <div className="card">
      {creating && <NewItemModal projectId={p.id} items={items ?? []} onClose={() => setCreating(false)} />}
      <div className="card-head">
        <div className="row" style={{ gap: 8, flex: 1 }}>
          <Hint text="Filter by work item code (e.g. US-104) or any word in the title. Parents of matching items stay visible.">
            <div className="row" style={{ position: "relative", width: 280 }}>
              <Search size={14} style={{ position: "absolute", left: 10, color: "var(--faint)" }} />
              <input className="input" style={{ paddingLeft: 30 }} placeholder="Search code or title…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </Hint>
          <Hint text="Show only one kind of work: development, configuration, data migration, scripts, integration…">
            <select className="select" style={{ width: 180 }} value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">All categories</option>
              {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </Hint>
          <Hint text="Hierarchy = Epic → Feature → Story tree. Ranked list = stories and tasks in build order (rank).">
            <button className={`btn sm ${flat ? "" : "ghost"}`} onClick={() => setFlat(!flat)}>{flat ? "Ranked list" : "Hierarchy"}</button>
          </Hint>
          <span className="spacer" />
          <AdoSyncButton p={p} />
          <button className="btn sm" onClick={() => setCreating(true)}><Plus size={13} /> New item</button>
        </div>
        <span className="card-sub">{items?.length ?? 0} items · {points} pts</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr><th>Item</th><th>Category</th><th>State</th><th className="num">Pts</th><th>MoSCoW</th><th className="num">Sprint</th><th className="num">Rank</th><th>Tests</th><th className="num">Cost</th></tr>
          </thead>
          <tbody>
            {rows.map(({ it, depth }) => {
              const hasKids = (items ?? []).some((c) => c.parent_id === it.id);
              const container = it.type === "epic" || it.type === "feature";
              return (
                <tr key={it.id} className={`clickable ${changed.has(`${it.id}:${it.state}:${it.rank ?? ""}`) ? "row-flash" : ""}`} onClick={() => open(it.id)} style={container ? { background: "var(--bg-2)" } : undefined}>
                  <td style={{ paddingLeft: 12 + depth * 22 }}>
                    <div className="row" style={{ gap: 6, minWidth: 0 }}>
                      {hasKids && !flat ? (
                        <button className="btn ghost sm icon" style={{ width: 20, height: 20 }} onClick={(e) => { e.stopPropagation(); toggle(it.id); }}>
                          {collapsed.has(it.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        </button>
                      ) : <span style={{ width: 20 }} />}
                      <TypeIcon type={it.type} />
                      <span className="mono small nowrap" style={{ color: "var(--text-2)" }}>{it.code}</span>
                      <span className={container ? "strong" : ""} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 520 }}>{it.title}</span>
                    </div>
                  </td>
                  <td>{!container && <CategoryChip value={it.category} small />}</td>
                  <td>{!container && <StatePill state={it.state} />}</td>
                  <td className="num">{it.story_points ?? ""}</td>
                  <td className="small">{it.moscow ?? ""}</td>
                  <td className="num">{it.sprint ?? ""}</td>
                  <td className="num">{it.rank ?? ""}</td>
                  <td><TestBadge t={it.tests} /></td>
                  <td className="num small">{(it.costUsd ?? 0) > 0 ? money(it.costUsd) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
