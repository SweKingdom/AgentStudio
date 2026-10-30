import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCode2, FileText, Pencil, RotateCcw, Save, X, ChevronRight, Bug, Scissors, Wrench, MessageSquare, Send, Loader2, Printer, Download, Play, PauseCircle, Ban, Undo2, GitBranch, GitPullRequest } from "lucide-react";
import { BugModal, RerunModal, SplitModal, StartWorkModal, openChat } from "../../components/Modals";
import { Field, Hint } from "../../components/Hint";
import { api, storyAssetBase, type Doc, type ItemDetail, type Project } from "../../lib/api";
import { useAgentLookup, useMeta } from "../../lib/queries";
import { dateTime, duration, hours, money, secondsBetween } from "../../lib/format";
import { PHASES, TYPE } from "../../lib/constants";
import { AgentAvatar, AgentTag, CategoryChip, Drawer, Markdown, Seg, StatePill, TypeIcon, Empty } from "../../components/ui";
import { MessageList, ActivityFeed } from "../../components/Feeds";
import { MiniBar } from "../../components/Charts";
import { toast } from "../../lib/toast";
import { PageSkeleton } from "../../components/Skeleton";
import { AdoChip } from "../../components/AdoSettings";
import { ChangeCount, FileCode, FileDiff } from "../../components/CodeBlock";

type Tab = "story" | "tests" | "timeline" | "conversation" | "files" | "cost";

const SECTIONS: { key: keyof ItemDetail; label: string; ado: string; help: string }[] = [
  { key: "user_story", label: "User Story", ado: "System.Description", help: "One sentence: As a {persona}, I want {goal}, so that {benefit}." },
  { key: "background", label: "Background & Context", ado: "System.Description", help: "2–3 sentences of business context in plain language — no API names. For bugs: the steps to reproduce." },
  { key: "business_rules", label: "Business Rules", ado: "System.Description", help: "Bullet list of rules with explicit conditions (who, when, which values)." },
  { key: "dependencies", label: "Dependencies", ado: "System.Description", help: "What must exist before this can be built or deployed: other stories, data, licences, integrations." },
  { key: "out_of_scope", label: "Out of Scope", ado: "System.Description", help: "What this item deliberately does not cover. Bullets, no explanations needed." },
  { key: "acceptance_criteria", label: "Acceptance Criteria", ado: "Microsoft.VSTS.Common.AcceptanceCriteria", help: "One '### AC n: Title' heading per criterion followed by the direct, testable outcome. QA tests exactly these." },
  { key: "tech_spec", label: "Technical Specification", ado: "Custom.TechnicalSpecification", help: "Everything the developer needs: objects, fields (API name, type), automation, classes, permission sets. Tables over prose." },
  { key: "how_to_test", label: "How to Test", ado: "Custom.AcceptanceTests", help: "Unit-test command plus one manual check per AC with a **Verify:** line." },
  { key: "manual_steps", label: "Manual Steps", ado: "Custom.DeploymentNotes", help: "Pre- and post-deployment steps that can't be automated, e.g. assigning a permission set." },
  { key: "solution_components", label: "Solution Components", ado: "solutions-components.md", help: "Components created or changed, by metadata type (API names)." },
];

const RESULT = { pass: ["✅", "var(--good)", "Works"], fail: ["❌", "var(--bad)", "Broken"], blocked: ["⛔", "var(--warn)", "Couldn't test"] } as const;

