import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Target } from "lucide-react";
import { api } from "../lib/api";
import { CATEGORY, roleLabel } from "../lib/constants";
import { duration, money, num, tokens } from "../lib/format";
import { useAgentLookup } from "../lib/queries";
import { AgentAvatar } from "./ui";

// ---- response of GET /projects/:pid/accuracy (server/src/accuracy.ts)
interface Usage { costUsd: number; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; tokens: number }
export interface AccuracyAgent {
  agentId: string; name: string; role: string; title: string; color: string;
  estimated: (Usage & { runs: number; minutes: number | null }) | null;
  actual: Usage & { runs: number; busyMs: number };
  deltaPct: number | null; tokensDeltaPct: number | null; miss: boolean;
}
export interface AccuracyStage {
  stage: string; label: string; estimatedUsd: number | null; actualUsd: number; estimatedTokens: number | null; actualTokens: number;
  calls: number; deltaPct: number | null; tokensDeltaPct: number | null; complete: boolean;
}
export interface Accuracy {
  available: true;
  status: { state: "in_progress" | "final"; projectStatus: string; pctDone: number; done: number; total: number };
  basis: string | null;
  simulated: boolean;
  totals: {
    estimated: { expected: number; low: number; high: number; calls: number | null; tokens: number | null };
    actual: { costUsd: number; calls: number; tokens: number; inputTokens: number; outputTokens: number };
    withinRange: boolean; position: "under" | "over" | "on"; deltaPct: number | null;
  };
  agents: AccuracyAgent[];
  stages: AccuracyStage[];
  scope: {
    estimated: { stories: number | null; points: number | null; epics: number | null; features: number | null };
    actual: { stories: number; points: number; epics: number; features: number; unpointed: number };
    storiesDeltaPct: number | null; pointsDeltaPct: number | null;
    byCategory: { category: string; estimatedStories: number | null; estimatedPoints: number | null; actualStories: number; actualPoints: number }[];
  };
  time: { estimatedMinutes: number | null; aiWallClockMs: number; agentMs: number; elapsedMs: number; deltaPct: number | null };
  verdict: string;
}
export type AccuracyResult = Accuracy | { available: false; reason: string };

/** Shared query: the `costs` prefix makes it refresh on every recorded model call (see useLiveInvalidation). */
export function useAccuracy(projectId: string) {
  return useQuery({ queryKey: ["costs", projectId, "accuracy"], queryFn: () => api.get<AccuracyResult>(`/projects/${projectId}/accuracy`) });
}

/** Signed % with colour: over the estimate in --bad, under in --good, within ±10 % neutral. */
export function Delta({ pct, title }: { pct: number | null | undefined; title?: string }) {
  if (pct == null || !isFinite(pct)) return <span className="faint">—</span>;
  const r = Math.round(pct);
  const cls = Math.abs(pct) < 10 ? "on" : pct > 0 ? "over" : "under";
  return <span className={`eva-delta ${cls}`} title={title}>{r > 0 ? "+" : r < 0 ? "−" : "±"}{Math.abs(r)} %</span>;
}

/** Where the actual cost lands against the estimate: low–high band, expected tick, actual marker. */
function RangeBar({ a }: { a: Accuracy }) {
  const t = a.totals;
  const max = Math.max(t.estimated.high, t.actual.costUsd, 1e-9) * 1.08;
  const at = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  const tone = t.withinRange ? "in" : t.actual.costUsd > t.estimated.high ? "above" : "below";
  return (
    <div className="eva-range">
      <div className="eva-track" role="img" aria-label={`Actual ${money(t.actual.costUsd)}, expected ${money(t.estimated.expected)}, range ${money(t.estimated.low)} to ${money(t.estimated.high)}`}>
        <span className="eva-band" style={{ left: at(t.estimated.low), width: `calc(${at(t.estimated.high)} - ${at(t.estimated.low)})` }} title={`Estimated range ${money(t.estimated.low)} – ${money(t.estimated.high)}`} />
        <span className={`eva-fill ${tone}`} style={{ width: at(t.actual.costUsd) }} />
        <span className="eva-expected" style={{ left: at(t.estimated.expected) }} title={`Expected ${money(t.estimated.expected)}`} />
        <span className={`eva-marker ${tone}`} style={{ left: at(t.actual.costUsd) }} title={`Actual ${money(t.actual.costUsd)}`} />
      </div>
      <div className="eva-legend">
        <span><i className={`eva-sw ${tone}`} />Actual <b>{money(t.actual.costUsd)}</b></span>
        <span><i className="eva-sw tick" />Expected <b>{money(t.estimated.expected)}</b></span>
        <span><i className="eva-sw band" />Range {money(t.estimated.low)}–{money(t.estimated.high)}</span>
      </div>
    </div>
  );
}

