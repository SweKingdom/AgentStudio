import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, BookOpen, FolderKanban, LayoutDashboard, Plus } from "lucide-react";
import { useProjects } from "../lib/queries";

/** 404 — for unknown addresses, and for projects or agents that don't exist (any more). */
export default function NotFound({ title = "Page not found", message }: { title?: string; message?: string }) {
  const loc = useLocation();
  const nav = useNavigate();
  const { data: projects } = useProjects();
  return (
    <div className="notfound">
      <div className="notfound-box fade-in">
        <div className="notfound-code" aria-hidden>404</div>
        <h1 className="page-title" style={{ margin: 0 }}>{title}</h1>
        <div className="muted">{message ?? "There's nothing at this address. It may have been moved or deleted, or the link is mistyped."}</div>
        <div className="notfound-path" title={loc.pathname}>{loc.pathname}</div>
        <div className="row wrap" style={{ gap: 8, justifyContent: "center", marginTop: 6 }}>
          <button className="btn" onClick={() => nav(-1)}><ArrowLeft size={14} /> Go back</button>
          <Link className="btn primary" to="/"><LayoutDashboard size={14} /> Overview</Link>
          <Link className="btn" to="/projects/new"><Plus size={14} /> New project</Link>
          <Link className="btn" to="/guide"><BookOpen size={14} /> Guide</Link>
        </div>
        {projects && projects.length > 0 && (
          <div className="col" style={{ gap: 6, marginTop: 10, width: "100%" }}>
            <div className="tiny faint" style={{ textTransform: "uppercase", letterSpacing: ".06em" }}>Your projects</div>
            <div className="row wrap" style={{ gap: 6, justifyContent: "center" }}>
              {projects.slice(0, 6).map((p) => (
                <Link key={p.id} to={`/p/${p.key}`} className="chip" style={{ background: "var(--panel-2)" }}><FolderKanban size={11} /> {p.key} · {p.name}</Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
