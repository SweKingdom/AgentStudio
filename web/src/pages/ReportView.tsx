import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { Printer } from "lucide-react";
import siroccoLogo from "../assets/sirocco-logo.svg?raw";
import { api, storyAssetBase } from "../lib/api";
import type { AccuracyResult } from "../components/EstimateAccuracy";
import { CATEGORY, DOC_KINDS, STATE_GROUP, TYPE } from "../lib/constants";
import { dateTime, duration, hours, money, num } from "../lib/format";
import { Markdown } from "../components/ui";
import { ReportAccuracy } from "../components/EstimateAccuracy";

interface RItem {
  id: string; code: string; type: string; title: string; category: string; state: string; points: number | null; sprint: number | null;
  moscow: string | null; rework: number; costUsd: number; userStory: string; qa: { pass: number; fail: number; blocked: number }; smoke: boolean;
  openQuestions: number; seconds: { development: number; qa: number; documentation: number }; leadTimeSeconds: number | null; humanHours: number | null;
}
interface Report {
  generatedAt: string;
  project: { key: string; name: string; description: string; status: string; mode: string; createdAt: string; startedAt: string | null; finishedAt: string | null; pdfName: string | null; repo: { url: string; branch: string } | null; gates: boolean; budgetUsd: number };
  kpis: {
    epics: number; features: number; items: number; points: number; deployed: number; releaseReady: number; inProgress: number; notStarted: number; held: number; blocked: number;
    costUsd: number; calls: number; tokens: number; aiBusySeconds: number; simulated: boolean; elapsedSeconds: number; humanHours: number; humanCostUsd: number; speedup: number | null;
    reworkLoops: number; firstPassYield: number | null; qaChecks: { pass: number; fail: number; blocked: number }; openQuestions: number; commits: number;
  };
  team: { id: string; name: string; title: string; role: string; model: string; effort: string; color: string; version: number; costUsd: number; calls: number; runs: number; busySeconds: number }[];
  epics: { code: string; title: string; background: string; features: { code: string; title: string; items: RItem[] }[] }[];
  orphans: RItem[];
  costByStage: { stage: string; cost: number; calls: number }[];
  releases: { version: string; date: string; validationOk: boolean | null; validationMode: string | null; items: number }[];
  questions: { question: string; answer: string | null; item_code: string | null; created_at: string; answered_at: string | null }[];
  documents: { id: string; kind: string; title: string; content: string; version: number; updated_at: string }[];
  taskDocuments: { id: string; kind: string; title: string; content: string; version: number; updated_at: string; item_code: string | null }[];
}

/** claude-opus-5-5 → Opus 5.5 */
const modelName = (m: string) => m.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/^\w/, (c) => c.toUpperCase());

const STATUS: Record<string, string> = { completed: "Completed", running: "In progress", paused: "Paused", awaiting_approval: "Awaiting approval", ready: "Not started", failed: "Failed" };

