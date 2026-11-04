import { useQuery } from "@tanstack/react-query";
import { api, type Effort } from "../lib/api";
import { duration, hours, money } from "../lib/format";
import { t } from "../lib/i18n";

export function useEffort(projectId: string) {
  return useQuery({ queryKey: ["effort", projectId], queryFn: () => api.get<Effort>(`/projects/${projectId}/effort`), refetchInterval: 30_000 });
}

/** A bar of parts that add up to a whole, with a legend: where the time or the money went. */
function Split({ parts, format }: { parts: { label: string; value: number; color: string; note?: string }[]; format: (n: number) => string }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  return (
    <>
      <div className="progress" style={{ height: 10, gap: 2, background: "transparent" }}>
        {total > 0 && shown.map((p) => <span key={p.label} title={`${p.label}: ${format(p.value)}`} style={{ width: `${(p.value / total) * 100}%`, background: p.color, borderRadius: 3 }} />)}
      </div>
      <div className="col" style={{ gap: 4, marginTop: 8 }}>
        {parts.map((p) => (
          <div key={p.label} className="row small" style={{ gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: p.color, flex: "none" }} />
            <span className="muted" style={{ flex: 1 }}>{p.label}{p.note ? <span className="faint"> · {p.note}</span> : null}</span>
            <span className="num strong">{format(p.value)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** Where a project's time and money went, measured from its runs, waits and model calls. */
export function EffortCard({ projectId }: { projectId: string }) {
  const { data: e } = useEffort(projectId);
  if (!e) return null;
  const { time: tm, spend: sp } = e;
  const firstTry = sp.firstTry.tested ? Math.round((sp.firstTry.passed / sp.firstTry.tested) * 100) : null;
  return (
    <div className="card card-pad col" style={{ gap: 16 }}>
      <div>
        <div className="card-title" style={{ marginBottom: 4 }}>{t("Where the time went")}</div>
        <div className="small muted" style={{ marginBottom: 10 }}>
          {t("{e} elapsed. The agents' runs added up to {a} across lanes.", { e: duration(tm.elapsedSeconds), a: duration(tm.agentSeconds) })}
        </div>
        <Split
          format={duration}
          parts={[
            { label: t("Agents working"), value: tm.workingSeconds, color: "var(--accent)" },
            { label: t("Waiting for you"), value: tm.waitingForYouSeconds, color: "#c98500", note: t("approvals and questions") },
            { label: t("Paused for limits"), value: tm.limitSeconds, color: "#d95926", note: tm.limitPauses ? t("{n} pause(s)", { n: tm.limitPauses }) : t("plan, spend or budget") },
            { label: t("Paused by you"), value: tm.pausedSeconds, color: "#9085e9" },
            { label: t("Other"), value: tm.otherSeconds, color: "var(--line)", note: t("checks, merges, idle") },
          ]}
        />
      </div>
      <div>
        <div className="card-title" style={{ marginBottom: 4 }}>{e.planBackend ? t("Where the API value went") : t("Where the money went")}</div>
        <div className="small muted" style={{ marginBottom: 10 }}>
          {e.planBackend ? t("Your Claude plan covered this. The figures are what the same work would cost at API prices.") : t("What the model calls cost, by what became of the work.")}
        </div>
        <Split
          format={(n) => money(n)}
          parts={[
            { label: t("Delivered"), value: sp.deliveredUsd, color: "#199e70", note: t("release-ready or deployed") },
            { label: t("In progress"), value: sp.inProgressUsd, color: "var(--accent)" },
            { label: t("Stopped"), value: sp.stoppedUsd, color: "#e66767", note: t("blocked, cancelled or removed") },
            { label: t("Project-wide"), value: sp.projectWideUsd, color: "#9085e9", note: t("analysis, design, planning, release") },
          ]}
        />
        <div className="hint" style={{ marginTop: 10 }}>
          {t("{r} of it went on rework: rounds after QA, code review or the checks sent a story back.", { r: money(sp.reworkUsd) })}
          {firstTry !== null ? ` ${t("{p} % of tested items passed the first time ({a} of {b}).", { p: firstTry, a: sp.firstTry.passed, b: sp.firstTry.tested })}` : ""}
        </div>
      </div>
      <div className="small muted">
        {t("Human team estimate: {h}, from {p} story points at {r} h per point plus 35 % overhead. An estimate, not a measurement.", { h: hours(e.human.hours), p: e.human.points, r: e.human.hoursPerPoint })}
      </div>
    </div>
  );
}
