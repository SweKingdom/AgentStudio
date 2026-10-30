import { useEffect, useMemo, useState } from "react";
import NotFound from "./NotFound";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, Eye, PenLine, RotateCcw, Save, Sparkles, Trash2, Wrench, Brain, UserRound, FileCode2, History, MessageSquare, GitCompare } from "lucide-react";
import { api, type AgentDetail, type AgentVersion, type Knowledge } from "../lib/api";
import { Field, Hint } from "../components/Hint";
import { openChat } from "../components/Modals";
import { AddOrgModal, OrgPicker } from "../components/Orgs";
import { Rocket } from "lucide-react";
import { useMeta } from "../lib/queries";
import { ago, duration, money, num, tokens } from "../lib/format";
import { AGENT_COLORS, AGENT_ICONS } from "../lib/constants";
import { AgentAvatar, Icon, Markdown, Modal, Seg, Switch } from "../components/ui";
import { toast } from "../lib/toast";
import { PageSkeleton } from "../components/Skeleton";

type Draft = Pick<AgentDetail, "name" | "name_story" | "title" | "description" | "system_prompt" | "model" | "effort" | "color" | "icon" | "knowledge" | "custom_knowledge" | "tools" | "config" | "max_turns" | "enabled">;

const CUSTOM_TEMPLATE = `## How I work on this team
-

## Conventions I must follow
-

## Things to avoid
-
`;