function AgentCell({ row }: { row: AccuracyAgent }) {
  const lookup = useAgentLookup();
  const ag = lookup(row.agentId);
  const agent = { ...ag, name: row.name, color: ag.role === "?" ? row.color : ag.color, role: ag.role === "?" ? row.role : ag.role, title: ag.title || row.title };
  return (
    <div className="row" style={{ gap: 7, minWidth: 0 }}>
      <AgentAvatar agent={agent} size={20} />
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 5 }}><b className="ellipsis">{row.name}</b>{row.miss && <span className="eva-miss" title="One of the biggest misses: largest cost gap, at least 25 % off">miss</span>}</div>
        <div className="tiny faint ellipsis">{roleLabel(agent)}</div>
      </div>
    </div>
  );
}

function StatusChip({ a }: { a: Accuracy }) {
  return a.status.state === "final"
    ? <span className="eva-status final">Final</span>
    : <span className="eva-status">In progress · {a.status.pctDone} % done</span>;
}

/**
 * "Estimate vs actual" card. `compact` (overview side column): range bar, verdict and the agent deltas.
 * Full (Costs tab): plus per-agent and per-stage tables, scope and time.
 */
export default function EstimateAccuracy({ projectId, projectKey, compact = false }: { projectId: string; projectKey?: string; compact?: boolean }) {
  const { data } = useAccuracy(projectId);
  if (!data || !data.available) return null;
  const a = data;
  const est = a.totals.estimated;

  if (compact) {
    return (
      <div className="card card-pad eva">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <div className="card-title"><Target size={14} /> Estimate vs actual</div>
          <StatusChip a={a} />
        </div>
        <RangeBar a={a} />
        <p className="eva-verdict">{a.verdict}</p>
        <div className="col" style={{ gap: 0 }}>
          {a.agents.map((r) => (
            <div key={r.agentId} className="eva-mini">
              <AgentCell row={r} />
              <div className="right small num"><b>{money(r.actual.costUsd)}</b><div className="tiny faint">of {r.estimated ? money(r.estimated.costUsd) : "—"}</div></div>
              <div className="right small" style={{ width: 52 }}><Delta pct={r.deltaPct} /></div>
            </div>
          ))}
        </div>
        {projectKey && <Link to={`/p/${projectKey}/costs`} className="btn sm ghost" style={{ marginTop: 8 }}>Full comparison →</Link>}
      </div>
    );
  }

  const cats = a.scope.byCategory.filter((c) => c.actualStories || c.estimatedStories);
  const wallEstMs = a.time.estimatedMinutes != null ? a.time.estimatedMinutes * 60000 : null;
  return (
    <div className="card eva">
      <div className="card-head">
        <div className="card-title"><Target size={14} /> Estimate vs actual</div>
        <div className="row" style={{ gap: 8 }}>
          {a.simulated && <span className="tiny faint">simulation · computed at real prices</span>}
          <StatusChip a={a} />
        </div>
      </div>
      <div className="card-pad col" style={{ gap: 14 }}>
        <div className="eva-top">
          <RangeBar a={a} />
          <div className="eva-big">
            <div className="tiny faint">Actual vs expected</div>
            <div className="eva-big-v"><Delta pct={a.totals.deltaPct} /></div>
            <div className="tiny faint">{a.totals.withinRange ? "inside the range" : a.totals.position === "over" ? "above the range" : "below the range"}</div>
          </div>
        </div>
        <p className="eva-verdict">{a.verdict}</p>

        <div className="eva-tables">
          <div style={{ overflowX: "auto" }}>
            <table className="table eva-table">
              <thead>
                <tr><th>Agent</th><th className="num">Estimated</th><th className="num">Actual</th><th className="num">Δ cost</th><th className="num" title="Input + output + cache tokens">Tokens est. → actual</th><th className="num">Δ tokens</th><th className="num">Runs</th><th className="num">Calls</th></tr>
              </thead>
              <tbody>
                {a.agents.map((r) => (
                  <tr key={r.agentId} className={r.miss ? "eva-row-miss" : undefined}>
                    <td><AgentCell row={r} /></td>
                    <td className="num muted">{r.estimated ? money(r.estimated.costUsd) : "—"}</td>
                    <td className="num strong">{money(r.actual.costUsd)}</td>
                    <td className="num"><Delta pct={r.deltaPct} /></td>
                    <td className="num small" title={r.estimated ? `Estimated in ${tokens(r.estimated.inputTokens)} · out ${tokens(r.estimated.outputTokens)} — actual in ${tokens(r.actual.inputTokens)} · out ${tokens(r.actual.outputTokens)}` : undefined}>
                      <span className="faint">{r.estimated ? tokens(r.estimated.tokens) : "—"}</span> → {tokens(r.actual.tokens)}
                    </td>
                    <td className="num"><Delta pct={r.tokensDeltaPct} /></td>
                    <td className="num small"><span className="faint">{r.estimated ? num(r.estimated.runs, r.estimated.runs % 1 ? 1 : 0) : "—"}</span> → {r.actual.runs}</td>
                    <td className="num small"><span className="faint">{r.estimated ? num(r.estimated.calls) : "—"}</span> → {r.actual.calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="table eva-table">
              <thead><tr><th>Stage</th><th className="num">Estimated</th><th className="num">Actual</th><th className="num">Δ cost</th><th className="num">Δ tokens</th></tr></thead>
              <tbody>
                {a.stages.map((s) => (
                  <tr key={s.stage}>
                    <td>{s.label}{!s.complete && <span className="tiny faint"> · in progress</span>}</td>
                    <td className="num muted">{s.estimatedUsd != null ? money(s.estimatedUsd) : "—"}</td>
                    <td className="num strong">{money(s.actualUsd)}</td>
                    <td className="num"><Delta pct={s.deltaPct} /></td>
                    <td className="num" title={`${s.estimatedTokens != null ? tokens(s.estimatedTokens) : "—"} → ${tokens(s.actualTokens)} tokens`}><Delta pct={s.tokensDeltaPct} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="eva-facts">
          <div className="eva-fact">
            <div className="label">Scope</div>
            <div className="small">
              Stories <span className="faint">{a.scope.estimated.stories ?? "—"}</span> → <b>{a.scope.actual.stories}</b> <Delta pct={a.scope.storiesDeltaPct} />
              <span className="faint"> · </span>
              Points <span className="faint">{a.scope.estimated.points ?? "—"}</span> → <b>{a.scope.actual.points}</b> <Delta pct={a.scope.pointsDeltaPct} />
              {a.scope.actual.unpointed > 0 && <span className="tiny faint"> ({a.scope.actual.unpointed} not pointed yet)</span>}
            </div>
            {cats.length > 0 && (
              <div className="row wrap" style={{ gap: "4px 12px", marginTop: 6 }}>
                {cats.map((c) => (
                  <span key={c.category} className="row tiny muted" style={{ gap: 5 }} title={`${CATEGORY[c.category]?.label ?? c.category}: ${c.estimatedStories ?? "—"} → ${c.actualStories} stories, ${c.estimatedPoints ?? "—"} → ${c.actualPoints} points`}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: CATEGORY[c.category]?.color ?? "#8a92a6" }} />
                    {CATEGORY[c.category]?.label ?? c.category} <span className="faint">{c.estimatedStories ?? "—"}</span>→<b style={{ color: "var(--text)" }}>{c.actualStories}</b>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="eva-fact">
            <div className="label">Time</div>
            <div className="small">
              AI wall-clock <span className="faint">{wallEstMs != null ? duration(wallEstMs / 1000) : "—"}</span> → <b>{duration(a.time.aiWallClockMs / 1000)}</b> <Delta pct={a.time.deltaPct} />
            </div>
            <div className="tiny faint" style={{ marginTop: 4 }}>
              Time when at least one agent was working · {duration(a.time.agentMs / 1000)} of agent time in parallel · {duration(a.time.elapsedMs / 1000)} elapsed incl. approval waits
            </div>
          </div>
          <div className="eva-fact">
            <div className="label">Usage</div>
            <div className="small">
              Calls <span className="faint">{est.calls != null ? num(est.calls) : "—"}</span> → <b>{num(a.totals.actual.calls)}</b>
              <span className="faint"> · </span>
              Tokens <span className="faint">{est.tokens != null ? tokens(est.tokens) : "—"}</span> → <b>{tokens(a.totals.actual.tokens)}</b>
            </div>
            <div className="tiny faint" style={{ marginTop: 4 }}>Estimated with the {a.basis === "backlog" ? "backlog" : a.basis === "document" ? "document analysis" : "requirements length"} before the project started</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- print report (static, light, A4)

const pctText = (p: number | null | undefined) => (p == null || !isFinite(p) ? "—" : `${Math.round(p) > 0 ? "+" : Math.round(p) < 0 ? "−" : "±"}${Math.abs(Math.round(p))} %`);
const pctClass = (p: number | null | undefined) => (p == null || Math.abs(p) < 10 ? "" : p > 0 ? "rp-bad" : "rp-good");

/** "Estimate vs actual" subsection of the PDF report's Cost section. */
export function ReportAccuracy({ a }: { a: Accuracy }) {
  const t = a.totals;
  const max = Math.max(t.estimated.high, t.actual.costUsd, 1e-9) * 1.08;
  const at = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  const tone = t.withinRange ? "in" : t.actual.costUsd > t.estimated.high ? "above" : "below";
  return (
    <div className="rp-eva">
      <h3 className="rp-h3">Estimate vs actual <span className="rp-faint" style={{ fontSize: "9pt", fontWeight: 400 }}>{a.status.state === "final" ? "final" : `in progress · ${a.status.pctDone} % of items done`}</span></h3>
      <p className="rp-p">{a.verdict}</p>
      <div className="rp-eva-track">
        <span className="rp-eva-band" style={{ left: at(t.estimated.low), width: `calc(${at(t.estimated.high)} - ${at(t.estimated.low)})` }} />
        <span className={`rp-eva-fill ${tone}`} style={{ width: at(t.actual.costUsd) }} />
        <span className="rp-eva-expected" style={{ left: at(t.estimated.expected) }} />
        <span className={`rp-eva-marker ${tone}`} style={{ left: at(t.actual.costUsd) }} />
      </div>
      <div className="rp-legend">
        <span><i className={`rp-eva-sw ${tone}`} />Actual <b>{money(t.actual.costUsd)}</b></span>
        <span><i style={{ background: "#282b34", width: "0.6mm" }} />Expected <b>{money(t.estimated.expected)}</b></span>
        <span><i style={{ background: "#efe7dc", border: "1px dashed #8a7a5e" }} />Range <b>{money(t.estimated.low)}–{money(t.estimated.high)}</b></span>
        <span>Δ <b className={pctClass(t.deltaPct)}>{pctText(t.deltaPct)}</b> · {t.withinRange ? "inside the range" : t.position === "over" ? "above the range" : "below the range"}</span>
      </div>

      <table className="rp-table" style={{ marginTop: "4mm" }}>
        <thead><tr><th>Agent</th><th>Role</th><th className="r">Estimated</th><th className="r">Actual</th><th className="r">Δ cost</th><th className="r">Tokens est. → actual</th><th className="r">Runs</th></tr></thead>
        <tbody>
          {a.agents.map((r) => (
            <tr key={r.agentId}>
              <td className="nowrap"><span className="rp-dot" style={{ background: r.color }} /><b>{r.name}</b>{r.miss ? <span className="rp-bad"> · miss</span> : null}</td>
              <td>{roleLabel(r)}</td>
              <td className="r rp-faint">{r.estimated ? money(r.estimated.costUsd) : "—"}</td>
              <td className="r"><b>{money(r.actual.costUsd)}</b></td>
              <td className={`r ${pctClass(r.deltaPct)}`}>{pctText(r.deltaPct)}</td>
              <td className="r">{r.estimated ? tokens(r.estimated.tokens) : "—"} → {tokens(r.actual.tokens)}</td>
              <td className="r">{r.estimated ? num(r.estimated.runs, r.estimated.runs % 1 ? 1 : 0) : "—"} → {r.actual.runs}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="rp-table">
        <thead><tr><th>Stage</th><th className="r">Estimated</th><th className="r">Actual</th><th className="r">Δ cost</th><th className="r">Δ tokens</th></tr></thead>
        <tbody>
          {a.stages.map((s) => (
            <tr key={s.stage}>
              <td>{s.label}{!s.complete ? <span className="rp-faint"> · in progress</span> : null}</td>
              <td className="r rp-faint">{s.estimatedUsd != null ? money(s.estimatedUsd) : "—"}</td>
              <td className="r"><b>{money(s.actualUsd)}</b></td>
              <td className={`r ${pctClass(s.deltaPct)}`}>{pctText(s.deltaPct)}</td>
              <td className={`r ${pctClass(s.tokensDeltaPct)}`}>{pctText(s.tokensDeltaPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="rp-p">
        <b>Scope:</b> {a.scope.estimated.stories ?? "—"} stories / {a.scope.estimated.points ?? "—"} points estimated → {a.scope.actual.stories} stories / {a.scope.actual.points} points in the backlog
        {a.scope.byCategory.some((c) => c.estimatedStories != null)
          ? ` (${a.scope.byCategory.filter((c) => c.actualStories || c.estimatedStories).map((c) => `${CATEGORY[c.category]?.label ?? c.category} ${c.estimatedStories ?? "—"}→${c.actualStories}`).join(", ")})`
          : ""}
        .{" "}
        <b>Time:</b> AI wall-clock {a.time.estimatedMinutes != null ? `${duration(a.time.estimatedMinutes * 60)} estimated → ` : ""}{duration(a.time.aiWallClockMs / 1000)} actual (time when at least one agent was working); {duration(a.time.elapsedMs / 1000)} elapsed including approval waits.
      </p>
    </div>
  );
}
