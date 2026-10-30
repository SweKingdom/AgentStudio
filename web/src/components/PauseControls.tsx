import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Pause, Play, Square, PauseCircle } from "lucide-react";
import { api } from "../lib/api";
import { useMeta, useProjects } from "../lib/queries";
import { dateTime, ago } from "../lib/format";
import { toast } from "../lib/toast";
import { Hint } from "./Hint";

/** Two ways to pause: let agents finish their current step (no tokens wasted), or stop immediately. */
export function PauseMenu({ onPause, pausing, label = "Pause", compact }: { onPause: (mode: "graceful" | "now") => void; pausing?: boolean; label?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className={`btn ${compact ? "sm" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Pause size={13} /> {pausing ? "Pausing…" : label} <ChevronDown size={12} />
      </button>
      {open && (
        <div className="card menu" role="menu" style={{ minWidth: 300 }}>
          {!pausing && (
            <Hint text="Agents finish the step they're on, then stop. Nothing is lost and no tokens are wasted. Resume continues from the next step." block>
              <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); onPause("graceful"); }} style={{ border: 0, background: "none", cursor: "pointer", textAlign: "left" }}>
                <PauseCircle size={14} /> Pause after current steps <span className="tiny faint" style={{ marginLeft: "auto" }}>recommended</span>
              </button>
            </Hint>
          )}
          <Hint text="Cancel what agents are doing right now. The interrupted steps run again from their start when you resume." block>
            <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); onPause("now"); }} style={{ border: 0, background: "none", cursor: "pointer", textAlign: "left", color: "var(--bad)" }}>
              <Square size={13} /> Stop now
            </button>
          </Hint>
        </div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  user: "Paused by you",
  rate_limit: "API rate limit",
  overloaded: "API overloaded",
  network: "Can't reach the API",
  credits: "Out of API credits",
  auth: "API key rejected",
  daily_limit: "Daily spend limit",
  monthly_limit: "Monthly spend limit",
};

/** Top-bar control: Pause all / Resume all. */
export function GlobalPauseButton() {
  const { data: meta } = useMeta();
  const { data: projects } = useProjects();
  const qc = useQueryClient();
  const running = projects?.some((p) => p.running) ?? false;
  const pause = useMutation({
    mutationFn: (mode: "graceful" | "now") => api.post("/pause-all", { mode }),
    onSuccess: (_d, mode) => { qc.invalidateQueries(); toast(mode === "now" ? "All work stopped" : "Pausing — agents finish their current step"); },
  });
  const resume = useMutation({
    mutationFn: () => api.post<{ resumed: string[] }>("/resume-all"),
    onSuccess: (r) => { qc.invalidateQueries(); toast(`Resumed${r.resumed.length ? `: ${r.resumed.join(", ")}` : ""}`); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  if (meta?.globalPause) {
    return (
      <Hint text="Restart everything that was running when the pause began.">
        <button className="btn sm primary" onClick={() => resume.mutate()} disabled={resume.isPending}><Play size={12} /> Resume all</button>
      </Hint>
    );
  }
  if (!running) return null;
  return <PauseMenu compact label="Pause all" onPause={(m) => pause.mutate(m)} />;
}

/** App-wide banner while everything is paused. */
export function GlobalPauseBanner() {
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const resume = useMutation({
    mutationFn: () => api.post<{ resumed: string[] }>("/resume-all"),
    onSuccess: () => { qc.invalidateQueries(); toast("Resumed"); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const gp = meta?.globalPause;
  if (!gp) return null;
  const automatic = gp.kind !== "user";
  return (
    <div className={`global-pause ${automatic ? "auto" : ""}`}>
      <Pause size={15} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>All work paused — {KIND_LABEL[gp.kind] ?? gp.kind}.</b> {gp.reason}
        <span className="muted">
          {" "}Since {ago(gp.since)}
          {gp.resumeAt && gp.autoResume ? ` · resumes automatically ${dateTime(gp.resumeAt)}` : ""}
          {gp.projects.length ? ` · ${gp.projects.length} project(s) and ${gp.jobs.length} job(s) will continue` : ""}
        </span>
      </div>
      <button className="btn sm primary" onClick={() => resume.mutate()} disabled={resume.isPending}><Play size={12} /> Resume all</button>
    </div>
  );
}
