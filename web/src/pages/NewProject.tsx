import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Calculator, CheckCircle2, FileUp, Loader2, Play, Plus, Rocket, TriangleAlert, Users, Zap, FileText, X } from "lucide-react";
import { EstimateBreakdown } from "../components/EstimateBreakdown";
import { api, type Estimate, type Project } from "../lib/api";
import { useAgents, useMeta } from "../lib/queries";
import { hours, money, num, tokens } from "../lib/format";
import { AgentAvatar, Switch } from "../components/ui";
import { MiniBar } from "../components/Charts";
import { PathBar } from "../components/PathBar";
import { RepoFields, repoUrlError } from "../components/Repo";
import { toast } from "../lib/toast";
import { Field, Hint, Req } from "../components/Hint";
import { CodeReviewField, type CodeReviewMode } from "../components/CodeReviewField";
import { t } from "../lib/i18n";

const STAGES: { role: string; label: string }[] = [
  { role: "requirements", label: "Requirements" },
  { role: "architect", label: "Refinement" },
  { role: "planner", label: "Planning" },
  { role: "developer", label: "Build" },
  { role: "qa", label: "Peer test" },
  { role: "writer", label: "Docs" },
  { role: "release", label: "Release" },
];

interface EstimateResponse { uploadId: string | null; pdfName: string | null; pdfPages: number | null; pdfTokens: number | null; estimate: Estimate | null; reason?: string }

/** Hover text for an agent's cost: tokens per run × price, by kind. */
function agentCostTooltip(a: Estimate["agents"][number]) {
  const d = a.detail;
  if (!d) return `${num(a.calls)} calls`;
  const row = (label: string, n: number, price: number) => `${label}: ${num(n)} tok × $${price}/M = ${money((n * price) / 1e6)}`;
  return [
    `${a.name}: ${num(a.runs, 1)} runs × ${money(d.costPerRun)} per run = ${money(a.costUsd)}`,
    `Per run (${d.callsPerRun} calls, effort ${d.effort}):`,
    row("  input", d.perRun.input, d.prices.input),
    row("  cache write", d.perRun.cacheWrite, d.prices.cacheWrite),
    row("  cache read", d.perRun.cacheRead, d.prices.cacheRead),
    row("  output (incl. reasoning)", d.perRun.output, d.prices.output),
  ].join("\n");
}

