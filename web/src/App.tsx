import { useEffect, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Bot, BookOpen, FolderKanban, Languages, LayoutDashboard, Moon, Plus, Settings2, Sun, X } from "lucide-react";
import brandLogo from "./assets/agentstudio-logo.svg?raw";
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
import { setLang, t, useLang } from "./lib/i18n";

function Brand() {
  return (
    <div className="brand">
      <span className="brand-logo" dangerouslySetInnerHTML={{ __html: brandLogo }} />
      <div className="brand-product">
        <span className="brand-sub">{t("AI delivery team")}</span>
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
    <button className="btn ghost sm" onClick={flip} title={t("Toggle theme")}>
      {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />} {theme === "dark" ? t("Light") : t("Dark")}
    </button>
  );
}

/** English ⇄ Swedish for the interface. Agents keep writing in the team's deliverables language. */
function LangToggle() {
  const lang = useLang();
  return (
    <button className="btn ghost sm" onClick={() => setLang(lang === "en" ? "sv" : "en")} title={t("Switch the interface language")} aria-label={t("Switch the interface language")}>
      <Languages size={13} /> {lang === "en" ? "EN" : "SV"}
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
        <NavLink to="/" end><LayoutDashboard size={16} /> {t("Overview")}</NavLink>
        <NavLink to="/agents"><Bot size={16} /> {t("Agents")}</NavLink>
        <NavLink to="/guide"><BookOpen size={16} /> {t("Guide")}</NavLink>
        <NavLink to="/settings"><Settings2 size={16} /> {t("Settings")}</NavLink>
      </nav>
      <div className="nav-label">
        {t("Projects")}
        {canWrite && <button className="btn ghost sm icon" onClick={() => nav("/projects/new")} title={t("New project")}><Plus size={14} /></button>}
      </div>
      <nav className="nav projects-nav">
        {projects?.map((p) => (
          <NavLink key={p.id} to={`/p/${p.key}`} className="proj-link" title={p.name}>
            <span className="dot" style={{ background: p.running ? "var(--good)" : p.status === "awaiting_approval" ? "var(--warn)" : p.status === "completed" ? "var(--faint)" : "var(--line-2)" }} />
            <span className="nm">{p.name}</span>
            <span className="key">{p.key}</span>
          </NavLink>
        ))}
        {!projects?.length && <div className="faint small" style={{ padding: "4px 10px" }}>{t("No projects yet")}</div>}
        {canWrite && <button className="navlink" onClick={() => nav("/projects/new")}><Plus size={15} /> {t("New project")}</button>}
      </nav>
      <div className="sidebar-foot">
        <div className="row mode-status" title={connected ? t("Updates from the server arrive as they happen") : t("Lost the connection to the server — reconnecting")}>
          <span className="dot" style={{ background: connected ? "var(--good)" : "var(--bad)" }} />
          <span>{connected ? t("Connected") : t("Reconnecting…")}</span>
        </div>
        <SidebarUser />
        <div className="row" style={{ gap: 4 }}>
          <ThemeToggle />
          <LangToggle />
        </div>
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
      <Link to="/settings/general" className="mode-badge live" title={meta.backend === "subscription" ? "Live mode: agents run on your Claude plan and use its limits. Change it in Settings → General." : "Live mode: agents call the Claude API and every call is billed. Change it in Settings → General."}>
        <span className="pulse" /> LIVE{meta.backend === "subscription" ? " · plan" : ""}
      </Link>
    );
  if (meta.settings.mode === "live")
    return (
      <Link to="/settings/general" className="mode-badge pending" title="Live is selected with the API backend but there's no ANTHROPIC_API_KEY in .env — agents keep simulating. Switch the backend to Plan, or add the key.">
        {t("Live · no API key")}
      </Link>
    );
  return (
    <Link to="/settings/general" className="mode-badge sim" title="Simulation: nothing is sent to Claude, no checks run and nothing is billed. Change it in Settings → General.">
      <span className="sim-dot" /> {t("Simulation")}
    </Link>
  );
}

function TopTabs() {
  const tabs = useTabs();
  const { data: projects } = useProjects();
  const loc = useLocation();
  const nav = useNavigate();
  const total = projects?.reduce((n, p) => n + p.costUsd, 0) ?? 0;
  const { data: meta } = useMeta();
  const planBackend = meta?.backend === "subscription" && meta.mode === "live";
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
                aria-label={t("Close tab")}
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
        {running > 0 && <span className="row"><span className="live-dot" /> {t("{n} running", { n: running })}</span>}
        <ModeBadge />
        <span title={planBackend ? "On your Claude plan nothing is billed per call: this is what the same work would cost on the API." : undefined}>{planBackend ? t("Est. spend") : t("Total spend")} <b className="num" style={{ color: "var(--text)" }}><Count value={total} format={(n) => money(n)} /></b></span>
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
  useLang(); // re-render everything when the interface language changes
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

