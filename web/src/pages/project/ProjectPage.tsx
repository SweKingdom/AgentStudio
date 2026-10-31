import { useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity, BarChart3, BookText, CheckCircle2, Circle, Clock, Code2, FileText, HelpCircle, KanbanSquare, ListTree, Loader2,
  Network, Pause, Play, Rocket, ShieldAlert, Trash2, LayoutDashboard, Hand, Download, FileArchive, Sheet, Printer, ChevronDown,
} from "lucide-react";
import { Hint } from "../../components/Hint";
import { Count } from "../../components/Count";
import { PageSkeleton } from "../../components/Skeleton";
import { useLocation } from "react-router-dom";
import { PathBar, type PathStep } from "../../components/PathBar";
import { RepoChip } from "../../components/Repo";
import { ProjectSettingsModal } from "./ProjectSettings";
import { PauseMenu } from "../../components/PauseControls";
import { Settings2 } from "lucide-react";
import { api, type Project } from "../../lib/api";
import NotFound from "../NotFound";
import { useAgents } from "../../lib/queries";
import { money } from "../../lib/format";
import { AgentAvatar, StatusPill } from "../../components/ui";
import { toast } from "../../lib/toast";
import { closeTab } from "../../lib/tabs";
import { useCan } from "../../lib/auth";
import ItemDrawer from "./ItemDrawer";
import ProjectOverview from "./ProjectOverview";
import Board from "./Board";
import Backlog from "./Backlog";
import Documents from "./Documents";
import CodeView from "./CodeView";
import Timing from "./Timing";
import ReleaseView from "./ReleaseView";
import Questions from "./Questions";
import NetworkView from "../../components/NetworkView";
import CostsView from "../../components/CostsView";
import EstimateAccuracy from "../../components/EstimateAccuracy";
import { ActivityFeed } from "../../components/Feeds";
import type { Activity as ActivityRow } from "../../lib/api";
import { t } from "../../lib/i18n";

const STAGE_HELP: Record<string, string> = {
  requirements: "The analyst reads the document and builds epics, features and stories with acceptance criteria and open questions.",
  review_backlog: "You review the backlog and answer open questions before refinement starts.",
  architecture: "The architect completes each story's technical specification and the solution design.",
  planning: "The planner estimates, prioritises and orders the backlog into sprints.",
  approve_plan: "You approve the delivery plan before building starts.",
  delivery: "Per story, in parallel lanes: developer builds and runs the project's checks, QA peer-tests (with rework loops), writer documents.",
  approve_release: "You approve the release once everything is built, tested and documented.",
  release: "The release manager runs the checks on the base branch, smoke-tests and publishes the release with a git tag.",
  open_items: "Items are left after every stage ran: continue with them or finish the project without them.",
};

function UndeliveredList({ p, base }: { p: Project; base: string }) {
  return (
    <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
      {p.undelivered.map((i) => (
        <li key={i.id}>
          <NavLink to={`${base}/backlog?item=${i.id}`} style={{ color: "var(--text)", textDecoration: "underline" }}>{i.code}</NavLink> {i.title} — <span className="muted">{i.reason.startsWith("Waits for") ? `${t("Waits for")} ${i.reason.slice(10)}` : /open question/.test(i.reason) ? `${i.reason.split(" ")[0]} ${t("open question(s)")}` : t(i.reason)}</span>
        </li>
      ))}
    </ul>
  );
}

function Pipeline({ p }: { p: Project }) {
  const { data: agents } = useAgents();
  const team = agents?.filter((a) => p.agent_ids.includes(a.id)) ?? [];
  const steps: PathStep[] = p.stages.map((s) => {
    const owners = team.filter((a) => a.role === s.role || (s.key === "delivery" && ["developer", "qa", "writer"].includes(a.role)));
    return {
      key: s.key,
      label: s.label,
      status: s.status,
      gate: s.gate,
      help: (
        <>
          {STAGE_HELP[s.key]}
          {owners.length ? (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
              {owners.map((a) => (
                <span key={a.id} className="row" style={{ gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: a.color }} /> {a.name} — {a.title}
                  {p.activeRuns.some((r) => r.agent_id === a.id) ? " · working now" : ""}
                </span>
              ))}
            </div>
          ) : null}
        </>
      ),
      // The step's border is drawn in its agents' colours (split when several share the step).
      colors: !s.gate && owners.length ? owners.map((a) => a.color) : undefined,
    };
  });
  return <PathBar steps={steps} />;
}