export default function ItemDrawer({ id, project, onClose }: { id: string; project: Project; onClose: () => void }) {
  const qc = useQueryClient();
  const agent = useAgentLookup();
  const { data: meta } = useMeta();
  const { data: it } = useQuery({ queryKey: ["item", id], queryFn: () => api.get<ItemDetail>(`/items/${id}`) });
  const [tab, setTab] = useState<Tab>("story");
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [modal, setModal] = useState<"rerun" | "bug" | "split" | "start" | null>(null);
  const lifecycle = useMutation({
    mutationFn: (state: string) => api.patch(`/items/${id}`, { state }),
    onSuccess: (_d, state) => { qc.invalidateQueries(); toast(state === "Cancelled" ? "Item cancelled" : state === "Blocked" ? "Item put on hold" : "Item reopened"); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const [comment, setComment] = useState("");
  const addComment = useMutation({
    mutationFn: () => api.post(`/items/${id}/comments`, { content: comment }),
    onSuccess: () => { setComment(""); qc.invalidateQueries({ queryKey: ["item", id] }); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const fix = useMutation({
    mutationFn: () => api.post(`/items/${id}/fix`, { release: true }),
    onSuccess: () => { toast("Fix started — the release manager publishes a patch when it passes"); qc.invalidateQueries(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const taskDocId = it?.documents.find((d) => d.kind === "task_doc")?.id;
  const reportId = it?.documents.find((d) => d.kind === "test_report")?.id;
  const { data: report } = useQuery({ queryKey: ["doc", reportId], queryFn: () => api.get<Doc>(`/documents/${reportId}`), enabled: !!reportId && tab === "tests" });
  const { data: taskDoc } = useQuery({ queryKey: ["doc", taskDocId], queryFn: () => api.get<Doc>(`/documents/${taskDocId}`), enabled: !!taskDocId && tab === "files" });
  const fileRow = (it?.files as { path: string; first_version?: number; last_version?: number }[] | undefined)?.find((f) => f.path === file);
  const versionUrl = (v: number) => `/projects/${project.id}/file-version?path=${encodeURIComponent(file!)}&version=${v}`;
  const { data: fileContent } = useQuery({
    queryKey: ["file", project.id, file, fileRow?.last_version ?? "disk"],
    queryFn: () => api.get<{ content: string }>(fileRow?.last_version ? versionUrl(fileRow.last_version) : `/projects/${project.id}/file?path=${encodeURIComponent(file!)}`),
    enabled: !!file,
  });
  const { data: fileBefore } = useQuery({
    queryKey: ["file", project.id, file, `before-${fileRow?.first_version}`],
    queryFn: () => (fileRow!.first_version! > 1 ? api.get<{ content: string }>(versionUrl(fileRow!.first_version! - 1)) : Promise.resolve({ content: "" })),
    enabled: !!file && !!fileRow?.first_version,
  });
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/items/${id}`, patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["item", id] }); qc.invalidateQueries({ queryKey: ["items"] }); setEdit(null); toast("Saved"); },
    onError: (e: Error) => toast(e.message, "bad"),
  });

  if (!it) return <Drawer onClose={onClose}><div className="drawer-body"><PageSkeleton inline /></div></Drawer>;
  const isDeliverable = it.type === "story" || it.type === "task" || it.type === "bug";
  const firstStart = it.phases[0]?.started_at;
  const lastEnd = [...it.phases].reverse().find((p) => p.ended_at)?.ended_at ?? null;
  const span = firstStart ? secondsBetween(firstStart, lastEnd ?? new Date().toISOString()) : 0;
  const sum = (ph: string) => it.phases.filter((p) => p.phase === ph).reduce((n, p) => n + secondsBetween(p.started_at, p.ended_at), 0);
  const iterations = [...new Set(it.tests.map((t) => t.iteration))];
  const maxAgentCost = Math.max(0, ...it.costByAgent.map((c) => c.costUsd));

  return (
    <Drawer onClose={onClose}>
      {modal === "rerun" && <RerunModal item={it as never} onClose={() => setModal(null)} />}
      {modal === "bug" && <BugModal item={it as never} onClose={() => setModal(null)} />}
      {modal === "split" && <SplitModal item={it as never} onClose={() => setModal(null)} />}
      {modal === "start" && <StartWorkModal item={it} onClose={() => setModal(null)} />}
      <div className="drawer-head">
        <div className="row" style={{ gap: 8 }}>
          {it.parent && (
            <Link to={`?item=${it.parent.id}`} className="row small muted" style={{ gap: 4 }}>
              <TypeIcon type={it.parent.type} size={12} /> <span className="mono">{it.parent.code}</span> {it.parent.title} <ChevronRight size={12} />
            </Link>
          )}
          <span className="spacer" />
          <button className="btn ghost sm icon" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
          <TypeIcon type={it.type} size={18} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="mono strong" style={{ color: TYPE[it.type]?.color }}>{it.code}</span>
              <span className="small muted">{TYPE[it.type]?.label}</span>
            </div>
            {edit ? (
              <Hint text="Short, outcome-oriented title shown on the board and in every export." block>
                <input className="input" style={{ fontSize: 17, fontWeight: 600, marginTop: 4 }} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
              </Hint>
            ) : (
              <h2 style={{ margin: "2px 0 0", fontSize: 19, letterSpacing: "-0.01em" }}>{it.title}</h2>
            )}
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {edit ? (
            <Hint text="The state is moved by the agents as each pipeline step finishes, so it can't be edited here. Use Start work, Put on hold, Cancel or Reopen.">
              <span><StatePill state={it.state} /></span>
            </Hint>
          ) : <StatePill state={it.state} />}
          {edit ? (
            <Hint text="What kind of work this is — drives the card colour and which files the developer produces.">
              <select className="select" style={{ width: 160, height: 28, padding: "2px 8px" }} value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>
                {meta?.categories.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
              </select>
            </Hint>
          ) : <CategoryChip value={it.category} />}
          {it.story_points != null && <span className="chip" style={{ background: "var(--panel-3)" }}>{it.story_points} pts</span>}
          {it.moscow && <span className="chip" style={{ background: "var(--panel-3)" }}>{it.moscow}</span>}
          {it.priority != null && <span className="chip" style={{ background: "var(--panel-3)" }}>P{it.priority}</span>}
          {it.sprint != null && <span className="chip" style={{ background: "var(--panel-3)" }}>Sprint {it.sprint}</span>}
          {it.rank != null && <span className="chip" style={{ background: "var(--panel-3)" }}>Rank #{it.rank}</span>}
          {it.rework_count > 0 && <span className="chip" style={{ background: "rgba(242,85,90,.12)", color: "var(--bad)" }}><RotateCcw size={11} /> {it.rework_count} rework</span>}
          {it.branch && <span className="chip mono" title="This task's own git branch: every agent run on it is a commit there; it's merged into the default branch when the task is done." style={{ background: "var(--panel-3)" }}><GitBranch size={11} /> {it.branch}</span>}
          {it.pr_url && <a className="chip mono" href={it.pr_url} target="_blank" rel="noopener noreferrer" title="This story's pull request on GitHub: QA's verdict is posted there and it's merged when the story is documented." style={{ background: "var(--panel-3)", color: "var(--brand-blue)", textDecoration: "none" }}><GitPullRequest size={11} /> PR #{it.pr_url.match(/\/pull\/(\d+)/)?.[1] ?? "?"}</a>}
          <AdoChip project={project} adoId={it.ado_id} />
          {it.depends_on.length > 0 && <span className="chip" style={{ background: "var(--panel-3)" }}>depends on {it.depends_on.join(", ")}</span>}
          {it.tags.map((t) => <span key={t} className="chip" style={{ border: "1px solid var(--line-2)" }}>{t}</span>)}
          <span className="spacer" />
          <span className="small muted">{money(it.cost.costUsd)}</span>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {it.busy && <span className="pill" style={{ color: "var(--info)", border: "1px solid var(--line-2)" }}><Loader2 size={12} className="spin" /> An agent is working on this item</span>}
          {isDeliverable && ["New", "Requires additional information", "Ready for Refinement", "Ready for Sprint", "To Do", "Blocked"].includes(it.state) && (
            <Hint text="Run every missing step for this item in pipeline order: refinement and planning if needed, then build → peer test → documentation. The right agents are called one after the other.">
              <button className="btn sm primary" disabled={it.busy} onClick={() => setModal("start")}><Play size={13} /> Start work</button>
            </Hint>
          )}
          <Hint text="Ask one agent to redo its part with your feedback. Developer re-runs go through peer test and documentation again.">
            <button className="btn sm" disabled={it.busy} onClick={() => setModal("rerun")}><RotateCcw size={13} /> Re-run with feedback</button>
          </Hint>
          {isDeliverable && it.type !== "bug" && (
            <Hint text="Report a defect found after delivery. It becomes a Bug linked to this story and can be fixed and released as a patch.">
              <button className="btn sm" onClick={() => setModal("bug")}><Bug size={13} /> Report bug</button>
            </Hint>
          )}
          {it.type === "bug" && !["Deployed (Done)", "Release Ready"].includes(it.state) && (
            <Hint text="Developer fixes it, QA verifies it, the writer updates the changelog, and the release manager publishes a patch release.">
              <button className="btn sm primary" disabled={it.busy || fix.isPending} onClick={() => fix.mutate()}><Wrench size={13} /> Fix & release patch</button>
            </Hint>
          )}
          {isDeliverable && (it.acceptance_criteria.match(/### AC/g) ?? []).length >= 2 && !it.busy && (
            <Hint text="Move some acceptance criteria into a new story with the same parent — for stories that grew too big.">
              <button className="btn sm" onClick={() => setModal("split")}><Scissors size={13} /> Split</button>
            </Hint>
          )}
          {!it.busy && !["Cancelled", "Blocked", "Release Ready", "Smoke Testing", "Deployed (Done)"].includes(it.state) && (
            <Hint text="Pause this item: agents won't pick it up until you start it again.">
              <button className="btn sm ghost" onClick={() => lifecycle.mutate("Blocked")}><PauseCircle size={13} /> Put on hold</button>
            </Hint>
          )}
          {!it.busy && it.state !== "Cancelled" && it.state !== "Deployed (Done)" && (
            <Hint text="Withdraw this item from the backlog. You can reopen it later.">
              <button className="btn sm ghost danger" onClick={() => lifecycle.mutate("Cancelled")}><Ban size={13} /> Cancel</button>
            </Hint>
          )}
          {(it.state === "Cancelled" || it.state === "Blocked") && !it.busy && (
            <Hint text="Bring the item back to New so it can be refined, planned and built again in order.">
              <button className="btn sm ghost" onClick={() => lifecycle.mutate("New")}><Undo2 size={13} /> Reopen</button>
            </Hint>
          )}
          {it.assigned_agent_id && (
            <Hint text="Ask the agent that built this item questions about it.">
              <button className="btn sm ghost" onClick={() => openChat(it.assigned_agent_id!, project.id)}><MessageSquare size={13} /> Chat with {agent(it.assigned_agent_id).name}</button>
            </Hint>
          )}
        </div>
        {it.questions.some((q) => !q.answer) && (
          <div className="banner warn small">
            <span>❓</span>
            <div style={{ flex: 1 }}>
              <b>On hold — {it.questions.filter((q) => !q.answer).length} open question(s).</b> This item won't be refined, planned or built until they're answered.
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{it.questions.filter((q) => !q.answer).map((q) => <li key={q.id}>{q.question}</li>)}</ul>
            </div>
            <Link to={`/p/${project.key}/questions`} className="btn sm">Answer</Link>
          </div>
        )}
        {it.bugs.length > 0 && (
          <div className="row wrap small" style={{ gap: 6 }}>
            <span className="muted">Bugs:</span>
            {it.bugs.map((b) => <Link key={b.id} to={`?item=${b.id}`} className="chip" style={{ background: "rgba(224,72,90,.12)", color: "#e0485a" }}><Bug size={11} /> {b.code} · {b.state}</Link>)}
          </div>
        )}
        <div className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--line)", paddingBottom: 10 }}>
          <Seg value={tab} onChange={setTab} options={[
            { value: "story", label: "Story" },
            ...(isDeliverable ? [{ value: "tests" as Tab, label: `Tests${it.tests.length ? ` (${it.tests.length})` : ""}` }, { value: "timeline" as Tab, label: "Timing" }] : []),
            { value: "conversation", label: `Conversation${it.messages.length ? ` (${it.messages.length})` : ""}` },
            ...(isDeliverable ? [{ value: "files" as Tab, label: `Files & docs${it.files.length ? ` (${it.files.length})` : ""}` }, { value: "cost" as Tab, label: "Cost" }] : []),
          ]} />
          {tab === "story" && (edit ? (
            <div className="row">
              <button className="btn sm ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn sm primary" onClick={() => save.mutate(edit)}><Save size={13} /> Save</button>
            </div>
          ) : (
            <button className="btn sm" onClick={() => setEdit(Object.fromEntries([["title", it.title], ["category", it.category], ...SECTIONS.map((s) => [s.key, String(it[s.key] ?? "")])]))}><Pencil size={13} /> Edit</button>
          ))}
        </div>
      </div>

      <div className="drawer-body">
        {tab === "story" && (
          <>
            {it.children.length > 0 && (
              <div className="section">
                <div className="section-title">Children</div>
                <div className="col" style={{ gap: 4 }}>
                  {it.children.map((c) => (
                    <Link key={c.id} to={`?item=${c.id}`} className="row small" style={{ padding: "4px 0" }}>
                      <TypeIcon type={c.type} /> <span className="mono">{c.code}</span> <span className="ellipsis" style={{ flex: 1 }}>{c.title}</span> <CategoryChip value={c.category} small /> <StatePill state={c.state} />
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {SECTIONS.map((s) => {
              const value = String(it[s.key] ?? "");
              if (!edit && !value.trim()) return null;
              return (
                <div className="section" key={s.key}>
                  <div className="section-title">{s.label}<span className="tiny mono faint" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>{s.ado}</span></div>
                  {edit ? (
                    <Field help={s.help}>
                      <textarea className="textarea code" style={{ minHeight: s.key === "user_story" ? 60 : 120 }} value={edit[s.key]} onChange={(e) => setEdit({ ...edit, [s.key]: e.target.value })} />
                    </Field>
                  ) : (
                    <Markdown>{value}</Markdown>
                  )}
                </div>
              );
            })}
            {!edit && !it.children.length && SECTIONS.every((s) => !String(it[s.key] ?? "").trim()) && <Empty title="Nothing written yet" />}
          </>
        )}

        {tab === "tests" && report && (
          <div className="section">
            <div className="section-title">Test report · v{report.version}
              <a className="btn sm ghost" href={`/print/${project.key}?doc=${report.id}&auto=1`} target="_blank" rel="noreferrer" title="Print / save as PDF"><Printer size={12} /></a>
            </div>
            <div className="card card-pad"><Markdown assetBase={storyAssetBase(project.id, it.code)}>{report.content}</Markdown></div>
          </div>
        )}
        {tab === "tests" && (
          it.tests.length ? iterations.map((iter) => (
            <div className="section" key={iter}>
              <div className="section-title">{it.tests.find((t) => t.iteration === iter)?.kind === "smoke" ? "Smoke test" : `Peer test · iteration ${iter}`}</div>
              <table className="table">
                <tbody>
                  {it.tests.filter((t) => t.iteration === iter).map((t) => {
                    const [icon, color, label] = RESULT[t.result];
                    return (
                      <tr key={t.id}>
                        <td style={{ width: 28, fontSize: 15 }} title={label}>{icon}</td>
                        <td style={{ width: 220 }}><span className="strong small">{t.ac_ref}</span><div className="tiny" style={{ color }}>{label}{t.kind === "smoke" ? " · smoke" : ""}</div></td>
                        <td className="small" style={{ color: "var(--text-2)" }}>{t.notes}</td>
                        <td style={{ width: 30 }}><AgentAvatar agent={agent(t.agent_id)} size={20} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )) : <Empty title="Not tested yet">The QA agent records one ✅ / ❌ / ⛔ per acceptance criterion with evidence.</Empty>
        )}

        {tab === "timeline" && (
          it.phases.length ? (
            <>
              <div className="grid g4" style={{ marginBottom: 18 }}>
                <div className="card kpi"><div className="kpi-label">Development</div><div className="kpi-value" style={{ fontSize: 19 }}>{duration(sum("development"))}</div></div>
                <div className="card kpi"><div className="kpi-label">Testing</div><div className="kpi-value" style={{ fontSize: 19 }}>{duration(sum("qa"))}</div></div>
                <div className="card kpi"><div className="kpi-label">Lead time</div><div className="kpi-value" style={{ fontSize: 19 }}>{duration(span)}</div><div className="kpi-foot">first phase → last</div></div>
                <div className="card kpi"><div className="kpi-label">Human estimate</div><div className="kpi-value" style={{ fontSize: 19 }}>{hours(it.human_hours)}</div><div className="kpi-foot">{it.story_points ?? "?"} pts</div></div>
              </div>
              <div className="col" style={{ gap: 8 }}>
                {it.phases.map((ph, i) => {
                  const def = PHASES.find((p) => p.key === ph.phase);
                  const secs = secondsBetween(ph.started_at, ph.ended_at);
                  const left = span ? (secondsBetween(firstStart!, ph.started_at) / span) * 100 : 0;
                  const width = span ? Math.max(1, (secs / span) * 100) : 100;
                  return (
                    <div key={i} className="row" style={{ gap: 10 }}>
                      <div style={{ width: 150 }} className="row small">
                        <span className="dot" style={{ background: def?.color }} /> {def?.label ?? ph.phase}{ph.iteration > 1 && <span className="tiny faint">#{ph.iteration}</span>}
                      </div>
                      <div style={{ flex: 1, position: "relative", height: 16, background: "var(--panel-2)", borderRadius: 4 }}>
                        <div title={`${dateTime(ph.started_at)} → ${dateTime(ph.ended_at)}`} style={{ position: "absolute", left: `${left}%`, width: `${width}%`, top: 0, bottom: 0, background: def?.color, borderRadius: 4, opacity: ph.ended_at ? 0.9 : 0.5 }} />
                      </div>
                      <span className="num small" style={{ width: 70, textAlign: "right" }}>{duration(secs)}</span>
                      <span style={{ width: 22 }}>{ph.agent_id && <AgentAvatar agent={agent(ph.agent_id)} size={20} />}</span>
                      <span className="tiny" style={{ width: 90, color: ph.outcome === "changes_requested" ? "var(--bad)" : "var(--faint)" }}>{ph.ended_at ? ph.outcome?.replace("_", " ") : "in progress"}</span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : <Empty title="No time recorded yet" />
        )}

        {tab === "conversation" && (
          <>
            <div className="section">
              <div className="section-title">Comments</div>
              <div className="col" style={{ gap: 8 }}>
                {it.comments.map((c) => {
                  const a = agent(c.author_id);
                  return (
                    <div key={c.id} className="row" style={{ alignItems: "flex-start", gap: 10 }}>
                      <AgentAvatar agent={a} size={24} />
                      <div className="card" style={{ padding: "8px 12px", flex: 1, background: c.author_id === "human" ? "var(--accent-soft)" : "var(--panel)" }}>
                        <div className="tiny muted"><b style={{ color: "var(--text)" }}>{a.name}</b> · {dateTime(c.created_at)}</div>
                        <div className="small" style={{ whiteSpace: "pre-wrap", marginTop: 2 }}>{c.content}</div>
                      </div>
                    </div>
                  );
                })}
                {!it.comments.length && <div className="small muted">No comments yet. Agents read your comments the next time they work on this item.</div>}
                <Field help="Add a note for the agents. Every agent that works on this item afterwards reads your comments and takes them into account. Ctrl/⌘+Enter to post.">
                  <div className="row" style={{ alignItems: "flex-end" }}>
                    <textarea className="textarea" style={{ minHeight: 44 }} placeholder="Write a comment for the team…" value={comment} onChange={(e) => setComment(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && comment.trim()) addComment.mutate(); }} />
                    <button className="btn primary" disabled={!comment.trim() || addComment.isPending} onClick={() => addComment.mutate()}><Send size={14} /></button>
                  </div>
                </Field>
              </div>
            </div>
            <div className="section"><div className="section-title">Messages between agents</div><div className="card"><MessageList messages={it.messages} empty="No messages about this item yet." /></div></div>
            <div className="section"><div className="section-title">Activity</div><div className="card"><ActivityFeed items={it.activity} /></div></div>
          </>
        )}

        {tab === "files" && (
          <>
            {taskDoc && <div className="section"><div className="section-title"><FileText size={12} /> Task document · v{taskDoc.version}
              <a className="btn sm ghost" href={`/api/documents/${taskDoc.id}/download`} title="Download as Markdown"><Download size={12} /></a>
              <a className="btn sm ghost" href={`/print/${project.key}?doc=${taskDoc.id}&auto=1`} target="_blank" rel="noreferrer" title="Print / save as PDF"><Printer size={12} /></a></div><div className="card card-pad"><Markdown>{taskDoc.content}</Markdown></div></div>}
            <div className="section">
              <div className="section-title"><FileCode2 size={12} /> Files changed by this item</div>
              {it.files.length ? (
                <div className="col" style={{ gap: 2 }}>
                  {it.files.map((f) => (
                    <div key={f.path} className={`tree-item ${file === f.path ? "on" : ""}`} onClick={() => setFile(file === f.path ? null : f.path)}>
                      <FileCode2 size={13} /> <span className="mono ellipsis" style={{ flex: 1 }}>{f.path}</span>
                      <ChangeCount added={(f as { added?: number }).added} removed={(f as { removed?: number }).removed} />
                      <AgentTag agent={agent(f.agent_id)} />
                    </div>
                  ))}
                </div>
              ) : <div className="small muted">No files yet.</div>}
              {file && fileContent && (
                <div className="card" style={{ marginTop: 10, overflow: "hidden" }}>
                  {fileRow?.first_version && fileBefore ? (
                    <FileDiff before={fileBefore.content} after={fileContent.content} path={file} maxHeight="460px" />
                  ) : (
                    <FileCode content={fileContent.content} path={file} maxHeight="460px" />
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {tab === "cost" && (
          <>
            <div className="grid g3" style={{ marginBottom: 16 }}>
              <div className="card kpi"><div className="kpi-label">Direct cost</div><div className="kpi-value accent" style={{ fontSize: 20 }}>{money(it.cost.costUsd)}</div></div>
              <div className="card kpi"><div className="kpi-label">Model calls</div><div className="kpi-value" style={{ fontSize: 20 }}>{it.cost.calls}</div></div>
              <div className="card kpi"><div className="kpi-label">Per story point</div><div className="kpi-value" style={{ fontSize: 20 }}>{it.story_points ? money(it.cost.costUsd / it.story_points) : "—"}</div></div>
            </div>
            <div className="col" style={{ gap: 8 }}>
              {it.costByAgent.map((c) => {
                const a = agent(c.agent_id);
                return (
                  <div key={c.agent_id} className="row small" style={{ gap: 10 }}>
                    <AgentTag agent={a} />
                    <div style={{ flex: 1 }}><MiniBar value={c.costUsd} max={maxAgentCost} color={a.color} /></div>
                    <span className="muted">{c.calls} calls</span>
                    <span className="num strong" style={{ width: 70, textAlign: "right" }}>{money(c.costUsd)}</span>
                  </div>
                );
              })}
            </div>
            <div className="hint" style={{ marginTop: 12 }}>Direct cost covers development, testing and documentation of this item. Project-wide work (analysis, planning, release) is reported per agent on the Costs tab.</div>
          </>
        )}
      </div>
    </Drawer>
  );
}
