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
import { t } from "../lib/i18n";

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
        <span>{t("{n} items · {p} pts", { n: p.counts.stories, p: p.counts.points })}</span>
        <span>{t("{d}/{n} deployed", { d: p.counts.done, n: p.counts.stories })}</span>
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
        {p.openQuestions > 0 && <span className="pill" style={{ color: "var(--warn)", background: "rgba(245,184,74,.1)" }}><HelpCircle size={12} /> {t("{n} open", { n: p.openQuestions })}</span>}
        {p.mode === "simulation" && <span className="pill" style={{ color: "var(--muted)", border: "1px solid var(--line-2)" }}>{t("simulated")}</span>}
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
          <h1 className="page-title">{t("Overview")}</h1>
          <div className="page-sub">{t("Your AI delivery team at a glance — projects, who is working on what, and what it costs.")}</div>
        </div>
        {canWrite && <button className="btn primary" onClick={() => nav("/projects/new")}><Plus size={15} /> {t("New project")}</button>}
      </div>

      {meta?.mode === "simulation" && (
        <div className="banner accent" style={{ marginBottom: 16 }}>
          <Sparkles size={16} color="var(--accent)" />
          <div style={{ flex: 1 }}>
            <b>{t("Simulation mode.")}</b> {t("Agents work through your requirements without calling Claude and without running any checks, so you can explore the full flow at no cost. To go live, switch the mode in Settings — agents then run on your Claude plan (claude /login) or an API key.")}
          </div>
          <Link to="/settings" className="btn sm">{t("Settings")}</Link>
        </div>
      )}

      <div className="grid g5 stagger" style={{ marginBottom: 16 }}>
        <Kpi label={t("Projects")} icon={<FolderKanban size={13} />} value={<Count value={projects?.length ?? 0} format={(n) => String(Math.round(n))} />} foot={t("{n} running now", { n: projects?.filter((p) => p.running).length ?? 0 })} />
        <Kpi label={t("Items deployed")} icon={<CheckCircle2 size={13} />} value={`${delivered}/${items}`} foot={t("{n} story points planned", { n: points })} />
        <Kpi label={t("AI spend")} icon={<Coins size={13} />} value={<Count value={spend} format={(n) => money(n)} />} foot={items ? t("{m} per item", { m: money(spend / Math.max(1, items)) }) : "—"} accent />
        <Kpi label={t("Human-equivalent effort")} icon={<Clock size={13} />} value={<Count value={humanHours} format={(n) => hours(n)} />} foot={t("≈ {m} at team rates", { m: money(humanHours * (meta?.settings.humanHourlyRateUsd ?? 65), 0) })} />
        <Kpi label={t("Agents")} icon={<Bot size={13} />} value={<Count value={agents?.length ?? 0} format={(n) => String(Math.round(n))} />} foot={t("{n} working right now", { n: activeAgents })} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.5fr) minmax(0, 1fr)", alignItems: "start" }}>
        <div className="col" style={{ gap: 14 }}>
          {projects?.length ? (
            <div className="grid g2 stagger">{projects.map((p) => <ProjectCard key={p.id} p={p} />)}</div>
          ) : (
            <div className="card">
              <Empty
                icon={<FolderKanban size={20} />}
                title={t("No projects yet")}
                action={canWrite && <button className="btn primary" onClick={() => nav("/projects/new")}><Plus size={15} /> {t("Create your first project")}</button>}
              >
                {t("Upload a requirements PDF or describe the work, choose which agents to involve and get a cost and time estimate before anything runs.")} <Link to="/guide/quick-start" style={{ textDecoration: "underline" }}>{t("Guide")}</Link>
              </Empty>
            </div>
          )}
          <div className="card">
            <div className="card-head">
              <div className="card-title">{t("Who works the most")}</div>
              <span className="card-sub">{t("Model calls per agent, all projects")}</span>
            </div>
            <div className="card-pad">
              <AgentBars fmt="count" rows={(agents ?? []).map((a) => ({ agent: a, value: a.stats.calls }))} />
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div className="card-title"><ActivityIcon size={15} /> {t("Live activity")}</div>
            <span className="card-sub">{t("{n} latest events", { n: num(activity?.length ?? 0) })}</span>
          </div>
          <div style={{ maxHeight: 640, overflow: "auto" }}>
            <ActivityFeed items={activity ?? []} showProject compact />
          </div>
        </div>
      </div>
    </div>
  );
}