export function EstimatePanel({ est, loading, compact, reason }: { est: Estimate | null; loading?: boolean; compact?: boolean; reason?: string }) {
  const { data: agents } = useAgents();
  const [showStories, setShowStories] = useState(false);
  const [showCalc, setShowCalc] = useState(false);
  if (!est) return <div className="empty small">{reason ?? "Add the requirements and choose agents to see an estimate."}</div>;
  const basisLabel = est.basis === "backlog" ? "From the backlog the analyst built" : est.basis === "document" ? "From the requirements document (local analysis — refined once the backlog exists)" : "Rough — no clear requirement structure found in the text";
  const max = Math.max(...est.agents.map((a) => a.costUsd), 0);
  return (
    <div className="col" style={{ gap: 14, opacity: loading ? 0.6 : 1, transition: "opacity .2s" }}>
      <div>
        <div className="label">{t("Estimated AI cost")}</div>
        <div className="row" style={{ alignItems: "baseline", gap: 10 }}>
          <span className="kpi-value accent" style={{ fontSize: compact ? 26 : 32 }}>{money(est.totalUsd)}</span>
          {loading && <Loader2 size={14} className="spin" color="var(--muted)" />}
        </div>
        <div className="small muted">likely range {money(est.lowUsd)} – {money(est.highUsd)}</div>
        <div className="calc-line">= sum of the agents below (runs × cost per run) · range = {money(est.totalUsd)} × {est.breakdown?.range.low ?? 0.6} … × {est.breakdown?.range.high ?? 1.7}</div>
        <div className="tiny" style={{ marginTop: 4, color: est.basis === "length" ? "var(--warn)" : "var(--muted)" }}>{basisLabel}</div>
        <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => setShowCalc(true)}><Calculator size={13} /> How this is calculated</button>
        {showCalc && <EstimateBreakdown est={est} onClose={() => setShowCalc(false)} />}
      </div>
      <div className="grid g3" style={{ gap: 8 }}>
        <div className="stat"><span className="v">{num(est.stories)}</span><span className="l">{est.basis === "backlog" ? "stories" : est.basis === "document" ? "stories found" : "stories (rough)"}</span></div>
        <div className="stat"><span className="v">{num(est.storyPoints)}</span><span className="l">story points</span></div>
        <div className="stat"><span className="v">{est.minutes < 90 ? `${Math.round(est.minutes)} min` : hours(est.minutes / 60)}</span><span className="l">{t("AI wall-clock")}</span></div>
      </div>
      <div className="col" style={{ gap: 6 }}>
        {est.agents.map((a) => {
          const ag = agents?.find((x) => x.id === a.agentId);
          return (
            <div key={a.agentId} className="col" style={{ gap: 1 }} title={agentCostTooltip(a)}>
              <div className="row small" style={{ gap: 8 }}>
                {ag && <AgentAvatar agent={ag} size={20} />}
                <span style={{ width: 64 }} className="ellipsis">{a.name}</span>
                <div style={{ flex: 1 }}><MiniBar value={a.costUsd} max={max} color={ag?.color ?? "var(--accent)"} /></div>
                <span className="num" style={{ width: 62, textAlign: "right" }}>{money(a.costUsd)}</span>
              </div>
              <div className="calc-line" style={{ paddingLeft: 28 }}>
                {a.detail
                  ? <>{num(a.runs, a.runs % 1 ? 1 : 0)} run{a.runs === 1 ? "" : "s"} × {money(a.detail.costPerRun)}/run · {tokens(a.detail.perRun.cacheRead + a.detail.perRun.cacheWrite + a.detail.perRun.input)} in + {tokens(a.detail.perRun.output)} out</>
                  : <>{num(a.calls)} calls · {tokens(a.inputTokens + a.cacheReadTokens + a.cacheWriteTokens)} in · {tokens(a.outputTokens)} out</>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="card" style={{ background: "var(--bg-2)", padding: 12 }}>
        <div className="row small" style={{ gap: 6, marginBottom: 6 }}><Users size={13} /> <b>Human team of {est.human.teamSize}</b></div>
        <div className="grid g3" style={{ gap: 8 }}>
          <div className="stat"><span className="v">{hours(est.human.hours)}</span><span className="l">effort</span></div>
          <div className="stat"><span className="v">{est.human.weeks.toFixed(1)} wk</span><span className="l">calendar</span></div>
          <div className="stat"><span className="v">{money(est.human.costUsd, 0)}</span><span className="l">cost</span></div>
        </div>
        {est.breakdown && (
          <div className="col" style={{ gap: 2, marginTop: 8 }}>
            <div className="calc-line">Effort = {num(est.breakdown.human.points)} pts × {est.breakdown.human.hoursPerPoint} h × {est.breakdown.human.overhead} = {hours(est.human.hours)}</div>
            <div className="calc-line">Calendar = {hours(est.human.hours)} ÷ ({est.human.teamSize} × {est.breakdown.human.hoursPerWeek} h/week) = {est.human.weeks.toFixed(1)} wk</div>
            <div className="calc-line">Cost = {hours(est.human.hours)} × {money(est.breakdown.human.rate)}/h = {money(est.human.costUsd, 0)}</div>
          </div>
        )}
        <div className="row small" style={{ marginTop: 10, gap: 6, color: "var(--good)" }}>
          <Zap size={13} /> ~{num(est.speedup)}× faster · {money(est.savingsUsd, 0)} cheaper
        </div>
        <div className="calc-line">Faster = ({hours(est.human.hours)} × 60 ÷ {est.human.teamSize}) ÷ {est.minutes < 90 ? `${Math.round(est.minutes)} min` : hours(est.minutes / 60)} AI · cheaper = {money(est.human.costUsd, 0)} − {money(est.totalUsd)}</div>
      </div>
      {est.detected && est.detected.stories.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <button type="button" className="btn sm ghost" style={{ alignSelf: "flex-start" }} onClick={() => setShowStories(!showStories)}>
            {showStories ? "Hide" : "Show"} the {est.detected.stories.length} stories this is based on
          </button>
          {showStories && (
            <div className="col" style={{ gap: 2, maxHeight: 260, overflow: "auto" }}>
              {est.detected.stories.map((s, i) => (
                <div key={i} className="row tiny" style={{ gap: 6 }} title={[s.epic, s.feature].filter(Boolean).join(" › ")}>
                  <span className="chip" style={{ fontSize: 10, padding: "0 6px" }}>{s.category.replace(/_/g, " ")}</span>
                  <span className="ellipsis" style={{ flex: 1 }}>{s.title}</span>
                  <span className="num faint">{s.points} pt</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {!compact && (
        <ul className="tiny faint" style={{ margin: 0, paddingLeft: 16 }}>
          {est.assumptions.map((a) => <li key={a}>{a}</li>)}
        </ul>
      )}
    </div>
  );
}

export default function NewProject() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: agents } = useAgents();
  const { data: meta } = useMeta();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [gates, setGates] = useState(true);
  const [parallelism, setParallelism] = useState(2);
  const [budget, setBudget] = useState(50);
  const [maxRework, setMaxRework] = useState(2);
  const [codeReview, setCodeReview] = useState<CodeReviewMode>("off");
  const [repo, setRepo] = useState({ url: "", branch: "main", push: false });
  const [est, setEst] = useState<EstimateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const uploaded = useRef<{ file: File; uploadId: string; tokens: number | null } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (meta) {
      setGates(meta.settings.defaultGates);
      setParallelism(meta.settings.defaultParallelism);
      setBudget(meta.settings.defaultBudgetUsd);
      setMaxRework(meta.settings.maxRework);
    }
  }, [meta]);
  useEffect(() => {
    if (agents && !selected) setSelected(agents.filter((a) => a.enabled && a.role !== "specialist").map((a) => a.id));
  }, [agents, selected]);

  const team = useMemo(() => agents?.filter((a) => selected?.includes(a.id)) ?? [], [agents, selected]);
  const roles = new Set(team.map((a) => a.role));

  // Re-estimate (debounced) whenever inputs change. The PDF is uploaded once and referenced afterwards.
  useEffect(() => {
    if (!selected) return;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        let res: EstimateResponse;
        if (file && uploaded.current?.file !== file) {
          const fd = new FormData();
          fd.append("pdf", file);
          fd.append("agentIds", JSON.stringify(selected));
          fd.append("description", description);
          fd.append("parallelism", String(parallelism));
          fd.append("maxRework", String(maxRework));
          fd.append("codeReview", codeReview);
          res = await api.post<EstimateResponse>("/projects/estimate", fd);
          if (res.uploadId) uploaded.current = { file, uploadId: res.uploadId, tokens: res.pdfTokens };
        } else {
          res = await api.post<EstimateResponse>("/projects/estimate", {
            agentIds: selected,
            description,
            parallelism,
            maxRework,
            codeReview,
            uploadId: file ? uploaded.current?.uploadId : undefined,
            pdfName: file?.name,
            pdfTokens: file ? uploaded.current?.tokens : undefined,
          });
        }
        setEst(res);
      } catch (e) {
        toast((e as Error).message, "bad");
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [file, selected, description, parallelism, maxRework, codeReview]);

  const create = useMutation({
    mutationFn: (start: boolean) =>
      api.post<Project>("/projects", {
        name: name.trim(),
        description,
        agentIds: selected,
        uploadId: file ? uploaded.current?.uploadId : undefined,
        pdfName: file?.name,
        pdfPages: est?.pdfPages,
        pdfTokens: est?.pdfTokens,
        estimate: est?.estimate ?? undefined,
        settings: { gates, parallelism, budgetUsd: budget, maxRework, codeReview, repo: { url: repo.url.trim(), branch: repo.branch.trim() || "main", push: repo.push } },
        start,
      }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      nav(`/p/${p.key}`);
    },
    onError: (e: Error) => toast(e.message, "bad"),
  });

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf")) return toast("Please choose a PDF file", "bad");
    setFile(f);
    if (!name) setName(f.name.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
  };
  const toggle = (id: string) => setSelected((s) => (s?.includes(id) ? s.filter((x) => x !== id) : [...(s ?? []), id]));
  // What still blocks "Create" — listed under the buttons so it's never a mystery.
  const missing = [
    !name.trim() && "a project name",
    !(file || description.trim().length > 20) && "the requirements (a PDF, or a description of at least a few sentences)",
    repoUrlError(repo.url) && (repo.url.trim() ? "a valid git repository URL" : "the git repository URL"),
    team.length === 0 && "at least one agent",
  ].filter(Boolean) as string[];
  const canCreate = missing.length === 0;
  const ordered = [...(agents ?? [])].sort((a, b) => (meta?.pipelineRoles.indexOf(a.role) ?? 9) - (meta?.pipelineRoles.indexOf(b.role) ?? 9));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("New project")}</h1>
          <div className="page-sub">{t("Drop the requirements PDF or describe the work, pick which agents to involve, and check the estimate before anything runs. Fields marked")} <Req /> {t("are required.")}</div>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 360px", alignItems: "start" }}>
        <div className="col" style={{ gap: 14 }}>
          <div className="card">
            <div className="card-head"><div className="card-title"><span className="code-tag">1</span> {t("Requirements")}<Req /></div><span className="card-sub">{t("A PDF, or a description of the work below")}</span></div>
            <div className="card-pad col" style={{ gap: 14 }}>
              {file ? (
                <div className="selectable on" style={{ alignItems: "center" }}>
                  <FileText size={22} color="var(--accent)" />
                  <div style={{ flex: 1 }}>
                    <div className="strong">{file.name}</div>
                    <div className="small muted">
                      {(file.size / 1024).toFixed(0)} KB
                      {est?.pdfPages ? ` · ${est.pdfPages} pages` : ""}
                      {est?.estimate ? ` · ~${tokens(est.estimate.pdfTokens)} tokens${est.pdfTokens ? " (counted)" : " (estimated)"}` : ""}
                    </div>
                  </div>
                  <button className="btn ghost sm icon" onClick={() => { setFile(null); uploaded.current = null; }} aria-label="Remove"><X size={14} /></button>
                </div>
              ) : (
                <Hint text="The customer's requirements document (PDF, up to 32 MB). Its numbered sections become epics and features, and each requirement becomes a story." block>
                <div
                  className={`dropzone ${drag ? "drag" : ""}`}
                  onClick={() => inputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}
                >
                  <FileUp size={26} color="var(--accent)" />
                  <div className="strong" style={{ marginTop: 8 }}>{t("Drop the requirements PDF here")}{!description.trim() && <Req />}</div>
                  <div className="small muted">{t("or click to browse · up to 32 MB · the analyst reads it natively, tables and diagrams included")}</div>
                  <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => pick(e.target.files?.[0])} />
                </div>
                </Hint>
              )}
              <Field label={t("Project name")} required help="Name of the project. A short key (e.g. NFS) is generated from it for work item references and the project tab."><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("e.g. Task tracker")} /></Field>
              <RepoFields {...repo} onChange={setRepo} />
              <Field label={file ? t("Context for the team (optional with a PDF)") : t("Context for the team — describe the requirements (no PDF)")} required={!file} help="Extra context every agent receives: client, goals, constraints, technical details, priorities. Without a PDF, describe the requirements here — each sentence with 'must', 'shall' or 'should' becomes a story.">
                <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("Client, goals, constraints, technical details, what matters most… Without a PDF, describe the problem here.")} />
              </Field>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="card-title"><span className="code-tag">2</span> {t("Team")}<Req /></div>
              <span className="card-sub">{t("{n} agent(s) selected", { n: team.length })}</span>
            </div>
            <div className="card-pad col" style={{ gap: 14 }}>
              <PathBar
                compact
                steps={STAGES.map((st) => ({
                  key: st.role,
                  label: st.label,
                  status: roles.has(st.role) ? "done" : "skipped",
                  colors: team.filter((x) => x.role === st.role).map((x) => x.color),
                  help: roles.has(st.role) ? "Included — an agent on the team owns this stage." : "No agent with this role is selected, so the stage will be skipped.",
                }))}
              />
              {!roles.has("developer") && <div className="banner warn small"><TriangleAlert size={14} /> Without a developer the project stops after planning — useful for estimation-only runs.</div>}
              <div className="grid g2">
                {ordered.map((a) => {
                  const on = !!selected?.includes(a.id);
                  return (
                    <Hint key={a.id} text={`${on ? "Remove" : "Add"} ${a.name} (${a.title}). ${a.description}`} block>
                    <div className={`selectable ${on ? "on" : ""}`} onClick={() => toggle(a.id)} style={{ opacity: a.enabled ? 1 : 0.5 }}>
                      <input type="checkbox" checked={on} readOnly style={{ accentColor: "var(--accent)", marginTop: 4 }} />
                      <AgentAvatar agent={a} size={34} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="row"><span className="strong">{a.name}</span><span className="spacer" /><span className="tiny mono faint">{a.model.replace("claude-", "")}</span></div>
                        <div className="small muted ellipsis">{a.title}</div>
                      </div>
                    </div>
                    </Hint>
                  );
                })}

              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="card-title"><span className="code-tag">3</span> {t("Run settings")}</div></div>
            <div className="card-pad grid g4" style={{ gap: 16 }}>
              <Field label={t("Approval gates")} help="On: the pipeline pauses for you after the backlog, after the plan and before release. Off (autopilot): it runs end to end without stopping."><div className="row" style={{ height: 34 }}><Switch on={gates} onChange={setGates} /><span className="small muted">{gates ? t("On") : t("Autopilot")}</span></div></Field>
              <Field label={t("Parallel lanes")} help="How many stories are built, tested and documented at the same time. More lanes = faster, same total cost."><input className="input" type="number" min={1} max={8} value={parallelism} onChange={(e) => setParallelism(Math.max(1, Number(e.target.value)))} /></Field>
              <Field label={t("Budget cap (USD)")} help="The pipeline pauses when the project's AI cost reaches this amount; you can raise it and resume. 0 = no limit."><input className="input" type="number" min={0} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></Field>
              <Field label={t("Max QA rework")} help="How many times QA can send a story back to the developer before it's marked Blocked for you to review."><input className="input" type="number" min={0} max={5} value={maxRework} onChange={(e) => setMaxRework(Number(e.target.value))} /></Field>
              {roles.has("architect") && <CodeReviewField value={codeReview} onChange={setCodeReview} />}
            </div>
          </div>
        </div>

        <div className="card card-pad col" style={{ gap: 16, position: "sticky", top: 16 }}>
          <div className="card-title"><Rocket size={15} /> {t("Estimate")}</div>
          <EstimatePanel est={est?.estimate ?? null} loading={loading} reason={est?.reason} />
          {meta?.mode === "simulation" && <div className="banner accent tiny">{t("Simulation mode: the project runs with scripted agents, for free, and no checks are run. Switch to Live in Settings → General before creating the project to run it for real.")}</div>}
          {meta?.mode === "live" && meta.backend === "subscription" && <div className="banner accent tiny">{t("Live on your Claude plan: no API charges. The estimate shows what the same run would cost on the API — a measure of how much of the plan's usage it takes.")}</div>}
          {est?.estimate && budget > 0 && est.estimate.highUsd > budget && <div className="banner warn tiny"><TriangleAlert size={13} /> The high estimate exceeds your {money(budget)} budget — the run may pause before finishing.</div>}
          <div className="col" style={{ gap: 8 }}>
            <button className="btn primary" style={{ justifyContent: "center", height: 38 }} disabled={!canCreate || create.isPending} onClick={() => create.mutate(true)}><Play size={15} /> {t("Create & start")}</button>
            <button className="btn" style={{ justifyContent: "center" }} disabled={!canCreate || create.isPending} onClick={() => create.mutate(false)}>{t("Create without starting")}</button>
            {missing.length > 0 && <div className="tiny" style={{ color: "var(--muted)" }}><Req /> {t("Still needed:")} {missing.join(" · ")}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
