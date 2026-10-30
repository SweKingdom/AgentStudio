import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bug, MessageSquare, RotateCcw, Scissors, Send, Plus, X, Play, Lock } from "lucide-react";
import { api, type ChatMessage, type ItemDetail, type Message, type WorkItem } from "../lib/api";
import { useAgentLookup, useAgents, useMeta } from "../lib/queries";
import { ago, dateTime } from "../lib/format";
import { CATEGORY } from "../lib/constants";
import { toast } from "../lib/toast";
import { AgentAvatar, CategoryChip, Drawer, Markdown, Modal, StatePill, TypeIcon } from "./ui";
import { Field } from "./Hint";
import { useFresh } from "../lib/motion";

// ---------------------------------------------------------------- message detail

const KIND_HELP: Record<string, string> = {
  handoff: "Handoff — work moves from one agent to the next in the pipeline.",
  question: "Question — the sender needs an answer before (or while) continuing.",
  answer: "Answer — a reply to a question or consultation.",
  rework: "Rework — QA (or you) sent the work back with findings to fix.",
  review: "Review — a verdict on delivered work.",
  info: "Info — a status update, no action required.",
  approval: "Approval — you approved a gate in the pipeline.",
};

export function MessageModal({ message, all, projectKey, onClose }: { message: Message; all: Message[]; projectKey?: string; onClose: () => void }) {
  const agent = useAgentLookup();
  const from = agent(message.from_agent_id);
  const to = agent(message.to_agent_id);
  const { data: item } = useQuery({ queryKey: ["item", message.item_id], queryFn: () => api.get<ItemDetail>(`/items/${message.item_id}`), enabled: !!message.item_id });
  const thread = all
    .filter((m) => m.id !== message.id && ((message.item_id && m.item_id === message.item_id) || (!message.item_id && ((m.from_agent_id === message.from_agent_id && m.to_agent_id === message.to_agent_id) || (m.from_agent_id === message.to_agent_id && m.to_agent_id === message.from_agent_id)))))
    .sort((a, b) => a.id - b.id)
    .slice(-8);
  const key = projectKey ?? (message as Message & { project_key?: string }).project_key;
  const real = (id: string) => id !== "human" && id !== "orchestrator";
  return (
    <Modal onClose={onClose} title="Message between agents">
      <div className="col" style={{ gap: 16 }}>
        <div className="row" style={{ gap: 12, alignItems: "stretch" }}>
          {[from, to].map((a, i) => (
            <div key={i} className="card card-pad row" style={{ flex: 1, gap: 10, background: "var(--bg-2)" }}>
              <AgentAvatar agent={a} size={34} />
              <div style={{ minWidth: 0 }}>
                <div className="tiny faint">{i === 0 ? "From" : "To"}</div>
                <div className="strong">{a.name}</div>
                <div className="tiny muted ellipsis">{a.title}</div>
              </div>
              {i === 0 && <ArrowRight size={16} style={{ marginLeft: "auto", alignSelf: "center" }} color="var(--faint)" />}
            </div>
          ))}
        </div>
        <div className="row wrap small muted" style={{ gap: 10 }}>
          <span className="chip" style={{ background: "var(--panel-3)" }}>{message.kind}</span>
          <span>{KIND_HELP[message.kind] ?? ""}</span>
          <span className="spacer" />
          <span title={message.created_at}>{dateTime(message.created_at)} · {ago(message.created_at)}</span>
        </div>
        <div className="card card-pad" style={{ background: "var(--bg-2)" }}><Markdown>{message.content}</Markdown></div>
        {item && (
          <div className="card card-pad col" style={{ gap: 8 }}>
            <div className="label">About this work item</div>
            <div className="row" style={{ gap: 8 }}>
              <TypeIcon type={item.type} /> <span className="mono small">{item.code}</span> <span className="strong ellipsis" style={{ flex: 1 }}>{item.title}</span>
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              <StatePill state={item.state} /> <CategoryChip value={item.category} />
              {item.story_points != null && <span className="chip" style={{ background: "var(--panel-3)" }}>{item.story_points} pts</span>}
              {item.rework_count > 0 && <span className="chip" style={{ color: "var(--bad)", background: "rgba(240,106,72,.12)" }}>{item.rework_count} rework</span>}
            </div>
            {item.user_story && <div className="small muted">{item.user_story}</div>}
            {key && <Link to={`/p/${key}/board?item=${item.id}`} className="btn sm" style={{ alignSelf: "flex-start" }} onClick={onClose}>Open work item</Link>}
          </div>
        )}
        {thread.length > 0 && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>{message.item_id ? "Other messages about this item" : "Conversation between these two"}</div>
            <div className="card">
              {thread.map((m) => {
                const f = agent(m.from_agent_id);
                return (
                  <div key={m.id} className="msg" style={{ padding: "8px 12px" }}>
                    <AgentAvatar agent={f} size={22} />
                    <div style={{ minWidth: 0 }}>
                      <div className="msg-head"><span className="from">{f.name}</span><ArrowRight size={10} /> {agent(m.to_agent_id).name} <span className="chip" style={{ background: "var(--panel-3)", height: 17 }}>{m.kind}</span><span className="spacer" /><span className="tiny faint">{ago(m.created_at)}</span></div>
                      <div className="msg-body small" style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{m.content}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          {[from, to].filter((a) => real(a.id)).map((a) => (
            <button key={a.id} className="btn sm" onClick={() => { openChat(a.id, message.project_id ?? undefined); onClose(); }}>
              <MessageSquare size={13} /> Chat with {a.name}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- chat with an agent (global drawer)

let chatTarget: { agentId: string; projectId?: string } | null = null;
const chatSubs = new Set<() => void>();
export function openChat(agentId: string, projectId?: string) {
  chatTarget = { agentId, projectId };
  chatSubs.forEach((s) => s());
}
function closeChat() {
  chatTarget = null;
  chatSubs.forEach((s) => s());
}

export function ChatHost() {
  const target = useSyncExternalStore((cb) => { chatSubs.add(cb); return () => chatSubs.delete(cb); }, () => chatTarget);
  return target ? <ChatDrawer key={`${target.agentId}:${target.projectId ?? ""}`} agentId={target.agentId} projectId={target.projectId} onClose={closeChat} /> : null;
}

function ChatDrawer({ agentId, projectId, onClose }: { agentId: string; projectId?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const agent = useAgentLookup()(agentId);
  const [scope, setScope] = useState<string | undefined>(projectId);
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<{ id: string; key: string; name: string }[]>("/projects") });
  const { data: history } = useQuery({
    queryKey: ["chat", agentId, scope ?? "none"],
    queryFn: () => api.get<ChatMessage[]>(`/agents/${agentId}/chat${scope ? `?projectId=${scope}` : ""}`),
  });
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const fresh = useFresh((history ?? []).map((m) => m.id));
  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth" }), [history?.length]);
  const send = useMutation({
    mutationFn: (message: string) => api.post<ChatMessage[]>(`/agents/${agentId}/chat`, { message, projectId: scope }),
    onSuccess: (h) => {
      qc.setQueryData(["chat", agentId, scope ?? "none"], h);
      setText("");
    },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const submit = () => text.trim() && !send.isPending && send.mutate(text.trim());
  const suggestions = ["What are you working on?", "What do you know?", "What have you cost so far?"];
  return (
    <Drawer onClose={onClose}>
      <div className="drawer-head" style={{ paddingBottom: 12, borderBottom: "1px solid var(--line)" }}>
        <div className="row" style={{ gap: 10 }}>
          <AgentAvatar agent={agent} size={36} />
          <div style={{ flex: 1 }}>
            <div className="strong" style={{ fontSize: 16 }}>Chat with {agent.name}</div>
            <div className="small muted">{agent.title}</div>
          </div>
          <button className="btn ghost sm icon" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <Field label="Project context" help="Which project the agent should answer about. With a project, it can look up that project's work items, runs and costs; 'No project' asks about the agent in general.">
          <select className="select" value={scope ?? ""} onChange={(e) => setScope(e.target.value || undefined)}>
            <option value="">No project — general questions</option>
            {projects?.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="drawer-body col" style={{ gap: 10 }}>
        {!history?.length && <div className="empty small">Ask {agent.name} about its work, a work item code (e.g. US-104), its costs or its knowledge.</div>}
        {history?.map((m) => (
          <div key={m.id} className={`row ${fresh.has(m.id) ? "chat-new" : ""}`} style={{ alignItems: "flex-start", gap: 8, flexDirection: m.sender === "human" ? "row-reverse" : "row" }}>
            {m.sender === "agent" && <AgentAvatar agent={agent} size={26} />}
            <div className="card" style={{ padding: "8px 12px", maxWidth: "80%", background: m.sender === "human" ? "var(--accent-soft)" : "var(--panel)", borderColor: m.sender === "human" ? "color-mix(in srgb, var(--accent) 40%, transparent)" : undefined }}>
              {m.sender === "agent" ? <Markdown>{m.content}</Markdown> : <div className="small" style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>}
              <div className="tiny faint row" style={{ marginTop: 4, gap: 6 }}>{ago(m.created_at)}{fresh.has(m.id) && m.sender === "agent" && <span className="new-badge">new</span>}</div>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div style={{ borderTop: "1px solid var(--line)", padding: 14 }} className="col">
        <div className="row wrap" style={{ gap: 6 }}>
          {suggestions.map((s) => <button key={s} className="btn sm ghost" onClick={() => send.mutate(s)} disabled={send.isPending}>{s}</button>)}
        </div>
        <Field help={`Your message to ${agent.name}. Mention a work item code (US-104, BG-130…) to ask about it. Press Enter to send, Shift+Enter for a new line. To make the agent actually change something, use "Re-run with feedback" on the work item.`}>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <textarea
              className="textarea"
              style={{ minHeight: 44 }}
              value={text}
              placeholder={`Message ${agent.name}…`}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            />
            <button className="btn primary" onClick={submit} disabled={!text.trim() || send.isPending}><Send size={14} /></button>
          </div>
        </Field>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------- re-run with feedback

const RERUN_ROLES: { role: string; label: string; what: string }[] = [
  { role: "developer", label: "Developer", what: "Rebuilds the item with your feedback, then it goes through peer test and documentation again." },
  { role: "qa", label: "QA tester", what: "Peer-tests the item again. If it fails, it goes back to the developer automatically." },
  { role: "writer", label: "Technical writer", what: "Rewrites the task document and updates the user manual." },
  { role: "architect", label: "Solution architect", what: "Revises the technical specification only." },
  { role: "requirements", label: "Requirements analyst", what: "Revises the story text and acceptance criteria only." },
];

export function RerunModal({ item, onClose }: { item: WorkItem; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: agents } = useAgents();
  const deliverable = ["story", "task", "bug"].includes(item.type);
  const roles = RERUN_ROLES.filter((r) => deliverable || r.role === "architect" || r.role === "requirements");
  const [role, setRole] = useState(roles[0].role);
  const [feedback, setFeedback] = useState("");
  const run = useMutation({
    mutationFn: () => api.post<{ label: string }>(`/items/${item.id}/rerun`, { role, feedback }),
    onSuccess: (r) => { toast(`${r.label} — started`); qc.invalidateQueries(); onClose(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const agentFor = (r: string) => agents?.find((a) => a.role === r);
  return (
    <Modal
      onClose={onClose}
      title={`Re-run ${item.code} with feedback`}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!feedback.trim() || run.isPending} onClick={() => run.mutate()}><RotateCcw size={14} /> Start re-run</button></>}
    >
      <div className="col" style={{ gap: 14 }}>
        <Field label="Who should redo their part?" help="The agent that will rework this item. Developer re-runs go through test and documentation again; analyst and architect re-runs only change the story text or specification.">
          <div className="col" style={{ gap: 6 }}>
            {roles.map((r) => {
              const a = agentFor(r.role);
              return (
                <div key={r.role} className={`selectable ${role === r.role ? "on" : ""}`} onClick={() => setRole(r.role)} style={{ padding: 10, opacity: a ? 1 : 0.5 }}>
                  {a && <AgentAvatar agent={a} size={26} />}
                  <div style={{ flex: 1 }}>
                    <div className="small strong">{a?.name ?? r.label} <span className="muted" style={{ fontWeight: 400 }}>· {r.label}</span></div>
                    <div className="tiny muted">{r.what}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </Field>
        <Field label="Your feedback" help="Tell the agent exactly what to change and why. It's saved as a comment on the item, so every agent that touches it later sees it too.">
          <textarea className="textarea" value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="e.g. Also copy the preferred technician from the case." autoFocus />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- report a bug

export function BugModal({ item, onClose }: { item: WorkItem; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ title: "", steps: "1. \n2. \n3. ", expected: "", actual: "", severity: "3 - Medium", fixNow: true, release: true });
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const save = useMutation({
    mutationFn: () => api.post<WorkItem>(`/items/${item.id}/bugs`, f),
    onSuccess: (b) => { toast(`Bug ${b.code} reported${f.fixNow ? " — the developer is on it" : ""}`); qc.invalidateQueries(); onClose(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <Modal
      onClose={onClose}
      title={`Report a bug on ${item.code}`}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.title || !f.expected || !f.actual || save.isPending} onClick={() => save.mutate()}><Bug size={14} /> Report bug</button></>}
    >
      <div className="col" style={{ gap: 12 }}>
        <Field label="Title" help="One line that describes the defect, e.g. 'Stock check times out for large orders'.">
          <input className="input" value={f.title} onChange={(e) => set("title", e.target.value)} autoFocus />
        </Field>
        <Field label="Steps to reproduce" help="Numbered steps someone else can follow to see the bug. The developer turns these into a regression test.">
          <textarea className="textarea" value={f.steps} onChange={(e) => set("steps", e.target.value)} />
        </Field>
        <div className="grid g2">
          <Field label="Expected" help="What should have happened. This becomes acceptance criterion 1 of the bug.">
            <textarea className="textarea" style={{ minHeight: 70 }} value={f.expected} onChange={(e) => set("expected", e.target.value)} />
          </Field>
          <Field label="Actual" help="What happened instead — error messages, wrong values, slowness.">
            <textarea className="textarea" style={{ minHeight: 70 }} value={f.actual} onChange={(e) => set("actual", e.target.value)} />
          </Field>
        </div>
        <Field label="Severity" help="How bad it is. Critical and High get 2 points and top priority; Medium and Low get 1 point.">
          <select className="select" value={f.severity} onChange={(e) => set("severity", e.target.value)}>
            {["1 - Critical", "2 - High", "3 - Medium", "4 - Low"].map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field help="Start the fix straight away: developer → peer test → documentation.">
          <label className="row small"><input type="checkbox" checked={f.fixNow} onChange={(e) => set("fixNow", e.target.checked)} style={{ accentColor: "var(--accent)" }} /> Fix it now</label>
        </Field>
        <Field help="When the fix passes peer testing, the release manager publishes it as a patch release (e.g. 1.0.1) right away.">
          <label className="row small" style={{ opacity: f.fixNow ? 1 : 0.5 }}><input type="checkbox" disabled={!f.fixNow} checked={f.release} onChange={(e) => set("release", e.target.checked)} style={{ accentColor: "var(--accent)" }} /> Release the fix as a patch when it passes</label>
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- split a story

export function SplitModal({ item, onClose }: { item: WorkItem; onClose: () => void }) {
  const qc = useQueryClient();
  const blocks = item.acceptance_criteria.split(/(?=^### AC \d+:)/m).map((b) => b.trim()).filter((b) => /^### AC \d+:/.test(b));
  const [title, setTitle] = useState("");
  const [moved, setMoved] = useState<number[]>([]);
  const save = useMutation({
    mutationFn: () => api.post<WorkItem>(`/items/${item.id}/split`, { title, acIndexes: moved }),
    onSuccess: (n) => { toast(`Created ${n.code}`); qc.invalidateQueries(); onClose(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <Modal
      onClose={onClose}
      title={`Split ${item.code}`}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!title.trim() || !moved.length || moved.length >= blocks.length || save.isPending} onClick={() => save.mutate()}><Scissors size={14} /> Split story</button></>}
    >
      <div className="col" style={{ gap: 12 }}>
        <Field label="Title of the new story" help="The new story gets the same parent, category, user story and technical specification, and takes the acceptance criteria you tick below. Story points are split between both.">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="e.g. Offline parts list" />
        </Field>
        <Field label="Acceptance criteria to move" help="Tick the criteria that belong to the new story. At least one must stay on the original. Both stories are renumbered (AC 1, AC 2…).">
          <div className="col" style={{ gap: 6 }}>
            {blocks.map((b, i) => (
              <label key={i} className={`pack ${moved.includes(i) ? "on" : ""}`}>
                <input type="checkbox" checked={moved.includes(i)} onChange={() => setMoved(moved.includes(i) ? moved.filter((x) => x !== i) : [...moved, i])} />
                <div className="small"><Markdown>{b}</Markdown></div>
              </label>
            ))}
            {!blocks.length && <div className="small muted">This item has no numbered acceptance criteria to split.</div>}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- new work item

export function NewItemModal({ projectId, items, onClose }: { projectId: string; items: WorkItem[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: meta } = useMeta();
  const [f, setF] = useState({ type: "story", title: "", parent_id: "", category: "development", user_story: "", acceptance_criteria: "### AC 1: \n", story_points: "" });
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const parents = items.filter((i) => (f.type === "feature" ? i.type === "epic" : f.type === "epic" ? false : i.type === "feature" || (f.type === "bug" && i.type !== "epic")));
  const save = useMutation({
    mutationFn: () => api.post<WorkItem>(`/projects/${projectId}/items`, { ...f, parent_id: f.parent_id || null }),
    onSuccess: (n) => { toast(`Created ${n.code}`); qc.invalidateQueries({ queryKey: ["items"] }); onClose(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <Modal
      onClose={onClose}
      title="New work item"
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.title.trim() || save.isPending} onClick={() => save.mutate()}><Plus size={14} /> Create</button></>}
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="grid g2">
          <Field label="Type" help="Epic = business capability · Feature = recognisable slice of an epic · User Story = one testable increment · Task = technical work · Bug = defect.">
            <select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, parent_id: "" })}>
              <option value="epic">Epic</option><option value="feature">Feature</option><option value="story">User Story</option><option value="task">Task</option><option value="bug">Bug</option>
            </select>
          </Field>
          <Field label="Category" help="What kind of work it is. Drives the colour on the board and which files the developer produces.">
            <select className="select" value={f.category} onChange={(e) => set("category", e.target.value)}>
              {(meta?.categories ?? Object.keys(CATEGORY)).map((c) => <option key={c} value={c}>{CATEGORY[c]?.label ?? c}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Title" help="Short, outcome-oriented title, e.g. 'Create a work order from a case in one click'.">
          <input className="input" value={f.title} onChange={(e) => set("title", e.target.value)} autoFocus />
        </Field>
        {f.type !== "epic" && (
          <Field label="Parent" help="Where it sits in the hierarchy: features belong to an epic, stories and tasks to a feature.">
            <select className="select" value={f.parent_id} onChange={(e) => set("parent_id", e.target.value)}>
              <option value="">— No parent —</option>
              {parents.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.title}</option>)}
            </select>
          </Field>
        )}
        {(f.type === "story" || f.type === "task" || f.type === "bug") && (
          <>
            <Field label="User story" help="One sentence: As a {persona}, I want {goal}, so that {benefit}.">
              <textarea className="textarea" style={{ minHeight: 56 }} value={f.user_story} onChange={(e) => set("user_story", e.target.value)} placeholder="As a dispatcher, I want …, so that …" />
            </Field>
            <Field label="Acceptance criteria" help="One '### AC n: Title' heading per criterion, followed by the direct, testable outcome. No Given/When/Then.">
              <textarea className="textarea code" value={f.acceptance_criteria} onChange={(e) => set("acceptance_criteria", e.target.value)} />
            </Field>
            <Field label="Story points (optional)" help="Relative size on the Fibonacci scale (1, 2, 3, 5, 8, 13). Leave empty and the planner estimates it.">
              <select className="select" value={f.story_points} onChange={(e) => set("story_points", e.target.value)}>
                <option value="">Let the planner decide</option>
                {[1, 2, 3, 5, 8, 13].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- start work (pipeline order)

interface StartPlan { steps: { role: string; agent: string | null; what: string }[]; skipped: string[]; blockedBy: string[] }

export function StartWorkModal({ item, onClose }: { item: Pick<WorkItem, "id" | "code" | "title">; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: agents } = useAgents();
  const { data: plan } = useQuery({ queryKey: ["start-plan", item.id], queryFn: () => api.get<StartPlan>(`/items/${item.id}/start-plan`) });
  const start = useMutation({
    mutationFn: () => api.post(`/items/${item.id}/start`),
    onSuccess: () => { toast(`Work on ${item.code} started — agents are on it`); qc.invalidateQueries(); onClose(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const blocked = (plan?.blockedBy.length ?? 0) > 0;
  return (
    <Modal
      onClose={onClose}
      title={`Start work on ${item.code}`}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!plan || blocked || start.isPending} onClick={() => start.mutate()}><Play size={14} /> Start</button></>}
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="small"><b>{item.title}</b></div>
        <div className="small muted">Items move through the pipeline in order — no step is skipped. These agents will run, one after the other:</div>
        <ol className="col" style={{ gap: 6, margin: 0, padding: 0, listStyle: "none" }}>
          {plan?.steps.map((s, i) => {
            const a = agents?.find((x) => x.role === s.role);
            return (
              <li key={s.role} className="row card" style={{ padding: "8px 10px", gap: 10, animation: `rise .3s ${i * 60}ms both` }}>
                <span className="code-tag">{i + 1}</span>
                {a && <AgentAvatar agent={a} size={24} />}
                <span className="strong small">{s.agent}</span>
                <span className="small muted">{s.what}</span>
              </li>
            );
          })}
        </ol>
        {plan && plan.skipped.length > 0 && <div className="tiny faint">Skipped (no agent on the team): {plan.skipped.join(", ")}.</div>}
        {blocked && (
          <div className="banner warn small"><Lock size={14} /> <div>{plan!.blockedBy.join(" ")}</div></div>
        )}
      </div>
    </Modal>
  );
}
