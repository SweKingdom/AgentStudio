import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity as ActivityIcon, Bot, CheckCircle2, Clock, Coins, FolderKanban, HelpCircle, Plus, Sparkles } from "lucide-react";
import { api, type Activity, type Project } from "../lib/api";
import { useAgents, useMeta, useProjects } from "../lib/queries";
import { hours, money, num, ago } from "../lib/format";
import { AgentAvatar, Empty, Kpi, StatusPill } from "../components/ui";
import { ActivityFeed } from "../components/Feeds";
import { AgentBars } from "../components/Charts";
import { Count } from "../components/Count";
import { useCan } from "../lib/auth";

export function ProjectProgress({ p }: { p: Project }) {
  const c = p.counts;
  const total = Math.max(1, c.stories);
  const seg = (n: number, color: string) => <span style={{ width: `${(n / total) * 100}%`, background: color }} />;
  return (
    <div className="progress" title={`${c.done} done · ${c.releaseReady - c.done} release ready · ${c.inProgress} in progress · ${c.blocked} blocked`}>
      {seg(c.done, "var(--good)")}
      {seg(c.releaseReady - c.done, "var(--accent)")}
      {seg(c.inProgress, "var(--info)")}
      {seg(c.blocked, "var(--bad)")}
    </div>
  );
}

function ProjectCard({ p }: { p: Project }) {
  const { data: agents } = useAgents();
  const team = agents?.filter((a) => p.agent_ids.includes(a.id)) ?? [];
  return (
    <Link to={`/p/${p.key}`} className="card card-pad col fadein" style={{ gap: 12 }}>
      <div className="row">
        <span className="code-tag">{p.key}</span>
        <span className="strong ellipsis" style={{ fontSize: 14.5 }}>{p.name}</span>
        <span className="spacer" />
        <StatusPill status={p.running ? "running" : p.status} />
      </div>
      <div className="row small muted" style={{ gap: 14 }}>
        <span>{p.counts.stories} items · {p.counts.points} pts</span>
        <span>{p.counts.done}/{p.counts.stories} deployed</span>
        <span className="spacer" />
        <span className="num" style={{ color: "var(--text)" }}>{money(p.costUsd)}</span>
      </div>
      <ProjectProgress p={p} />
      <div className="row">
        <div className="row" style={{ gap: 0 }}>
          {team.map((a, i) => (
            <span key={a.id} style={{ marginLeft: i ? -6 : 0 }}>
              <AgentAvatar agent={a} size={24} active={p.activeRuns.some((r) => r.agent_id === a.id)} />
            </span>
          ))}
        </div>
        <span className="spacer" />
        {p.openQuestions > 0 && <span className="pill" style={{ color: "var(--warn)", background: "rgba(245,184,74,.1)" }}><HelpCircle size={12} /> {p.openQuestions} open</span>}
        {p.mode === "simulation" && <span className="pill" style={{ color: "var(--muted)", border: "1px solid var(--line-2)" }}>simulated</span>}
        <span className="tiny faint">{ago(p.created_at)}</span>
      </div>
    </Link>
  );
}

export default function Overview() {
  const { data: projects } = useProjects();
  const { data: agents } = useAgents();
  const { data: meta } = useMeta();
  const nav = useNavigate();
  const { canWrite } = useCan();
  const { data: activity } = useQuery({ queryKey: ["activity", "global"], queryFn: () => api.get<Activity[]>("/activity?limit=40") });

  const spend = projects?.reduce((n, p) => n + p.costUsd, 0) ?? 0;
  const delivered = projects?.reduce((n, p) => n + p.counts.done, 0) ?? 0;
  const items = projects?.reduce((n, p) => n + p.counts.stories, 0) ?? 0;
  const points = projects?.reduce((n, p) => n + p.counts.points, 0) ?? 0;
  const humanHours = points * (meta?.settings.hoursPerStoryPoint ?? 6) * 1.35;
  const activeAgents = new Set(projects?.flatMap((p) => p.activeRuns.map((r) => r.agent_id))).size;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Overview</h1>
          <div className="page-sub">Your AI delivery team at a glance — projects, who is working on what, and what it costs.</div>
        </div>
        {canWrite && <button className="btn primary" onClick={() => nav("/projects/new")}><Plus size={15} /> New project</button>}
      </div>

      {meta?.mode === "simulation" && (
        <div className="banner accent" style={{ marginBottom: 16 }}>
          <Sparkles size={16} color="var(--accent)" />
          <div style={{ flex: 1 }}>
            <b>Simulation mode.</b> Agents run a representative scenario without calling the Claude API, so you can explore the
            full flow at no cost. Add <code className="code-tag">ANTHROPIC_API_KEY</code> to <code className="code-tag">.env</code> and restart to go live.
          </div>
          <Link to="/settings" className="btn sm">Settings</Link>
        </div>
      )}

      <div className="grid g5 stagger" style={{ marginBottom: 16 }}>
        <Kpi label="Projects" icon={<FolderKanban size={13} />} value={<Count value={projects?.length ?? 0} format={(n) => String(Math.round(n))} />} foot={`${projects?.filter((p) => p.running).length ?? 0} running now`} />
        <Kpi label="Items deployed" icon={<CheckCircle2 size={13} />} value={`${delivered}/${items}`} foot={`${points} story points planned`} />
        <Kpi label="AI spend" icon={<Coins size={13} />} value={<Count value={spend} format={(n) => money(n)} />} foot={items ? `${money(spend / Math.max(1, items))} per item` : "—"} accent />
        <Kpi label="Human-equivalent effort" icon={<Clock size={13} />} value={<Count value={humanHours} format={(n) => hours(n)} />} foot={`≈ ${money(humanHours * (meta?.settings.humanHourlyRateUsd ?? 65), 0)} at team rates`} />
        <Kpi label="Agents" icon={<Bot size={13} />} value={<Count value={agents?.length ?? 0} format={(n) => String(Math.round(n))} />} foot={`${activeAgents} working right now`} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.5fr) minmax(0, 1fr)", alignItems: "start" }}>
        <div className="col" style={{ gap: 14 }}>
          {projects?.length ? (
            <div className="grid g2 stagger">{projects.map((p) => <ProjectCard key={p.id} p={p} />)}</div>
          ) : (
            <div className="card">
              <Empty
                icon={<FolderKanban size={20} />}
                title="No projects yet"
                action={canWrite && <button className="btn primary" onClick={() => nav("/projects/new")}><Plus size={15} /> Create your first project</button>}
              >
                Upload a requirements PDF, choose which agents to involve and get a cost and time estimate before anything runs. New here? The <Link to="/guide/quick-start" style={{ textDecoration: "underline" }}>Guide</Link> walks through everything.
              </Empty>
            </div>
          )}
          <div className="card">
            <div className="card-head">
              <div className="card-title">Who works the most</div>
              <span className="card-sub">Model calls per agent, all projects</span>
            </div>
            <div className="card-pad">
              <AgentBars fmt="count" rows={(agents ?? []).map((a) => ({ agent: a, value: a.stats.calls }))} />
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div className="card-title"><ActivityIcon size={15} /> Live activity</div>
            <span className="card-sub">{num(activity?.length ?? 0)} latest events</span>
          </div>
          <div style={{ maxHeight: 640, overflow: "auto" }}>
            <ActivityFeed items={activity ?? []} showProject compact />
          </div>
        </div>
      </div>
    </div>
  );
}
