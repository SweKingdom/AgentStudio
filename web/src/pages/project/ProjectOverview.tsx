import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, Coins, HelpCircle, Zap } from "lucide-react";
import { api, type Activity, type Graph, type Project } from "../../lib/api";
import { CATEGORY } from "../../lib/constants";
import { duration, hours, money, num, secondsBetween } from "../../lib/format";
import { useMeta } from "../../lib/queries";
import { AgentAvatar, Kpi, Markdown } from "../../components/ui";
import { ActivityFeed } from "../../components/Feeds";
import { EstimatePanel } from "../NewProject";
import { useItems } from "./hooks";
import { Count } from "../../components/Count";
import EstimateAccuracy from "../../components/EstimateAccuracy";

export default function ProjectOverview({ p }: { p: Project }) {
  const { data: meta } = useMeta();
  const { data: items } = useItems(p.id);
  const { data: graph } = useQuery({ queryKey: ["graph", p.id], queryFn: () => api.get<Graph>(`/projects/${p.id}/graph`) });
  const { data: activity } = useQuery({ queryKey: ["activity", p.id, "recent"], queryFn: () => api.get<Activity[]>(`/projects/${p.id}/activity?limit=25`) });
  const deliverables = (items ?? []).filter((i) => i.type === "story" || i.type === "task" || i.type === "bug");
  const elapsed = p.started_at ? secondsBetween(p.started_at, p.finished_at) : 0;
  const humanH = p.counts.points * (meta?.settings.hoursPerStoryPoint ?? 6) * 1.35;
  const speedup = elapsed > 0 && humanH > 0 ? (humanH * 3600) / 4 / elapsed : 0;
  const est = p.liveEstimate ?? p.estimate;
  const team = (graph?.nodes ?? []).filter((n) => n.role !== "human" && n.role !== "orchestrator");
  const cats = Object.entries(CATEGORY).map(([k, v]) => ({ k, ...v, n: deliverables.filter((i) => i.category === k).length })).filter((c) => c.n);

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="grid g5 stagger">
        <Kpi label="Deployed" icon={<CheckCircle2 size={13} />} value={`${p.counts.done}/${p.counts.stories}`} foot={`${p.counts.releaseReady} release-ready · ${p.counts.inProgress} in flight`} />
        <Kpi label="AI cost" icon={<Coins size={13} />} value={<Count value={p.costUsd} format={(n) => money(n)} />} accent foot={p.estimate ? `estimated ${money(p.estimate.totalUsd)} up front` : undefined} />
        <Kpi label="Elapsed" icon={<Clock size={13} />} value={duration(elapsed)} foot="incl. time waiting for approvals" />
        <Kpi label="Human team equivalent" icon={<Zap size={13} />} value={<Count value={humanH} format={(n) => hours(n)} />} foot={speedup ? `~${num(speedup)}× faster than a team of 4` : `${p.counts.points} story points`} />
        <Kpi label="Open questions" icon={<HelpCircle size={13} />} value={p.openQuestions} foot={p.openQuestions ? <Link to={`/p/${p.key}/questions`} style={{ color: "var(--accent)" }}>Answer them →</Link> : "nothing pending"} />
      </div>

      <div className="grid ov-grid">
        <div className="card">
          <div className="card-head"><div className="card-title">Team on this project</div><Link to={`/p/${p.key}/network`} className="btn sm ghost">Open network</Link></div>
          <div>
            {team.map((n) => (
              <div key={n.id} className="row" style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)", gap: 12 }}>
                <AgentAvatar agent={n} size={32} active={n.active > 0} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row"><span className="strong">{n.name}</span><span className="small muted ellipsis">{n.title}</span></div>
                  <div className="tiny" style={{ color: n.active ? n.color : "var(--faint)" }}>{n.active ? `● working${n.activeItem ? ` on ${n.activeItem}` : ` — ${n.activeStage}`}` : n.calls ? "idle" : "not started"}</div>
                </div>
                <div className="right small"><div className="num strong">{money(n.costUsd)}</div><div className="tiny faint">{num(n.calls)} calls</div></div>
              </div>
            ))}
          </div>
          {cats.length > 0 && (
            <div className="card-pad">
              <div className="label" style={{ marginBottom: 8 }}>Work by category</div>
              <div className="progress" style={{ height: 10, gap: 2, background: "transparent" }}>
                {cats.map((c) => <span key={c.k} title={`${c.label}: ${c.n}`} style={{ width: `${(c.n / deliverables.length) * 100}%`, background: c.color, borderRadius: 3 }} />)}
              </div>
              <div className="row wrap" style={{ gap: 12, marginTop: 8 }}>
                {cats.map((c) => <span key={c.k} className="row small muted" style={{ gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 3, background: c.color }} />{c.label} <b style={{ color: "var(--text)" }}>{c.n}</b></span>)}
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">Recent activity</div><Link to={`/p/${p.key}/activity`} className="btn sm ghost">All</Link></div>
          <div style={{ maxHeight: 520, overflow: "auto" }}><ActivityFeed items={activity ?? []} compact /></div>
        </div>

        <div className="col" style={{ gap: 14 }}>
          <div className="card card-pad">
            <div className="card-title" style={{ marginBottom: 12 }}>{p.liveEstimate ? "Forecast from the backlog" : "Up-front estimate"}</div>
            {est ? <EstimatePanel est={est} compact /> : <div className="small muted">No estimate.</div>}
            {p.liveEstimate && p.estimate && (
              <div className="hint" style={{ marginTop: 10 }}>Up-front estimate was {money(p.estimate.totalUsd)} for ~{p.estimate.stories} stories; the backlog has {p.liveEstimate.stories}.</div>
            )}
          </div>
          <EstimateAccuracy projectId={p.id} projectKey={p.key} compact />
          {p.description && <div className="card card-pad"><div className="label" style={{ marginBottom: 6 }}>Context from you</div><Markdown>{p.description}</Markdown></div>}
        </div>
      </div>
    </div>
  );
}