function ExportMenu({ p }: { p: Project }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const items = [
    { href: `/api/projects/${p.id}/export/workspace.zip`, icon: FileArchive, label: "Workspace (.zip)", help: "Everything the team produced: the source, all documents and both CSV files." },
    { href: `/api/projects/${p.id}/export/backlog.csv`, icon: Sheet, label: "Backlog (CSV for Excel)", help: "Every work item with all template sections, estimates, states, rework loops and AI cost per item." },
    { href: `/api/projects/${p.id}/export/azure-devops.csv`, icon: Sheet, label: "Azure DevOps import (CSV)", help: "Boards → Work items → Import Work Items. Epics, features and stories keep their hierarchy; all arrive as New." },
    { href: `/print/${p.key}/report?auto=1`, icon: Printer, label: "Project report (PDF)", help: "A branded A4 report: cover, executive summary with KPIs, team, backlog per epic and feature, quality, timing, cost, releases, questions and the living documents.", newTab: true },
    { href: `/print/${p.key}/report?tasks=1&auto=1`, icon: Printer, label: "Project report + test reports (PDF)", help: "The project report plus an appendix with every task document and test report, including screenshots.", newTab: true },
  ];
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}><Download size={14} /> Export <ChevronDown size={13} /></button>
      {open && (
        <div className="card menu" role="menu">
          {items.map((i) => (
            <Hint key={i.label} text={i.help} block>
              <a role="menuitem" className="menu-item" href={i.href} target={i.newTab ? "_blank" : undefined} rel="noreferrer" onClick={() => setOpen(false)}>
                <i.icon size={14} /> {t(i.label)}
              </a>
            </Hint>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectActivity({ projectId }: { projectId: string }) {
  const { data } = useQuery({ queryKey: ["activity", projectId], queryFn: () => api.get<ActivityRow[]>(`/projects/${projectId}/activity?limit=800`) });
  return <div className="card"><ActivityFeed items={data ?? []} /></div>;
}

export default function ProjectPage() {
  const { key } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const subPath = useLocation().pathname.split("/")[3] ?? "";
  const [editing, setEditing] = useState(false);
  const { canWrite } = useCan();
  const { data: p, error } = useQuery({ queryKey: ["project", key], queryFn: () => api.get<Project>(`/projects/${key}`), retry: (n, e) => !/404|not found/i.test((e as Error).message) && n < 2 });
  const act = useMutation({
    mutationFn: (action: "start" | "pause" | "pause-now" | "approve" | "finish" | "reopen") =>
      action === "pause" || action === "pause-now" ? api.post(`/projects/${p!.id}/pause`, { mode: action === "pause-now" ? "now" : "graceful" }) : api.post(`/projects/${p!.id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", key] }),
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/projects/${p!.id}`),
    onSuccess: () => { closeTab(key!); qc.invalidateQueries({ queryKey: ["projects"] }); nav("/"); toast("Project deleted"); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const raise = useMutation({
    mutationFn: () => api.patch(`/projects/${p!.id}`, { settings: { budgetUsd: Math.ceil((p!.settings.budgetUsd || 0) * 1.5 + 10) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["project", key] }); toast("Budget raised"); },
  });

  if (error) {
    const missing = /404|not found/i.test((error as Error).message);
    return missing ? <NotFound title={`Project ${key} not found`} message="It doesn't exist or it was deleted." /> : <div className="page"><div className="banner bad">{(error as Error).message}</div></div>;
  }
  if (!p) return <PageSkeleton />;

  const gate = p.stages.find((s) => s.status === "awaiting_approval");
  const budgetPct = p.settings.budgetUsd > 0 ? Math.min(100, (p.costUsd / p.settings.budgetUsd) * 100) : 0;
  const item = params.get("item");
  const base = `/p/${p.key}`;
  const tabs = [
    { to: base, label: "Overview", icon: LayoutDashboard, end: true },
    { to: `${base}/board`, label: "Board", icon: KanbanSquare },
    { to: `${base}/backlog`, label: "Backlog", icon: ListTree },
    { to: `${base}/network`, label: "Network", icon: Network },
    { to: `${base}/activity`, label: "Activity", icon: Activity },
    { to: `${base}/documents`, label: "Documents", icon: BookText },
    { to: `${base}/code`, label: "Code", icon: Code2 },
    { to: `${base}/timing`, label: "Timing", icon: Clock },
    { to: `${base}/costs`, label: "Costs", icon: BarChart3 },
    { to: `${base}/release`, label: "Release", icon: Rocket },
    { to: `${base}/questions`, label: "Questions", icon: HelpCircle, badge: p.openQuestions },
  ];

  return (
    <>
      <div className="proj-head">
        <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 10 }}>
              <span className="code-tag" style={{ fontSize: 12.5 }}>{p.key}</span>
              <h1 className="page-title ellipsis">{p.name}</h1>
              <StatusPill status={p.running ? "running" : p.status} />
              {p.mode === "simulation" && <span className="pill" style={{ border: "1px solid var(--line-2)", color: "var(--muted)" }}>simulation</span>}
            </div>
            <div className="row wrap small muted" style={{ gap: "6px 14px", marginTop: 6 }}>
              {p.pdf_name && <a href={`/api/projects/${p.id}/pdf`} target="_blank" rel="noreferrer" className="row" style={{ gap: 5 }}><FileText size={13} /> {p.pdf_name}</a>}
              <span className="nowrap">{p.counts.epics} epics · {p.counts.features} features · {p.counts.stories} items · {p.counts.points} pts</span>
              <RepoChip repo={p.repoInfo} onFix={() => setEditing(true)} />
              {p.agent_ids.length > 0 && (
                <Hint text={p.checks.length ? `Every story must pass: ${p.checks.map((c) => c.command).join(" · ")}. Change them in Settings.` : "No checks found in the repository — add them in Settings so stories are really tested."}>
                  <span className="chip" style={{ background: "var(--panel-3)" }}>{p.checks.length ? `${p.checks.length} check${p.checks.length === 1 ? "" : "s"}` : "No checks"}</span>
                </Hint>
              )}
              <span className="row nowrap" style={{ gap: 6 }}>
                <Count value={p.costUsd} format={(n) => money(n)} />{p.settings.budgetUsd > 0 && <> of {money(p.settings.budgetUsd, 0)}</>}
                {p.settings.budgetUsd > 0 && <span className="progress" style={{ width: 70 }}><span style={{ width: `${budgetPct}%`, background: budgetPct > 90 ? "var(--bad)" : "var(--accent)" }} /></span>}
              </span>
            </div>
          </div>
          <div className="row">
            <Hint text="Edit the project: name, context, git repository, approval gates, lanes, budget, rework limit and checks.">
              <button className="btn" onClick={() => setEditing(true)}><Settings2 size={14} /> Settings</button>
            </Hint>
            <ExportMenu p={p} />
            {!canWrite ? null : p.pipelineRunning ? (
              <PauseMenu pausing={p.pausing} onPause={(m) => act.mutate(m === "now" ? "pause-now" : "pause")} />
            ) : p.jobs.length ? (
              null
            ) : gate ? (
              gate.key === "open_items" ? (
                <button className="btn primary" onClick={() => act.mutate("approve")}><Play size={14} /> {t("Continue with the undelivered items")}</button>
              ) : (
                <button className="btn primary" onClick={() => act.mutate("approve")}><CheckCircle2 size={14} /> {t("Approve:")} {t(gate.label)}</button>
              )
            ) : p.status !== "completed" ? (
              <button className="btn primary" onClick={() => act.mutate("start")}><Play size={14} /> {p.started_at ? "Resume" : "Start"}</button>
            ) : null}
            {canWrite && !p.running && <button className="btn ghost icon" title="Delete project" onClick={() => confirm(`Delete ${p.key} and all its work?`) && del.mutate()}><Trash2 size={14} /></button>}
          </div>
        </div>
        <Pipeline p={p} />
        {p.jobs.length > 0 && (
          <div className="banner info">
            <Loader2 size={15} className="spin" />
            <div style={{ flex: 1 }}><b>Working:</b> {p.jobs.map((j) => j.label).join(" · ")}</div>
            {canWrite && <PauseMenu compact pausing={p.pausing} onPause={(m) => act.mutate(m === "now" ? "pause-now" : "pause")} />}
          </div>
        )}
        {gate?.key === "open_items" ? (
          <div className="banner warn">
            <Hand size={16} color="var(--warn)" />
            <div style={{ flex: 1 }}>
              <b>{t("Undelivered items")}</b> — {t("every stage has run, but these items are not delivered. Answer their questions or fix what blocks them, then continue: blocked items get another try. Or finish the project without them.")}
              <UndeliveredList p={p} base={base} />
            </div>
            {canWrite && (
              <div className="row" style={{ alignSelf: "flex-start" }}>
                <button className="btn sm" onClick={() => confirm(t("Finish the project without these items?")) && act.mutate("finish")}>{t("Finish anyway")}</button>
                <button className="btn primary sm" onClick={() => act.mutate("approve")}>{t("Continue")}</button>
              </div>
            )}
          </div>
        ) : p.status === "completed" && p.undelivered.length > 0 ? (
          <div className="banner warn">
            <ShieldAlert size={16} />
            <div style={{ flex: 1 }}>
              <b>{p.undelivered.length} {t("item(s) not delivered")}</b> — {t("the project was closed with these items left. Reopen it to continue with them.")}
              <UndeliveredList p={p} base={base} />
            </div>
            {canWrite && !p.running && <button className="btn primary sm" style={{ alignSelf: "flex-start" }} onClick={() => act.mutate("reopen")}>{t("Reopen")}</button>}
          </div>
        ) : null}
        {gate && gate.key !== "open_items" && (
          <div className="banner warn">
            <Hand size={16} color="var(--warn)" />
            <div style={{ flex: 1 }}>
              <b>{t(gate.label)}</b> —{" "}
              {gate.key === "review_backlog" ? "review the backlog the analyst built and answer any open questions, then approve to start technical refinement." :
               gate.key === "approve_plan" ? "check the estimates, priorities and sprint plan, then approve to start building." :
               "every story is built, tested and documented. Approve to deploy, smoke test and publish the release."}
              {p.openQuestions > 0 && <> <NavLink to={`${base}/questions`} style={{ color: "var(--text)", textDecoration: "underline" }}>{p.openQuestions} open question(s)</NavLink>.</>}
            </div>
            {canWrite && <button className="btn primary sm" onClick={() => act.mutate("approve")}>{t("Approve & continue")}</button>}
          </div>
        )}
        {p.error && (
          <div className={`banner ${p.error.includes("Budget") ? "warn" : "bad"}`}>
            <ShieldAlert size={16} />
            <div style={{ flex: 1 }}>{p.error}</div>
            {p.error.includes("Budget") && <button className="btn sm" onClick={() => raise.mutate()}>Raise budget 50%</button>}
          </div>
        )}
      </div>
      <nav className="subnav">
        {tabs.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end}>
            <tab.icon size={14} /> {t(tab.label)} {tab.badge ? <span className="badge">{tab.badge}</span> : null}
          </NavLink>
        ))}
      </nav>
      <div className="page wide" style={{ paddingTop: 18 }} key={subPath} >
        <div className="page-anim">
        <Routes>
          <Route index element={<ProjectOverview p={p} />} />
          <Route path="board" element={<Board p={p} />} />
          <Route path="backlog" element={<Backlog p={p} />} />
          <Route path="network" element={<NetworkView projectId={p.id} projectKey={p.key} />} />
          <Route path="activity" element={<ProjectActivity projectId={p.id} />} />
          <Route path="documents" element={<Documents p={p} />} />
          <Route path="code" element={<CodeView p={p} />} />
          <Route path="timing" element={<Timing p={p} />} />
          <Route path="costs" element={<div className="col" style={{ gap: 14 }}><EstimateAccuracy projectId={p.id} /><CostsView projectId={p.id} projectKey={p.key} /></div>} />
          <Route path="release" element={<ReleaseView p={p} />} />
          <Route path="questions" element={<Questions p={p} />} />
        </Routes>
        </div>
      </div>
      {editing && <ProjectSettingsModal p={p} onClose={() => setEditing(false)} />}
      {item && <ItemDrawer id={item} project={p} onClose={() => { params.delete("item"); setParams(params); }} />}
    </>
  );
}