export default function AgentEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: meta } = useMeta();
  const { data: agent, error: agentError } = useQuery({ queryKey: ["agent", id], queryFn: () => api.get<AgentDetail>(`/agents/${id}`), retry: false });
  const { data: packs } = useQuery({ queryKey: ["knowledge"], queryFn: () => api.get<Knowledge[]>("/knowledge") });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [customMode, setCustomMode] = useState<"write" | "preview">("write");
  const [showPrompt, setShowPrompt] = useState(false);
  const [showAllPacks, setShowAllPacks] = useState(false);
  const [addingOrg, setAddingOrg] = useState(false);

  useEffect(() => setDraft(null), [id]);
  useEffect(() => {
    if (agent && agent.id === id && !draft) {
      const { name, title, description, system_prompt, model, effort, color, icon, knowledge, custom_knowledge, tools, config, max_turns, enabled } = agent;
      setDraft({ name, name_story: agent.name_story ?? "", title, description, system_prompt, model, effort, color, icon, knowledge, custom_knowledge, tools, config: config ?? {}, max_turns, enabled });
    }
  }, [agent, draft]);

  const role = meta?.roles.find((r) => r.role === agent?.role);
  const dirty = useMemo(() => {
    if (!agent || !draft) return false;
    return (Object.keys(draft) as (keyof Draft)[]).some((k) => JSON.stringify(draft[k]) !== JSON.stringify(agent[k]));
  }, [agent, draft]);

  const save = useMutation({
    mutationFn: () => api.put<AgentDetail>(`/agents/${id}`, draft),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent", id] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      setDraft(null);
      toast("Agent saved");
    },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const reset = useMutation({
    mutationFn: () => api.post(`/agents/${id}/reset`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["agent", id] }); setDraft(null); toast("Prompt, knowledge and tools reset to role defaults"); },
  });
  const del = useMutation({
    mutationFn: () => api.del(`/agents/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["agents"] }); nav("/agents"); toast("Agent deleted"); },
    onError: (e: Error) => toast(e.message, "bad"),
  });

  if (agentError) return <NotFound title="Agent not found" message="This agent doesn't exist or it was deleted." />;
  if (!agent || !draft || !meta) return <PageSkeleton />;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const model = meta.models.find((m) => m.id === draft.model);
  const roleDefaults = new Set(role?.knowledge ?? []);
  const visiblePacks = (packs ?? []).filter((p) => showAllPacks || roleDefaults.has(p.id) || draft.knowledge.includes(p.id));
  const knowledgeTokens = (packs ?? []).filter((p) => draft.knowledge.includes(p.id)).reduce((n, p) => n + p.tokens, 0) + Math.round(draft.custom_knowledge.length / 3.6);
  const togglePack = (pid: string) => set("knowledge", draft.knowledge.includes(pid) ? draft.knowledge.filter((x) => x !== pid) : [...draft.knowledge, pid]);
  const toggleTool = (t: string) => set("tools", draft.tools.includes(t) ? draft.tools.filter((x) => x !== t) : [...draft.tools, t]);

  return (
    <div className="page">
      <Link to="/agents" className="row small muted" style={{ marginBottom: 14 }}><ArrowLeft size={14} /> All agents</Link>
      <div className="page-head" style={{ alignItems: "center" }}>
        <div className="row" style={{ gap: 14 }}>
          <AgentAvatar agent={draft} size={52} active={agent.stats.active > 0} />
          <div>
            <h1 className="page-title">{draft.name || "Unnamed agent"}</h1>
            <div className="page-sub" style={{ marginTop: 0 }}>{draft.title}{role && role.title !== draft.title ? ` · ${role.title}` : ""}</div>
          </div>
        </div>
        <div className="row">
          {agent.is_builtin && <button className="btn ghost" onClick={() => reset.mutate()} title="Restore the role's default prompt, knowledge and tools"><RotateCcw size={14} /> Reset to role defaults</button>}
          <button className="btn ghost" onClick={() => openChat(agent.id)}><MessageSquare size={14} /> Chat</button>
          {!agent.is_builtin && <button className="btn ghost danger" onClick={() => confirm(`Delete ${agent.name}? Its history stays in cost reports.`) && del.mutate()}><Trash2 size={14} /> Delete</button>}
          <button className="btn primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Save size={14} /> {dirty ? "Save changes" : "Saved"}</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px", alignItems: "start" }}>
        <div className="col" style={{ gap: 14 }}>
          {/* Profile */}
          <div className="card">
            <div className="card-head"><div className="card-title"><UserRound size={15} /> Profile</div></div>
            <div className="card-pad col" style={{ gap: 14 }}>
              <div className="grid g2">
                <Field label="Name" help="Short name shown on avatars, the graph and in messages. Inside the prompt, {{name}} is replaced with it."><input className="input" value={draft.name} onChange={(e) => set("name", e.target.value)} /></Field>
                <Field label="Title" help="The agent's job title, e.g. 'Salesforce Developer'. Shown under its name everywhere."><input className="input" value={draft.title} onChange={(e) => set("title", e.target.value)} /></Field>
              </div>
              <Field label="Description" help="What this agent is responsible for, in one or two sentences. Shown on its card; other agents don't see it."><textarea className="textarea" style={{ minHeight: 60 }} value={draft.description} onChange={(e) => set("description", e.target.value)} /></Field>
              <Field label="Why this name" help="The story behind the agent's name — where it comes from and why it fits the role. Shown on the agent's card on the Agents page. Start with the region and a full stop (e.g. 'Asturias. …') to show it as a tag. Agents don't see it."><textarea className="textarea" style={{ minHeight: 60 }} value={draft.name_story ?? ""} onChange={(e) => set("name_story", e.target.value)} placeholder="Region. The myth, and how it fits this agent's role." /></Field>
              <div className="grid g2">
                <Field label="Colour" help="Identity colour used for the avatar, graph node and charts. The palette is checked for colour-blind readability.">
                  <div className="row wrap">
                    {AGENT_COLORS.map((c) => (
                      <button key={c} onClick={() => set("color", c)} aria-label={c}
                        style={{ width: 24, height: 24, borderRadius: 7, background: c, border: draft.color === c ? "2px solid var(--text)" : "2px solid transparent", cursor: "pointer" }} />
                    ))}
                  </div>
                </Field>
                <Field label="Icon" help="Symbol shown inside the agent's avatar.">
                  <div className="row wrap" style={{ gap: 4 }}>
                    {AGENT_ICONS.map((i) => (
                      <button key={i} className={`btn sm icon ${draft.icon === i ? "" : "ghost"}`} onClick={() => set("icon", i)} title={i} style={draft.icon === i ? { borderColor: draft.color, color: draft.color } : undefined}>
                        <Icon name={i} size={14} />
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
              <Field help="Disabled agents stay in the team list but are skipped when projects run — their stage is treated as missing.">
                <div className="row"><Switch on={draft.enabled} onChange={(v) => set("enabled", v)} label="Enabled" /> <span className="small">Enabled — disabled agents are skipped by projects</span></div>
              </Field>
            </div>
          </div>

          {/* Model */}
          <div className="card">
            <div className="card-head"><div className="card-title"><Brain size={15} /> Model & behaviour</div></div>
            <div className="card-pad col" style={{ gap: 14 }}>
              <Field label="Model" help="Which Claude model this agent runs on. Prices are per million tokens; in simulation they're used to estimate what a live run would cost.">
              <div className="grid g2">
                {meta.models.map((m) => (
                  <div key={m.id} className={`selectable ${draft.model === m.id ? "on" : ""}`} onClick={() => set("model", m.id)}>
                    <div style={{ flex: 1 }}>
                      <div className="strong">{m.label}</div>
                      <div className="tiny muted mono">{m.id}</div>
                    </div>
                    <div className="right tiny muted num">${m.input} in<br />${m.output} out<br /><span className="faint">per 1M tokens</span></div>
                  </div>
                ))}
              </div>
              </Field>
              <div className="row wrap" style={{ gap: 20 }}>
                <Field label="Effort (thinking depth)" help="How hard the model thinks before answering. Higher = better reasoning but more output tokens and cost. Low suits documentation; high suits analysis and code.">
                  <Seg value={draft.effort} onChange={(v) => set("effort", v)} options={["low", "medium", "high", "xhigh", "max"].map((e) => ({ value: e as Draft["effort"], label: e }))} />
                </Field>
                <Field label="Max turns per run" help="Safety limit: the most model calls the agent may make in one run (one story, one stage) before it must stop." style={{ width: 160 }}>
                  <input className="input" type="number" min={1} max={100} value={draft.max_turns} onChange={(e) => set("max_turns", Number(e.target.value))} />
                </Field>
              </div>
              <div className="hint">Higher effort = deeper reasoning and more output tokens. Cheaper models suit documentation and planning; analysis and development benefit most from Opus.</div>
            </div>
          </div>

          {/* Deployment — release agent only */}
          {agent.role === "release" && (
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title"><Rocket size={15} /> Deployment</div>
                  <div className="card-sub">Where and how {draft.name} deploys by default. Each project can override the target org.</div>
                </div>
              </div>
              <div className="card-pad col" style={{ gap: 14 }}>
                <Field label="Default target org" help="The Salesforce org releases go to when a project doesn't choose its own. Production orgs (e.g. a Trailhead Playground) appear only once allowed in Settings → Salesforce orgs. In simulation, the deployment is simulated against it.">
                  <OrgPicker value={draft.config.targetOrg} onChange={(v) => set("config", { ...draft.config, targetOrg: v ?? undefined })} emptyLabel="None — static validation only" onAdd={() => setAddingOrg(true)} />
                </Field>
                <div className="grid g2">
                  <Field label="Deploy mode" help="Check-only: validates the release and runs tests without changing the org. Validate + deploy: if validation passes, the release is deployed to the target sandbox.">
                    <Seg value={draft.config.deployMode ?? "validate"} onChange={(v) => set("config", { ...draft.config, deployMode: v })} options={[{ value: "validate", label: "Check-only" }, { value: "deploy", label: "Validate + deploy" }]} />
                  </Field>
                  <Field label="Test level" help="Which Apex tests run during validation. RunLocalTests (all tests in the org except managed packages) is the safe default.">
                    <select className="select" value={draft.config.testLevel ?? "RunLocalTests"} onChange={(e) => set("config", { ...draft.config, testLevel: e.target.value as NonNullable<Draft["config"]["testLevel"]> })}>
                      <option value="RunLocalTests">RunLocalTests</option>
                      <option value="RunSpecifiedTests">RunSpecifiedTests</option>
                      <option value="RunAllTestsInOrg">RunAllTestsInOrg</option>
                      <option value="NoTestRun">NoTestRun</option>
                    </select>
                  </Field>
                </div>
              </div>
              {addingOrg && <AddOrgModal onClose={() => setAddingOrg(false)} onAdded={(alias) => set("config", { ...draft.config, targetOrg: alias })} />}
            </div>
          )}

          {agent.role === "developer" && (
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title"><Rocket size={15} /> Working in the org</div>
                  <div className="card-sub">How {draft.name} uses the project's Salesforce org in live mode (with deploy_story). Nothing is sent to Salesforce in simulation.</div>
                </div>
              </div>
              <div className="card-pad col" style={{ gap: 10 }}>
                <Field label="Story deployments" help="Check-only: each story is validated in the org with its tests (compile errors and test failures come back to the developer to fix) — nothing is saved in the org. Deploy: the story is really deployed to the org once it validates, so testers can try it there. Production orgs are always check-only.">
                  <Seg value={draft.config.deployMode ?? "validate"} onChange={(v) => set("config", { ...draft.config, deployMode: v })} options={[{ value: "validate", label: "Check-only (validate)" }, { value: "deploy", label: "Deploy to sandbox / scratch / dev org" }]} />
                </Field>
                <div className="small muted">Which tests run, the minimum coverage and the API version are team settings (Settings → Salesforce defaults) that each project can override.</div>
              </div>
            </div>
          )}

          {/* Knowledge */}
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title"><BookOpen size={15} /> Knowledge</div>
                <div className="card-sub">What {draft.name} knows. Role packs come predefined for the {role?.title}; custom knowledge is yours to write and always applies — with the highest priority.</div>
              </div>
              <span className="chip" style={{ background: "var(--panel-3)" }}>~{tokens(knowledgeTokens)} tokens</span>
            </div>
            <div className="card-pad col" style={{ gap: 16 }}>
              <div>
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="label">Role knowledge packs</span>
                  <span className="spacer" />
                  <button className="btn ghost sm" onClick={() => setShowAllPacks(!showAllPacks)}>{showAllPacks ? "Show assigned only" : `Browse all ${packs?.length ?? 0} packs`}</button>
                </div>
                <div className="grid g2">
                  {visiblePacks.map((p) => (
                    <Hint key={p.id} text={`${p.summary} Ticked packs are added to the agent's prompt (~${tokens(p.tokens)} tokens each, cached between calls).`} block>
                    <label className={`pack ${draft.knowledge.includes(p.id) ? "on" : ""}`}>
                      <input type="checkbox" checked={draft.knowledge.includes(p.id)} onChange={() => togglePack(p.id)} />
                      <div style={{ minWidth: 0 }}>
                        <div className="row" style={{ gap: 6 }}>
                          <span className="small strong">{p.title}</span>
                          {roleDefaults.has(p.id) && <span className="chip" style={{ background: "var(--panel-3)", height: 17, fontSize: 10 }}>role default</span>}
                          {p.custom && <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent)", height: 17, fontSize: 10 }}>shared custom</span>}
                        </div>
                        <div className="tiny muted">{p.summary}</div>
                        <div className="tiny faint">~{tokens(p.tokens)} tokens</div>
                      </div>
                    </label>
                    </Hint>
                  ))}
                </div>
              </div>

              <div>
                <div className="row" style={{ marginBottom: 8 }}>
                  <Sparkles size={14} color="var(--accent)" />
                  <span className="label" style={{ color: "var(--text)" }}>Custom knowledge — {draft.name}'s own skills</span>
                  <span className="spacer" />
                  <Hint text="Copies the full text of a knowledge pack into this agent's custom knowledge so you can adapt it without changing the shared pack.">
                  <select
                    className="select"
                    style={{ width: 200, height: 28, padding: "2px 8px", fontSize: 12 }}
                    value=""
                    onChange={(e) => {
                      const p = packs?.find((x) => x.id === e.target.value);
                      if (p) set("custom_knowledge", `${draft.custom_knowledge.trim()}\n\n<!-- adapted from ${p.title} -->\n${p.content}\n`.trim());
                    }}
                  >
                    <option value="">Copy a pack in to adapt…</option>
                    {packs?.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </select>
                  </Hint>
                  <Seg value={customMode} onChange={setCustomMode} options={[{ value: "write", label: <span className="row" style={{ gap: 4 }}><PenLine size={12} /> Write</span> }, { value: "preview", label: <span className="row" style={{ gap: 4 }}><Eye size={12} /> Preview</span> }]} />
                </div>
                {customMode === "write" ? (
                  <Field help={`${draft.name}'s own skills, written by you in Markdown. Always added to its prompt after the role packs, so it wins when they conflict. Use it for client conventions, naming rules, org specifics and lessons learned.`}>
                  <textarea
                    className="textarea code"
                    style={{ minHeight: 220 }}
                    value={draft.custom_knowledge}
                    placeholder={CUSTOM_TEMPLATE}
                    onChange={(e) => set("custom_knowledge", e.target.value)}
                  />
                  </Field>
                ) : (
                  <div className="card card-pad" style={{ background: "var(--bg-2)", minHeight: 220 }}>
                    <Markdown>{draft.custom_knowledge || "_Nothing written yet._"}</Markdown>
                  </div>
                )}
                <div className="row" style={{ marginTop: 6 }}>
                  <span className="hint">Markdown. Injected after the role packs, so it overrides them when they conflict. Good for client conventions, naming rules, org specifics, lessons learned.</span>
                  <span className="spacer" />
                  {!draft.custom_knowledge && <button className="btn ghost sm" onClick={() => set("custom_knowledge", CUSTOM_TEMPLATE)}>Insert template</button>}
                </div>
              </div>
            </div>
          </div>

          {/* Instructions */}
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title"><FileCode2 size={15} /> Instructions (system prompt)</div>
                <div className="card-sub"><code className="code-tag">{"{{name}}"}</code> is replaced with the agent's name.</div>
              </div>
              <button className="btn sm" onClick={() => setShowPrompt(true)}><Eye size={13} /> Full prompt · ~{tokens(agent.promptTokens)} tokens</button>
            </div>
            <div className="card-pad">
              <Field help="The agent's core instructions: mission, workflow and rules. Knowledge packs and custom knowledge are appended after it automatically. Changing it creates a new version you can roll back.">
                <textarea className="textarea code" style={{ minHeight: 320 }} value={draft.system_prompt} onChange={(e) => set("system_prompt", e.target.value)} />
              </Field>
            </div>
          </div>

          {/* Tools */}
          <div className="card">
            <div className="card-head"><div className="card-title"><Wrench size={15} /> Tools</div><span className="card-sub">{draft.tools.length} enabled</span></div>
            <div className="card-pad grid g2">
              {meta.tools.map((t) => (
                <Hint key={t.name} text={t.description} block>
                <label className={`pack ${draft.tools.includes(t.name) ? "on" : ""}`}>
                  <input type="checkbox" checked={draft.tools.includes(t.name)} onChange={() => toggleTool(t.name)} />
                  <div style={{ minWidth: 0 }}>
                    <div className="small strong">{t.label}</div>
                    <div className="tiny mono faint">{t.name}</div>
                  </div>
                </label>
                </Hint>
              ))}
            </div>
          </div>
        </div>

        {/* Side panel */}
        <div className="col" style={{ gap: 14, position: "sticky", top: 16 }}>
          <div className="card card-pad col" style={{ gap: 12 }}>
            <div className="card-title">Usage</div>
            <div className="grid g2">
              <div className="stat"><span className="v">{money(agent.stats.costUsd)}</span><span className="l">total cost</span></div>
              <div className="stat"><span className="v">{num(agent.stats.calls)}</span><span className="l">model calls</span></div>
              <div className="stat"><span className="v">{num(agent.stats.runs)}</span><span className="l">runs</span></div>
              <div className="stat"><span className="v">{duration(agent.stats.busyMs / 1000)}</span><span className="l">busy time</span></div>
              <div className="stat"><span className="v">{tokens(agent.stats.outputTokens)}</span><span className="l">output tokens</span></div>
              <div className="stat"><span className="v">{tokens(agent.stats.cacheReadTokens)}</span><span className="l">cache reads</span></div>
              <div className="stat"><span className="v">{num(agent.stats.messagesSent)}</span><span className="l">messages sent</span></div>
              <div className="stat"><span className="v">{num(agent.stats.projects)}</span><span className="l">projects</span></div>
            </div>
            {model && <div className="hint">Billed at {model.label} rates: ${model.input}/${model.output} per 1M in/out, cache reads ${model.cacheRead}.</div>}
          </div>
          <VersionHistory agentId={agent.id} current={agent.version} dirty={dirty} onRestored={() => setDraft(null)} />
          <div className="card">
            <div className="card-head"><div className="card-title">Recent runs</div></div>
            <div style={{ maxHeight: 420, overflow: "auto" }}>
              {agent.recentRuns.length ? agent.recentRuns.map((r) => (
                <Link key={r.id} to={`/p/${r.project_key}`} className="feed-row" style={{ gridTemplateColumns: "1fr auto" }}>
                  <div className="what small">
                    <span className="code-tag">{r.project_key}</span> {r.stage}{r.item_code ? <> · <span className="mono">{r.item_code}</span></> : null}{r.agent_version ? <span className="tiny faint"> · v{r.agent_version}</span> : null}{r.kind && r.kind !== "pipeline" ? <span className="tiny" style={{ color: "var(--accent)" }}> · {r.kind}</span> : null}
                    <div className="tiny" style={{ color: r.status === "failed" ? "var(--bad)" : r.status === "running" ? "var(--good)" : "var(--faint)" }}>{r.status} · {r.turns} turns</div>
                  </div>
                  <span className="when">{ago(r.started_at)}</span>
                </Link>
              )) : <div className="empty small">No runs yet.</div>}
            </div>
          </div>
        </div>
      </div>

      {showPrompt && (
        <Modal onClose={() => setShowPrompt(false)} title={`What ${agent.name} receives as system prompt`}>
          <div className="hint" style={{ marginBottom: 8 }}>Saved version — role prompt + knowledge packs + custom knowledge. Cached by the API between turns.</div>
          <pre className="code-view" style={{ maxHeight: "60vh", padding: 14, whiteSpace: "pre-wrap", borderRadius: 8 }}>{agent.systemPrompt}</pre>
        </Modal>
      )}
    </div>
  );
}

