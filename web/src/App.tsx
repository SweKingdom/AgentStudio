import { useEffect, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Bot, BookOpen, FolderKanban, LayoutDashboard, Moon, Plus, Settings2, Sun, X } from "lucide-react";
import siroccoLogo from "./assets/sirocco-logo.svg?raw";
import { useLiveInvalidation, useConnected } from "./lib/live";
import { useMeta, useProjects } from "./lib/queries";
import { closeTab, openTab, useTabs } from "./lib/tabs";
import { useToasts } from "./lib/toast";
import { money, setCurrency } from "./lib/format";
import { ChatHost } from "./components/Modals";
import { Count } from "./components/Count";
import { GlobalPauseBanner, GlobalPauseButton } from "./components/PauseControls";
import PrintView from "./pages/PrintView";
import NotFound from "./pages/NotFound";
import ReportView from "./pages/ReportView";
import Overview from "./pages/Overview";
import Agents from "./pages/Agents";
import AgentEditor from "./pages/AgentEditor";
import Guide from "./pages/Guide";
import Settings from "./pages/Settings";
import NewProject from "./pages/NewProject";
import Login from "./pages/Login";
import { SidebarUser } from "./components/Users";
import { useAuth, useCan } from "./lib/auth";
import ProjectPage from "./pages/project/ProjectPage";

