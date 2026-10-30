import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, RotateCcw, Timer, TestTube2, BookOpen, Gauge } from "lucide-react";
import { api, type ItemMetrics, type Project } from "../../lib/api";
import { PHASES, category } from "../../lib/constants";
import { duration, hours, dateTime } from "../../lib/format";
import { Empty, Kpi } from "../../components/ui";
import { Legend } from "../../components/Charts";
import { useOpenItem } from "./hooks";

export default function Timing({ p }: { p: Project }) {
  const open = useOpenItem();
  const { data } = useQuery({ queryKey: ["metrics", p.id], queryFn: () => api.get<{ perItem: ItemMetrics[]; startedAt: string | null; finishedAt: string | null }>(`/projects/${p.id}/metrics`), refetchInterval: p.running ? 5000 : false });
  // While agents work, tick every second so in-progress phases grow smoothly between data refreshes.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!p.running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [p.running]);
  const rows = (data?.perItem ?? []).filter((r) => r.phases.length);
  if (!rows.length) return <Empty icon={<Clock size={20} />} title="No timings yet">Every phase of every task — analysis, refinement, planning, development, testing, documentation, release — is timed as agents work.</Empty>;

  const end = (ph: { ended_at: string | null }) => (ph.ended_at ? new Date(ph.ended_at).getTime() : now);
  const t0 = Math.min(...rows.flatMap((r) => r.phases.map((ph) => new Date(ph.started_at).getTime())));
  const t1 = Math.max(...rows.flatMap((r) => r.phases.map(end)), p.running ? now : 0);
  const live = rows.some((r) => r.phases.some((ph) => !ph.ended_at));
  const span = Math.max(1, (t1 - t0) / 1000);
  const avg = (k: string) => {
    const v = rows.map((r) => r.seconds[k]).filter((x) => x > 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const leads = rows.map((r) => r.leadTimeSeconds).filter((x): x is number => x != null);
  const reworks = rows.reduce((n, r) => n + r.rework, 0);
  const tested = rows.filter((r) => r.seconds.qa > 0);
  const firstPass = tested.length ? tested.filter((r) => r.rework === 0).length / tested.length : null;
  // "—" until the phase has happened at least once: 0.0s / 0% early in a run would read as real results.
  const avgText = (k: string) => (avg(k) > 0 ? duration(avg(k)) : "—");
  const firstStart = (r: ItemMetrics) => r.phases.reduce((m, ph) => (ph.started_at < m ? ph.started_at : m), r.phases[0].started_at);
  const sorted = [...rows].sort((a, b) => firstStart(a).localeCompare(firstStart(b)));
  const ticks = Array.from({ length: 6 }, (_, i) => i / 5);

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="grid g5 stagger">
        <Kpi label="Avg development" icon={<Timer size={13} />} value={avgText("development")} foot="per task, all iterations" />
        <Kpi label="Avg testing" icon={<TestTube2 size={13} />} value={avgText("qa")} foot="peer test per task" />
        <Kpi label="Avg documentation" icon={<BookOpen size={13} />} value={avgText("documentation")} />
        <Kpi label="Avg lead time" icon={<Clock size={13} />} value={leads.length ? duration(leads.reduce((a, b) => a + b, 0) / leads.length) : "—"} foot="first phase → last phase" />
        <Kpi label="First-pass yield" icon={<Gauge size={13} />} value={firstPass == null ? "—" : `${Math.round(firstPass * 100)}%`} foot={<span className="row" style={{ gap: 4 }}><RotateCcw size={11} /> {reworks} rework loop(s)</span>} />
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">Timeline</div>
          <Legend items={PHASES.map((ph) => ({ color: ph.color, label: ph.label }))} />
        </div>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 900 }}>
            <div className="gantt-row" style={{ minHeight: 26 }}>
              <div className="gantt-label tiny faint">{dateTime(new Date(t0).toISOString())}</div>
              <div className="gantt-track" style={{ height: 26 }}>
                {ticks.map((t) => (
                  <span key={t} className="tiny faint" style={{ position: "absolute", left: `${t * 100}%`, top: 5, transform: t === 1 ? "translateX(-100%)" : t ? "translateX(-50%)" : undefined }}>
                    +{duration(span * t)}
                  </span>
                ))}
              </div>
            </div>
            {sorted.map((r) => (
              <div key={r.id} className="gantt-row clickable" style={{ cursor: "pointer" }} onClick={() => open(r.id)}>
                <div className="gantt-label">
                  <span style={{ width: 3, height: 18, borderRadius: 2, background: category(r.category).color }} />
                  <span className="mono tiny">{r.code}</span>
                  <span className="ellipsis small">{r.title}</span>
                </div>
                <div className="gantt-track">
                  {ticks.slice(1, -1).map((t) => <span key={t} style={{ position: "absolute", left: `${t * 100}%`, top: 0, bottom: 0, borderLeft: "1px dashed var(--line)" }} />)}
                  {r.phases.map((ph, i) => {
                    const def = PHASES.find((x) => x.key === ph.phase);
                    const start = new Date(ph.started_at).getTime();
                    const secs = Math.max(0, (end(ph) - start) / 1000);
                    const left = ((start - t0) / 1000 / span) * 100;
                    return (
                      <div key={i} className={`gantt-bar ${ph.ended_at ? "" : "live"}`} title={`${def?.label}${ph.iteration > 1 ? ` #${ph.iteration}` : ""}: ${duration(secs)}${ph.ended_at ? "" : " · in progress"}${ph.outcome ? ` · ${ph.outcome}` : ""}`}
                        style={{ left: `${left}%`, width: `${Math.max(0.3, (secs / span) * 100)}%`, background: def?.color, boxShadow: "0 0 0 1px var(--panel)" }} />
                    );
                  })}
                  {live && <span className="gantt-now" style={{ left: `${((now - t0) / 1000 / span) * 100}%` }} />}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div className="card-title">Time per task</div><span className="card-sub">AI working time per phase vs the human estimate</span></div>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Task</th><th className="num">Pts</th>
                {PHASES.map((ph) => <th key={ph.key} className="num"><span className="dot" style={{ background: ph.color, marginRight: 5 }} />{ph.label}</th>)}
                <th className="num">Lead time</th><th className="num">Human est.</th><th className="num">Rework</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => open(r.id)}>
                  <td style={{ whiteSpace: "nowrap" }}><span className="mono small">{r.code}</span> <span className="small ellipsis" title={r.title} style={{ display: "inline-block", maxWidth: 280, verticalAlign: "bottom" }}>{r.title}</span></td>
                  <td className="num">{r.points ?? "—"}</td>
                  {PHASES.map((ph) => <td key={ph.key} className="num small">{r.seconds[ph.key] ? duration(r.seconds[ph.key]) : <span className="faint">—</span>}</td>)}
                  <td className="num strong">{duration(r.leadTimeSeconds)}</td>
                  <td className="num muted">{hours(r.humanHours)}</td>
                  <td className="num" style={{ color: r.rework ? "var(--bad)" : undefined }}>{r.rework || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
