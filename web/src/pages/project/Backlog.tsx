import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronRight, Filter, Plus, Search, User, X } from "lucide-react";
import { Hint } from "../../components/Hint";
import { NewItemModal } from "../../components/Modals";
import { MultiFilter } from "../../components/MultiFilter";
import { isSomeoneElses, ownerLabel } from "../../components/Owner";
import { useFresh } from "../../lib/motion";
import { api, type Project, type WorkItem, type WorkRule } from "../../lib/api";
import { CATEGORY } from "../../lib/constants";
import { money } from "../../lib/format";
import { t } from "../../lib/i18n";
import { toast } from "../../lib/toast";
import { CategoryChip, Empty, StatePill, TestBadge, TypeIcon } from "../../components/ui";
import { useItems, useOpenItem } from "./hooks";
import { AdoSyncButton } from "../../components/AdoSettings";

const UNASSIGNED = "\u0000unassigned";
const isDeliverable = (i: WorkItem) => i.type === "story" || i.type === "task" || i.type === "bug";
/** The imported iteration, else AgentStudio's own sprint (as ownership.ts on the server). */
const iterationOf = (i: WorkItem) => i.iteration?.trim() || (i.sprint ? `Sprint ${i.sprint}` : "");

interface Filters { owners: string[]; assignees: string[]; iterations: string[]; states: string[]; tags: string[]; types: string[] }
const NO_FILTERS: Filters = { owners: [], assignees: [], iterations: [], states: [], tags: [], types: [] };