function lineDiff(a: string, b: string) {
  const A = a.split("\n");
  const B = b.split("\n");
  const setA = new Set(A);
  const setB = new Set(B);
  return [...A.filter((l) => !setB.has(l)).map((l) => ({ t: "-" as const, l })), ...B.filter((l) => !setA.has(l)).map((l) => ({ t: "+" as const, l }))];
}

function VersionHistory({ agentId, current, dirty, onRestored }: { agentId: string; current: number; dirty: boolean; onRestored: () => void }) {
  const qc = useQueryClient();
  const { data: versions } = useQuery({ queryKey: ["agent", agentId, "versions", current], queryFn: () => api.get<AgentVersion[]>(`/agents/${agentId}/versions`) });
  const [compare, setCompare] = useState<AgentVersion | null>(null);
  const restore = useMutation({
    mutationFn: (v: number) => api.post(`/agents/${agentId}/versions/${v}/restore`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["agent", agentId] }); qc.invalidateQueries({ queryKey: ["agents"] }); onRestored(); toast("Version restored as a new version"); },
  });
  const latest = versions?.[0];
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title"><History size={15} /> Versions</div>
        <span className="card-sub">current v{current}</span>
      </div>
      <div style={{ maxHeight: 360, overflow: "auto" }}>
        {versions?.map((v) => (
          <div key={v.version} className="feed-row" style={{ gridTemplateColumns: "auto 1fr auto" }}>
            <span className="code-tag" style={{ alignSelf: "start" }}>v{v.version}</span>
            <div className="what small">
              <div>{v.note ?? (v.changed.includes("created") ? "Created" : `Changed ${v.changed.map((c) => c.replace("_", " ")).join(", ")}`)}</div>
              <div className="tiny faint">{ago(v.created_at)} · {v.runs} run(s) · {money(v.costUsd)}{v.reworkRate != null ? ` · ${Math.round(v.reworkRate * 100)}% sent back by QA` : ""}</div>
            </div>
            <div className="row" style={{ gap: 2 }}>
              {latest && v.version !== latest.version && (
                <>
                  <Hint text="See what differs between this version and the current one."><button className="btn ghost sm icon" onClick={() => setCompare(v)} aria-label="Compare"><GitCompare size={13} /></button></Hint>
                  <Hint text={dirty ? "Save or discard your unsaved changes first." : "Bring back this version's prompt, knowledge, tools and model. It's saved as a new version, so nothing is lost."}>
                    <button className="btn ghost sm icon" disabled={dirty || restore.isPending} onClick={() => restore.mutate(v.version)} aria-label="Restore"><RotateCcw size={13} /></button>
                  </Hint>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {compare && latest && (
        <Modal onClose={() => setCompare(null)} title={`v${compare.version} → v${latest.version} (current)`}>
          <div className="col" style={{ gap: 12 }}>
            {(["model", "effort", "max_turns", "name", "title"] as const).filter((k) => compare.snapshot[k] !== latest.snapshot[k]).map((k) => (
              <div key={k} className="small"><b>{k.replace("_", " ")}:</b> <span style={{ color: "var(--bad)", textDecoration: "line-through" }}>{String(compare.snapshot[k])}</span> → <span style={{ color: "var(--good)" }}>{String(latest.snapshot[k])}</span></div>
            ))}
            {(["knowledge", "tools"] as const).map((k) => {
              const a = compare.snapshot[k] ?? [];
              const b = latest.snapshot[k] ?? [];
              const added = b.filter((x) => !a.includes(x));
              const removed = a.filter((x) => !b.includes(x));
              return added.length || removed.length ? (
                <div key={k} className="small"><b>{k}:</b> {added.map((x) => <span key={x} style={{ color: "var(--good)" }}> +{x}</span>)}{removed.map((x) => <span key={x} style={{ color: "var(--bad)" }}> −{x}</span>)}</div>
              ) : null;
            })}
            {(["system_prompt", "custom_knowledge"] as const).map((k) => {
              const d = lineDiff(compare.snapshot[k] ?? "", latest.snapshot[k] ?? "").filter((x) => x.l.trim());
              return d.length ? (
                <div key={k}>
                  <div className="label" style={{ marginBottom: 4 }}>{k === "system_prompt" ? "Instructions" : "Custom knowledge"}</div>
                  <pre className="code-view" style={{ padding: 10, maxHeight: 260, borderRadius: 8 }}>
                    {d.map((x, i) => <span key={i} className="ln" style={{ color: x.t === "+" ? "var(--good)" : "var(--bad)" }}>{x.t} {x.l}</span>)}
                  </pre>
                </div>
              ) : null;
            })}
            {compare.snapshot.description !== latest.snapshot.description && <div className="small"><b>description</b> changed.</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}