function Chip({ color, children }: { color: string; children: ReactNode }) {
  return <span className="rp-chip" style={{ color: `color-mix(in srgb, ${color} 60%, #1c1e25)`, background: `color-mix(in srgb, ${color} 13%, white)`, borderColor: `color-mix(in srgb, ${color} 35%, white)` }}>{children}</span>;
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  return <span className="rp-bar"><i style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%`, background: color }} /></span>;
}

function Section({ n, title, id, children, pageBreak = true }: { n: string; title: string; id: string; children: ReactNode; pageBreak?: boolean }) {
  return (
    <section id={id} className={`rp-section ${pageBreak ? "rp-break" : ""}`}>
      <h2 className="rp-h2"><span className="rp-num">{n}</span>{title}</h2>
      {children}
    </section>
  );
}

function ItemsTable({ items }: { items: RItem[] }) {
  return (
    <table className="rp-table">
      <thead><tr><th style={{ width: 66 }}>Item</th><th>Title</th><th style={{ width: 98 }}>Category</th><th style={{ width: 112 }}>State</th><th className="r" style={{ width: 32 }}>Pts</th><th style={{ width: 62 }}>QA</th><th className="r" style={{ width: 52 }}>Cost</th></tr></thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id}>
            <td className="mono">{i.code}</td>
            <td>{i.title}{i.openQuestions ? <span className="rp-warn"> · ❓ {i.openQuestions} open</span> : null}{i.rework ? <span className="rp-bad"> · ↺ {i.rework}</span> : null}</td>
            <td><Chip color={CATEGORY[i.category]?.color ?? "#929190"}>{CATEGORY[i.category]?.label ?? i.category}</Chip></td>
            <td><Chip color={STATE_GROUP[i.state]?.color ?? "#929190"}>{i.state}</Chip></td>
            <td className="r">{i.points ?? "—"}</td>
            <td className="nowrap">{i.qa.pass || i.qa.fail ? <><span className="rp-good">✓{i.qa.pass}</span>{i.qa.fail ? <span className="rp-bad"> ✗{i.qa.fail}</span> : null}</> : <span className="rp-faint">—</span>}</td>
            <td className="r">{i.costUsd ? money(i.costUsd) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ReportView() {
  const loc = useLocation();
  const key = loc.pathname.split("/")[2];
  const q = new URLSearchParams(loc.search);
  const withTasks = q.get("tasks") === "1";
  const { data: r } = useQuery({ queryKey: ["report", key], queryFn: () => api.get<Report>(`/projects/${key}/report`) });
  const { data: acc, isFetched: accDone } = useQuery({ queryKey: ["report", key, "accuracy"], queryFn: () => api.get<AccuracyResult>(`/projects/${key}/accuracy`), retry: false });

  useEffect(() => {
    document.documentElement.dataset.theme = "light";
    if (!r || !accDone) return;
    document.title = `${r.project.key} — ${r.project.name} — Project report`;
    if (q.get("auto")) setTimeout(() => window.print(), 600);
  }, [r, accDone]);

  if (!r) return <div className="rp-loading">Preparing the report…</div>;
  const k = r.kpis;
  const p = r.project;
  const allItems = [...r.epics.flatMap((e) => e.features.flatMap((f) => f.items)), ...r.orphans];
  const reworked = allItems.filter((i) => i.rework > 0);
  const maxAgent = Math.max(0, ...r.team.map((t) => t.costUsd));
  const tested = allItems.filter((i) => i.seconds.qa > 0);
  const avg = (key: keyof RItem["seconds"]) => {
    const v = allItems.map((i) => i.seconds[key]).filter((x) => x > 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const stateSegs = [
    { label: "Deployed", n: k.deployed, color: "#3f8f1a" },
    { label: "Release ready", n: k.releaseReady, color: "#b2a792" },
    { label: "In progress", n: k.inProgress, color: "#2c57e8" },
    { label: "Not started", n: k.notStarted - k.held, color: "#bebdbd" },
    { label: "On hold (questions)", n: k.held, color: "#b98500" },
    { label: "Blocked", n: k.blocked, color: "#d4462a" },
  ].filter((s) => s.n > 0);
  const docs = r.documents;
  const sections = [
    { id: "summary", title: "Executive summary" },
    { id: "team", title: "Team" },
    { id: "scope", title: "Scope & backlog" },
    { id: "quality", title: "Quality" },
    { id: "timing", title: "Delivery timing" },
    { id: "cost", title: "Cost" },
    { id: "releases", title: "Releases" },
    { id: "questions", title: "Open questions & decisions" },
    ...(docs.length ? [{ id: "documents", title: "Project documents" }] : []),
  ];
  const sn = (id: string) => String(sections.findIndex((s) => s.id === id) + 1);

  return (
    <div className="rp">
      {/* Running header/footer on every page except the cover (Chrome page-margin boxes). */}
      <style>{`
        @page { size: A4; margin: 18mm 15mm 18mm 15mm;
          @top-left { content: "${p.key} · ${p.name.replace(/"/g, "'")} — Project report"; font: 8pt "Nunito Sans", sans-serif; color: #929190; }
          @top-right { content: "Sirocco Group · SiroccoARM"; font: 8pt "Nunito Sans", sans-serif; color: #929190; }
          @bottom-left { content: "Generated ${dateTime(r.generatedAt)}${k.simulated ? " · simulation" : ""}"; font: 8pt "Nunito Sans", sans-serif; color: #929190; }
          @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt "Nunito Sans", sans-serif; color: #929190; }
        }
        @page :first { margin: 0; @top-left { content: none; } @top-right { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }
      `}</style>

      <div className="rp-toolbar no-print">
        <span>Project report · {sections.length} sections{withTasks ? ` + ${r.taskDocuments.length} task documents` : ""} · use “Save as PDF” in the print dialog (A4)</span>
        <span className="spacer" />
        <a className="btn sm" href={`/print/${p.key}/report${withTasks ? "" : "?tasks=1"}`}>{withTasks ? "Without task appendix" : "Include task appendix"}</a>
        <button className="btn primary" onClick={() => window.print()}><Printer size={14} /> Print / Save as PDF</button>
      </div>

      {/* ---------------------------------------------------------------- cover */}
      <div className="rp-cover">
        <div className="rp-cover-top">
          <span className="rp-cover-logo" dangerouslySetInnerHTML={{ __html: siroccoLogo }} />
          <span className="rp-cover-eyebrow">Project report</span>
        </div>
        <div className="rp-cover-body">
          <div className="rp-cover-key">{p.key}</div>
          <h1 className="rp-cover-title">{p.name}</h1>
          <div className="rp-cover-status">{STATUS[p.status] ?? p.status} · {k.deployed}/{k.items} items deployed · {num(k.points)} story points</div>
          <dl className="rp-facts">
            <div><dt>Requirements</dt><dd>{p.pdfName ?? "Project description"}</dd></div>
            <div><dt>Repository</dt><dd className="mono">{p.repo ? `${p.repo.url} (${p.repo.branch})` : "Not set"}</dd></div>
            <div><dt>Started</dt><dd>{p.startedAt ? dateTime(p.startedAt) : "—"}</dd></div>
            <div><dt>{p.finishedAt ? "Finished" : "Report date"}</dt><dd>{dateTime(p.finishedAt ?? r.generatedAt)}</dd></div>
            <div><dt>AI team</dt><dd>{r.team.map((t) => t.name).join(", ")}</dd></div>
          </dl>
          {k.simulated && <div className="rp-sim">Produced in simulation mode: agents ran without calling the Claude API. Costs are estimates at real model prices; test evidence is simulated.</div>}
        </div>
        <div className="rp-cover-band">
          <span>Prepared by <b>SiroccoARM</b> — Agent Relationship Management</span>
          <span>{dateTime(r.generatedAt)}</span>
        </div>
      </div>

      {/* ---------------------------------------------------------------- contents */}
      <section className="rp-section">
        <h2 className="rp-h2">Contents</h2>
        <ol className="rp-toc">
          {sections.map((s, i) => (
            <li key={s.id}><a href={`#${s.id}`}><span className="rp-num">{i + 1}</span>{s.title}</a></li>
          ))}
          {docs.map((d, i) => (
            <li key={d.id} className="rp-toc-sub"><a href={`#doc-${d.id}`}>{sn("documents")}.{i + 1} {DOC_KINDS[d.kind] ?? d.title}</a></li>
          ))}
          {withTasks && r.taskDocuments.length > 0 && <li><a href="#appendix"><span className="rp-num">A</span>Appendix — task documents & test reports</a></li>}
        </ol>
      </section>

      {/* ---------------------------------------------------------------- 1. summary */}
      <Section n={sn("summary")} title="Executive summary" id="summary">
        <p className="rp-lead">
          <b>{p.name}</b> covers <b>{k.items} work items ({num(k.points)} story points)</b> across {k.epics} epics and {k.features} features, derived from {p.pdfName ? <i>{p.pdfName}</i> : "the project description"}.{" "}
          {k.deployed} {k.deployed === 1 ? "is" : "are"} deployed{k.releaseReady ? `, ${k.releaseReady} ready for release` : ""}{k.inProgress ? `, ${k.inProgress} in progress` : ""}{k.held ? `, and ${k.held} on hold until open questions are answered` : ""}.{" "}
          The AI team spent <b>{money(k.costUsd)}</b> over {duration(k.elapsedSeconds)} of elapsed time — a human team of four would need an estimated <b>{hours(k.humanHours)}</b> (≈{money(k.humanCostUsd, 0)}).{" "}
          Peer testing recorded {k.qaChecks.pass} passing checks and {k.qaChecks.fail} failure{k.qaChecks.fail === 1 ? "" : "s"}; {k.reworkLoops} rework loop{k.reworkLoops === 1 ? " was" : "s were"} needed{k.firstPassYield != null ? `, a first-pass yield of ${Math.round(k.firstPassYield * 100)}%` : ""}.
        </p>
        <div className="rp-kpis">
          {[
            ["Scope", `${k.items} items`, `${num(k.points)} pts · ${k.epics} epics`],
            ["Deployed", `${k.deployed}/${k.items}`, `${k.releaseReady} release-ready`],
            ["AI cost", money(k.costUsd), `${num(k.calls)} model calls${k.simulated ? " · simulated" : ""}`],
            ["Elapsed", duration(k.elapsedSeconds), `AI busy ${duration(k.aiBusySeconds)}`],
            ["Human equivalent", hours(k.humanHours), k.speedup ? `~${num(k.speedup)}× faster` : "team of 4"],
            ["First-pass yield", k.firstPassYield != null ? `${Math.round(k.firstPassYield * 100)}%` : "—", `${k.reworkLoops} rework loop(s)`],
          ].map(([l, v, f]) => (
            <div key={l} className="rp-kpi"><div className="rp-kpi-l">{l}</div><div className="rp-kpi-v">{v}</div><div className="rp-kpi-f">{f}</div></div>
          ))}
        </div>
        <h3 className="rp-h3">Where the work stands</h3>
        <div className="rp-stack">{stateSegs.map((s) => <i key={s.label} style={{ width: `${(s.n / Math.max(1, k.items)) * 100}%`, background: s.color }} />)}</div>
        <div className="rp-legend">{stateSegs.map((s) => <span key={s.label}><i style={{ background: s.color }} />{s.label} <b>{s.n}</b></span>)}</div>
        {p.description && (<><h3 className="rp-h3">Context from the product owner</h3><div className="rp-quote"><Markdown>{p.description}</Markdown></div></>)}
      </Section>

      {/* ---------------------------------------------------------------- 2. team */}
      <Section n={sn("team")} title="Team" id="team">
        <p className="rp-p">The delivery pipeline is run by {r.team.length} AI agents, each with its own role, model and knowledge. Runs, cost and busy time cover this project only.</p>
        <table className="rp-table">
          <thead><tr><th>Agent</th><th>Role</th><th>Model</th><th className="r">Runs</th><th className="r">Calls</th><th className="r">Busy</th><th style={{ width: 110 }}>Share</th><th className="r">Cost</th></tr></thead>
          <tbody>
            {r.team.map((t) => (
              <tr key={t.id}>
                <td className="nowrap"><span className="rp-dot" style={{ background: t.color }} /><b>{t.name}</b> <span className="rp-faint small">v{t.version}</span></td>
                <td>{t.title}</td>
                <td className="nowrap">{modelName(t.model)}<div className="rp-faint small">{t.effort} effort</div></td>
                <td className="r">{t.runs}</td><td className="r">{t.calls}</td><td className="r">{duration(t.busySeconds)}</td>
                <td><Bar value={t.costUsd} max={maxAgent} color={t.color} /></td>
                <td className="r"><b>{money(t.costUsd)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* ---------------------------------------------------------------- 3. scope */}
      <Section n={sn("scope")} title="Scope & backlog" id="scope">
        <p className="rp-p">Epics → features → work items as built by the requirements analyst and refined by the architect. ↺ marks QA rework; ❓ marks items with unanswered questions.</p>
        {r.epics.map((e) => (
          <div key={e.code} className="rp-epic">
            <h3 className="rp-h3"><Chip color={TYPE.epic.color}>{e.code}</Chip> {e.title}</h3>
            {e.background && <p className="rp-p rp-faint">{e.background}</p>}
            {e.features.map((f) => (
              <div key={f.code} className="rp-feature">
                <h4 className="rp-h4"><span className="mono">{f.code}</span> {f.title} <span className="rp-faint">· {f.items.length} item(s) · {f.items.reduce((n, i) => n + (i.points ?? 0), 0)} pts</span></h4>
                <ItemsTable items={f.items} />
              </div>
            ))}
          </div>
        ))}
        {r.orphans.length > 0 && (<div className="rp-epic"><h3 className="rp-h3">Other items</h3><ItemsTable items={r.orphans} /></div>)}
      </Section>

      {/* ---------------------------------------------------------------- 4. quality */}
      <Section n={sn("quality")} title="Quality" id="quality">
        <div className="rp-kpis rp-kpis-4">
          <div className="rp-kpi"><div className="rp-kpi-l">Checks passed</div><div className="rp-kpi-v rp-good">{k.qaChecks.pass}</div><div className="rp-kpi-f">one or more per acceptance criterion</div></div>
          <div className="rp-kpi"><div className="rp-kpi-l">Failures found</div><div className="rp-kpi-v rp-bad">{k.qaChecks.fail}</div><div className="rp-kpi-f">sent back to development</div></div>
          <div className="rp-kpi"><div className="rp-kpi-l">Not testable</div><div className="rp-kpi-v">{k.qaChecks.blocked}</div><div className="rp-kpi-f">setup or information missing</div></div>
          <div className="rp-kpi"><div className="rp-kpi-l">Peer-tested items</div><div className="rp-kpi-v">{tested.length}</div><div className="rp-kpi-f">each with a test report and evidence</div></div>
        </div>
        <h3 className="rp-h3">Rework</h3>
        {reworked.length ? (
          <table className="rp-table">
            <thead><tr><th style={{ width: 66 }}>Item</th><th>Title</th><th className="r">Loops</th><th>Final QA</th></tr></thead>
            <tbody>{reworked.map((i) => <tr key={i.id}><td className="mono">{i.code}</td><td>{i.title}</td><td className="r rp-bad">{i.rework}</td><td>{i.qa.fail && !["Release Ready", "Smoke Testing", "Deployed (Done)", "Ready for UAT"].includes(i.state) ? <span className="rp-bad">Still failing</span> : <span className="rp-good">Approved after fixes</span>}</td></tr>)}</tbody>
          </table>
        ) : <p className="rp-p">No story needed rework — every peer test passed first time.</p>}
        <p className="rp-p rp-faint">Each story's test report (steps, expected vs found, screenshots per acceptance criterion) is in {withTasks ? "Appendix A" : "the task appendix (export with “Include task appendix”)"}.</p>
      </Section>

      {/* ---------------------------------------------------------------- 5. timing */}
      <Section n={sn("timing")} title="Delivery timing" id="timing">
        <div className="rp-kpis rp-kpis-4">
          <div className="rp-kpi"><div className="rp-kpi-l">Avg development</div><div className="rp-kpi-v">{duration(avg("development"))}</div><div className="rp-kpi-f">per item, all iterations</div></div>
          <div className="rp-kpi"><div className="rp-kpi-l">Avg peer test</div><div className="rp-kpi-v">{duration(avg("qa"))}</div><div className="rp-kpi-f">per item</div></div>
          <div className="rp-kpi"><div className="rp-kpi-l">Avg documentation</div><div className="rp-kpi-v">{duration(avg("documentation"))}</div><div className="rp-kpi-f">per item</div></div>
          <div className="rp-kpi"><div className="rp-kpi-l">Elapsed</div><div className="rp-kpi-v">{duration(k.elapsedSeconds)}</div><div className="rp-kpi-f">including approval waits</div></div>
        </div>
        <table className="rp-table">
          <thead><tr><th style={{ width: 66 }}>Item</th><th>Title</th><th className="r">Dev</th><th className="r">Test</th><th className="r">Docs</th><th className="r">Lead time</th><th className="r">Human est.</th></tr></thead>
          <tbody>
            {allItems.filter((i) => i.leadTimeSeconds).map((i) => (
              <tr key={i.id}><td className="mono">{i.code}</td><td>{i.title}</td><td className="r">{duration(i.seconds.development)}</td><td className="r">{duration(i.seconds.qa)}</td><td className="r">{duration(i.seconds.documentation)}</td><td className="r"><b>{duration(i.leadTimeSeconds)}</b></td><td className="r rp-faint">{hours(i.humanHours)}</td></tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* ---------------------------------------------------------------- 6. cost */}
      <Section n={sn("cost")} title="Cost" id="cost">
        <div className="rp-kpis rp-kpis-4">
          <div className="rp-kpi"><div className="rp-kpi-l">Total AI cost</div><div className="rp-kpi-v">{money(k.costUsd)}</div><div className="rp-kpi-f">{k.simulated ? "simulated at real prices" : "billed usage"}</div></div>
          <div className="rp-kpi"><div className="rp-kpi-l">Per story point</div><div className="rp-kpi-v">{money(k.points ? k.costUsd / k.points : 0)}</div><div className="rp-kpi-f">{num(k.points)} pts</div></div>
          <div className="rp-kpi"><div className="rp-kpi-l">Human-team cost</div><div className="rp-kpi-v">{money(k.humanCostUsd, 0)}</div><div className="rp-kpi-f">{hours(k.humanHours)} estimated</div></div>
          <div className="rp-kpi"><div className="rp-kpi-l">Tokens</div><div className="rp-kpi-v">{num(k.tokens / 1000)}k</div><div className="rp-kpi-f">{num(k.calls)} model calls</div></div>
        </div>
        <h3 className="rp-h3">By stage</h3>
        <table className="rp-table">
          <thead><tr><th>Stage</th><th className="r">Calls</th><th style={{ width: 180 }}>Share</th><th className="r">Cost</th></tr></thead>
          <tbody>{r.costByStage.map((s) => <tr key={s.stage}><td style={{ textTransform: "capitalize" }}>{s.stage}</td><td className="r">{s.calls}</td><td><Bar value={s.cost} max={Math.max(...r.costByStage.map((x) => x.cost))} color="#b2a792" /></td><td className="r"><b>{money(s.cost)}</b></td></tr>)}</tbody>
        </table>
        {acc?.available && <ReportAccuracy a={acc} />}
      </Section>

      {/* ---------------------------------------------------------------- 7. releases */}
      <Section n={sn("releases")} title="Releases" id="releases" pageBreak={false}>
        {r.releases.length ? (
          <table className="rp-table">
            <thead><tr><th>Version</th><th>Date</th><th className="r">Items</th><th>Validation</th><th>Repository tag</th></tr></thead>
            <tbody>{r.releases.map((x) => <tr key={x.version}><td><b>v{x.version}</b></td><td>{dateTime(x.date)}</td><td className="r">{x.items}</td><td>{x.validationOk == null ? "—" : x.validationOk ? <span className="rp-good">✓ passed</span> : <span className="rp-bad">✗ failed</span>} <span className="rp-faint">{x.validationMode}</span></td><td className="mono">v{x.version}</td></tr>)}</tbody>
          </table>
        ) : <p className="rp-p">No release has been published yet{k.releaseReady ? ` — ${k.releaseReady} item(s) are ready` : ""}.</p>}
        <p className="rp-p rp-faint">{k.commits} commits in {p.repo ? p.repo.url : "the local repository"} (local; nothing pushed).</p>
      </Section>

      {/* ---------------------------------------------------------------- 8. questions */}
      <Section n={sn("questions")} title="Open questions & decisions" id="questions" pageBreak={false}>
        {r.questions.length ? (
          <table className="rp-table">
            <thead><tr><th style={{ width: 66 }}>Item</th><th>Question</th><th style={{ width: "38%" }}>Decision</th></tr></thead>
            <tbody>{r.questions.map((x, i) => <tr key={i}><td className="mono">{x.item_code ?? "—"}</td><td>{x.question}</td><td>{x.answer ? x.answer : <span className="rp-warn">Open — awaiting an answer</span>}</td></tr>)}</tbody>
          </table>
        ) : <p className="rp-p">The agents raised no questions.</p>}
      </Section>

      {/* ---------------------------------------------------------------- 9. documents */}
      {docs.length > 0 && (
        <Section n={sn("documents")} title="Project documents" id="documents">
          <p className="rp-p">Living documents maintained by the agents, as of this report.</p>
          {docs.map((d, i) => (
            <div key={d.id} id={`doc-${d.id}`} className={`rp-doc ${i ? "rp-break" : ""}`}>
              <div className="rp-doc-head"><span className="rp-num">{sn("documents")}.{i + 1}</span>{DOC_KINDS[d.kind] ?? d.title}<span className="rp-faint"> · v{d.version} · {dateTime(d.updated_at)}</span></div>
              <Markdown>{d.content}</Markdown>
            </div>
          ))}
        </Section>
      )}

      {/* ---------------------------------------------------------------- appendix */}
      {withTasks && r.taskDocuments.length > 0 && (
        <section id="appendix" className="rp-section rp-break">
          <h2 className="rp-h2"><span className="rp-num">A</span>Appendix — task documents & test reports</h2>
          {r.taskDocuments.map((d, i) => (
            <div key={d.id} className={`rp-doc ${i ? "rp-break" : ""}`}>
              <div className="rp-doc-head"><span className="mono">{d.item_code}</span> · {DOC_KINDS[d.kind] ?? d.kind}<span className="rp-faint"> · v{d.version}</span></div>
              <Markdown assetBase={d.item_code ? storyAssetBase(p.key, d.item_code) : undefined}>{d.content}</Markdown>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