export default function Backlog({ p }: { p: Project }) {
  const { data: items } = useItems(p.id);
  const qc = useQueryClient();
  const open = useOpenItem();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [person, setPerson] = useState("");
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [flat, setFlat] = useState(false);
  const [creating, setCreating] = useState(false);
  const changed = useFresh((items ?? []).map((i) => `${i.id}:${i.state}:${i.rank ?? ""}`), 2600);
  const rule = p.settings.workRule;

  const filtering = Object.values(f).some((v) => v.length > 0);
  const text = (i: WorkItem) => `${i.code} ${i.title} ${i.user_story} ${i.acceptance_criteria} ${i.tags.join(" ")} ${i.assignee ?? ""} ${iterationOf(i)}`.toLowerCase();
  const passes = (i: WorkItem) =>
    (!f.owners.length || f.owners.includes(isSomeoneElses(i) ? "person" : "agentstudio")) &&
    (!f.assignees.length || f.assignees.includes(i.assignee?.trim() || UNASSIGNED)) &&
    (!f.iterations.length || f.iterations.includes(iterationOf(i))) &&
    (!f.states.length || f.states.includes(i.state)) &&
    (!f.tags.length || i.tags.some((x) => f.tags.includes(x))) &&
    (!f.types.length || f.types.includes(i.type));
  // Epics and features are shown for their matching children; the filters themselves apply to the work.
  const match = (i: WorkItem) => (!q || text(i).includes(q.toLowerCase())) && (!cat || i.category === cat) && (isDeliverable(i) ? passes(i) : !filtering);

  const rows = useMemo(() => {
    const all = items ?? [];
    if (flat) return all.filter((i) => isDeliverable(i) && match(i)).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9)).map((i) => ({ it: i, depth: 0 }));
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
  }, [items, q, cat, f, collapsed, flat]);

  const work = (items ?? []).filter(isDeliverable);
  const options = (values: string[], label?: (v: string) => string) =>
    [...new Set(values)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((v) => ({ value: v, label: label?.(v), count: values.filter((x) => x === v).length }));

  if (items && !items.length) return <Empty title="No backlog yet">Start the project and the requirements analyst builds epics, features and stories from the PDF.</Empty>;
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const points = (items ?? []).reduce((n, i) => n + (i.story_points ?? 0), 0);
  const shownWork = rows.map((r) => r.it).filter(isDeliverable);
  const allShownSelected = shownWork.length > 0 && shownWork.every((i) => selected.has(i.id));
  const select = (id: string, on: boolean) => setSelected((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });

  const give = async (owner: "agentstudio" | "person") => {
    setBusy(true);
    try {
      const r = await api.post<{ changed: number; skipped: { code: string; reason: string }[] }>(`/projects/${p.id}/items/owner`, { ids: [...selected], owner, ...(owner === "person" ? { assignee: person.trim() || null } : {}) });
      await qc.invalidateQueries({ queryKey: ["items", p.id] });
      toast(r.skipped.length ? t("{n} item(s) changed; {s} skipped because an agent is working on them", { n: r.changed, s: r.skipped.length }) : t("{n} item(s) changed", { n: r.changed }));
      setSelected(new Set());
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const saveRule = async (next: WorkRule | null) => {
    setBusy(true);
    try {
      await api.patch(`/projects/${p.id}`, { settings: { workRule: next } });
      await Promise.all([qc.invalidateQueries({ queryKey: ["project", p.key] }), qc.invalidateQueries({ queryKey: ["items", p.id] })]);
      toast(next ? t("AgentStudio's rule saved") : t("AgentStudio's rule removed"));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const ruleFromFilters: WorkRule = { assignees: f.assignees.filter((a) => a !== UNASSIGNED), iterations: f.iterations, tags: f.tags };
  const canMakeRule = !!(ruleFromFilters.assignees!.length || ruleFromFilters.iterations!.length || ruleFromFilters.tags!.length);
  const describe = (r: WorkRule) =>
    [r.assignees?.length ? t("assigned to {v}", { v: r.assignees.join(", ") }) : "", r.iterations?.length ? t("in {v}", { v: r.iterations.join(", ") }) : "", r.tags?.length ? t("tagged {v}", { v: r.tags.join(", ") }) : ""].filter(Boolean).join(" · ");

  return (
    <div className="card">
      {creating && <NewItemModal projectId={p.id} items={items ?? []} onClose={() => setCreating(false)} />}
      <div className="card-head" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="row wrap" style={{ gap: 8, flex: 1 }}>
          <Hint text={t("Search codes, titles, story text, acceptance criteria, tags, assignees and iterations. Parents of matching items stay visible.")}>
            <div className="row" style={{ position: "relative", width: 280 }}>
              <Search size={14} style={{ position: "absolute", left: 10, color: "var(--faint)" }} />
              <input className="input" style={{ paddingLeft: 30 }} placeholder={t("Search…")} aria-label={t("Search the backlog")} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </Hint>
          <Filter size={14} className="faint" aria-hidden />
          <MultiFilter label={t("Built by")} value={f.owners} onChange={(v) => setF({ ...f, owners: v })} options={options(work.map((i) => (isSomeoneElses(i) ? "person" : "agentstudio")), (v) => (v === "person" ? t("Someone else") : "AgentStudio"))} />
          <MultiFilter label={t("Assigned to")} value={f.assignees} onChange={(v) => setF({ ...f, assignees: v })} options={options(work.map((i) => i.assignee?.trim() || UNASSIGNED), (v) => (v === UNASSIGNED ? t("Unassigned") : v))} />
          <MultiFilter label={t("Iteration")} value={f.iterations} onChange={(v) => setF({ ...f, iterations: v })} options={options(work.map(iterationOf).filter(Boolean))} />
          <MultiFilter label={t("State")} value={f.states} onChange={(v) => setF({ ...f, states: v })} options={options(work.map((i) => i.state))} />
          <MultiFilter label={t("Tag")} value={f.tags} onChange={(v) => setF({ ...f, tags: v })} options={options(work.flatMap((i) => i.tags))} />
          <MultiFilter label={t("Type")} value={f.types} onChange={(v) => setF({ ...f, types: v })} options={options(work.map((i) => i.type))} />
          <select className="select" style={{ width: 170 }} aria-label={t("Category")} value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">{t("All categories")}</option>
            {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          {(filtering || q || cat) && <button className="btn sm ghost" onClick={() => { setF(NO_FILTERS); setQ(""); setCat(""); }}><X size={12} /> {t("Clear filters")}</button>}
          {canMakeRule && (
            <Hint text={t("AgentStudio builds the items that match these filters (assigned to, iteration and tag), checked at every run, so new and reassigned items follow it. Items you give to AgentStudio or to someone by hand keep that.")}>
              <button className="btn sm" disabled={busy} onClick={() => saveRule(ruleFromFilters)}><Bot size={13} /> {t("Make this AgentStudio's rule")}</button>
            </Hint>
          )}
          <span className="spacer" />
          <Hint text="Hierarchy = Epic → Feature → Story tree. Ranked list = stories and tasks in build order (rank).">
            <button className={`btn sm ${flat ? "" : "ghost"}`} onClick={() => setFlat(!flat)}>{flat ? "Ranked list" : "Hierarchy"}</button>
          </Hint>
          <AdoSyncButton p={p} />
          <button className="btn sm" onClick={() => setCreating(true)}><Plus size={13} /> New item</button>
        </div>
        <span className="card-sub">{items?.length ?? 0} items · {points} pts</span>
      </div>
      {rule && (
        <div className="row small" style={{ gap: 8, padding: "8px 16px", borderBottom: "1px solid var(--line)", background: "var(--bg-2)" }}>
          <Bot size={13} />
          <span style={{ flex: 1 }}>{t("AgentStudio builds what is {r}, and the items given to it.", { r: describe(rule) })}</span>
          <button className="btn sm ghost" disabled={busy} onClick={() => saveRule(null)}>{t("Remove rule")}</button>
        </div>
      )}
      {selected.size > 0 && (
        <div className="row wrap small" style={{ gap: 8, padding: "8px 16px", borderBottom: "1px solid var(--line)", background: "color-mix(in srgb, var(--accent) 8%, transparent)" }}>
          <span className="strong">{t("{n} selected", { n: selected.size })}</span>
          <button className="btn sm" disabled={busy} onClick={() => give("agentstudio")}><Bot size={13} /> {t("Give to AgentStudio")}</button>
          <span className="row" style={{ gap: 4 }}>
            <input className="input" style={{ width: 150, height: 28 }} placeholder={t("Name (optional)")} aria-label={t("Assigned to")} maxLength={120} value={person} onChange={(e) => setPerson(e.target.value)} />
            <button className="btn sm" disabled={busy} onClick={() => give("person")}><User size={13} /> {t("Give to someone else")}</button>
          </span>
          <span className="spacer" />
          <button className="btn sm ghost" onClick={() => setSelected(new Set())}>{t("Clear selection")}</button>
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 28 }}><input type="checkbox" aria-label={t("Select all shown")} title={t("Select all shown")} checked={allShownSelected} disabled={!shownWork.length} onChange={(e) => setSelected((s) => { const n = new Set(s); for (const i of shownWork) e.target.checked ? n.add(i.id) : n.delete(i.id); return n; })} /></th>
              <th>Item</th><th>{t("Built by")}</th><th>Category</th><th>State</th><th className="num">Pts</th><th>{t("Iteration")}</th><th className="num">Rank</th><th>Tests</th><th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ it, depth }) => {
              const hasKids = (items ?? []).some((c) => c.parent_id === it.id);
              const container = !isDeliverable(it);
              const theirs = isSomeoneElses(it);
              return (
                <tr key={it.id} className={`clickable ${changed.has(`${it.id}:${it.state}:${it.rank ?? ""}`) ? "row-flash" : ""}`} onClick={() => open(it.id)} style={container ? { background: "var(--bg-2)" } : theirs ? { opacity: 0.72 } : undefined}>
                  <td onClick={(e) => e.stopPropagation()}>{!container && <input type="checkbox" aria-label={t("Select {c}", { c: it.code })} checked={selected.has(it.id)} onChange={(e) => select(it.id, e.target.checked)} />}</td>
                  <td style={{ paddingLeft: 12 + depth * 22 }}>
                    <div className="row" style={{ gap: 6, minWidth: 0 }}>
                      {hasKids && !flat ? (
                        <button className="btn ghost sm icon" style={{ width: 20, height: 20 }} onClick={(e) => { e.stopPropagation(); toggle(it.id); }}>
                          {collapsed.has(it.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        </button>
                      ) : <span style={{ width: 20 }} />}
                      <TypeIcon type={it.type} />
                      <span className="mono small nowrap" style={{ color: "var(--text-2)" }}>{it.code}</span>
                      <span className={container ? "strong" : ""} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 480 }}>{it.title}</span>
                    </div>
                  </td>
                  <td className="small nowrap">{!container && <span className="row" style={{ gap: 4 }}>{theirs ? <User size={12} /> : <Bot size={12} />}{ownerLabel(it)}</span>}</td>
                  <td>{!container && <CategoryChip value={it.category} small />}</td>
                  <td>{!container && <StatePill state={it.state} />}</td>
                  <td className="num">{it.story_points ?? ""}</td>
                  <td className="small nowrap">{!container && iterationOf(it)}</td>
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