function Brand() {
  return (
    <div className="brand">
      <span className="brand-logo" dangerouslySetInnerHTML={{ __html: siroccoLogo }} />
      <div className="brand-product">
        <span className="brand-name">ARM</span>
        <span className="brand-sub">Agent Relationship Management</span>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "dark");
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("arm.theme", next); } catch { /* ignore */ }
    setTheme(next);
  };
  return (
    <button className="btn ghost sm" onClick={flip} title="Toggle theme">
      {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />} {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}

function Sidebar() {
  const { data: projects } = useProjects();
  const { data: meta } = useMeta();
  const connected = useConnected();
  const nav = useNavigate();
  const { canWrite } = useCan();
  return (
    <aside className="sidebar">
      <Brand />
      <nav className="nav">
        <NavLink to="/" end><LayoutDashboard size={16} /> Overview</NavLink>
        <NavLink to="/agents"><Bot size={16} /> Agents</NavLink>
        <NavLink to="/guide"><BookOpen size={16} /> Guide</NavLink>
        <NavLink to="/settings"><Settings2 size={16} /> Settings</NavLink>
      </nav>
      <div className="nav-label">
        Projects
        {canWrite && <button className="btn ghost sm icon" onClick={() => nav("/projects/new")} title="New project"><Plus size={14} /></button>}
      </div>
      <nav className="nav projects-nav">
        {projects?.map((p) => (
          <NavLink key={p.id} to={`/p/${p.key}`} className="proj-link" title={p.name}>
            <span className="dot" style={{ background: p.running ? "var(--good)" : p.status === "awaiting_approval" ? "var(--warn)" : p.status === "completed" ? "var(--faint)" : "var(--line-2)" }} />
            <span className="nm">{p.name}</span>
            <span className="key">{p.key}</span>
          </NavLink>
        ))}
        {!projects?.length && <div className="faint small" style={{ padding: "4px 10px" }}>No projects yet</div>}
        {canWrite && <button className="navlink" onClick={() => nav("/projects/new")}><Plus size={15} /> New project</button>}
      </nav>
      <div className="sidebar-foot">
        <div className="row mode-status" title={connected ? "Updates from the server arrive as they happen" : "Lost the connection to the server — reconnecting"}>
          <span className="dot" style={{ background: connected ? "var(--good)" : "var(--bad)" }} />
          <span>{connected ? "Connected" : "Reconnecting…"}</span>
        </div>
        <SidebarUser />
        <ThemeToggle />
      </div>
    </aside>
  );
}

/** The run mode, always shown left of Total spend: red LIVE while agents really call Claude (and cost money), amber when
 *  Live lacks a key, the brand accent in simulation. */
function ModeBadge() {
  const { data: meta } = useMeta();
  if (!meta) return null;
  if (meta.mode === "live")
    return (
      <Link to="/settings/general" className="mode-badge live" title="Live mode: agents call the Claude API and every call is billed. Change it in Settings → General.">
        <span className="pulse" /> LIVE
      </Link>
    );
  if (meta.settings.mode === "live")
    return (
      <Link to="/settings/general" className="mode-badge pending" title="Live is selected but there's no ANTHROPIC_API_KEY in .env — agents keep simulating.">
        Live · no API key
      </Link>
    );
  return (
    <Link to="/settings/general" className="mode-badge sim" title="Simulation: nothing is sent to Claude or Salesforce and nothing is billed. Change it in Settings → General.">
      <span className="sim-dot" /> Simulation
    </Link>
  );
}

function TopTabs() {
  const tabs = useTabs();
  const { data: projects } = useProjects();
  const loc = useLocation();
  const nav = useNavigate();
  const total = projects?.reduce((n, p) => n + p.costUsd, 0) ?? 0;
  const running = projects?.filter((p) => p.running).length ?? 0;
  const current = loc.pathname.match(/^\/p\/([^/]+)/)?.[1];
  return (
    <div className="topbar">
      <div className="tabs-strip">
        {tabs.map((key) => {
          const p = projects?.find((x) => x.key === key);
          if (projects && !p) return null;
          return (
            <div key={key} className={`ptab ${current === key ? "active" : ""}`} onClick={() => nav(`/p/${key}`)}>
              <FolderKanban size={14} />
              <span className="mono tiny muted">{key}</span>
              <span className="nm">{p?.name ?? key}</span>
              {p?.running && <span className="live-dot" style={{ width: 6, height: 6 }} />}
              <button
                className="x"
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(key);
                  if (current === key) nav("/");
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="topbar-right">
        <GlobalPauseButton />
        {running > 0 && <span className="row"><span className="live-dot" /> {running} running</span>}
        <ModeBadge />
        <span>Total spend <b className="num" style={{ color: "var(--text)" }}><Count value={total} format={(n) => money(n)} /></b></span>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
    </div>
  );
}

export default function App() {
  const auth = useAuth();
  useLiveInvalidation();
  const { data: meta } = useMeta();
  const loc = useLocation();
  useEffect(() => {
    if (meta) setCurrency(meta.settings.currency, meta.settings.usdToEur);
  }, [meta]);
  useEffect(() => {
    const key = loc.pathname.match(/^\/p\/([^/]+)/)?.[1];
    if (key) openTab(key);
  }, [loc.pathname]);
  if (/^\/print\/[^/]+\/report\/?$/.test(loc.pathname)) return <ReportView />;
  if (loc.pathname.startsWith("/print/")) return <PrintView />;
  // Optional sign-in: wait for the status (avoids flashing the app), then show Login while login is on and nobody is signed in.
  if (auth.isPending) return null;
  if (auth.data?.enabled && !auth.data.user) return <Login />;
  return (
    <div className={`shell ${meta?.mode === "live" ? "mode-live" : ""}`}>
      <Sidebar />
      <div className="main">
        <TopTabs />
        <GlobalPauseBanner />
        <div className="content">
          <div key={loc.pathname.split("/").slice(0, 3).join("/")} className="page-anim">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/agents/:id" element={<AgentEditor />} />
            {/* The agent network and costs live in each project (Network and Costs tabs); old links go to the Overview. */}
            <Route path="/network" element={<Navigate to="/" replace />} />
            <Route path="/costs" element={<Navigate to="/" replace />} />
            <Route path="/guide/:section?" element={<Guide />} />
            <Route path="/logbook" element={<Navigate to="/" replace />} />
            <Route path="/settings/:section?" element={<Settings />} />
            <Route path="/projects/new" element={<NewProject />} />
            <Route path="/p/:key/*" element={<ProjectPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </div>
        </div>
      </div>
      <Toasts />
      <ChatHost />
    </div>
  );
}

