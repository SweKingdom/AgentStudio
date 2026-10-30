import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, ChevronDown, MapPin, Plus, Sparkles, Trash2, Lock, Pencil } from "lucide-react";
import { api, type Agent, type Knowledge } from "../lib/api";
import { useAgents, useMeta } from "../lib/queries";
import { duration, money, num } from "../lib/format";
import { AgentAvatar, Empty, Markdown, Modal, Seg } from "../components/ui";
import { toast } from "../lib/toast";
import { Field, Hint } from "../components/Hint";

/** "Why this name": where the myth comes from and how it fits the role. The first sentence is the region. */
function NameStory({ name, story }: { name: string; story: string }) {
  const [open, setOpen] = useState(false);
  const dot = story.indexOf(". ");
  const region = dot > 0 && dot < 40 ? story.slice(0, dot) : null;
  const text = region ? story.slice(dot + 2) : story;
  return (
    <div className={`name-story ${open ? "open" : ""}`} onClick={(e) => { e.stopPropagation(); setOpen(!open); }} title={open ? "Show less" : "Why this name?"}>
      <div className="row" style={{ gap: 6 }}>
        <Sparkles size={12} />
        <span className="strong tiny">Why “{name}”?</span>
        {region && <span className="chip" style={{ fontSize: 10.5, padding: "0 7px" }}><MapPin size={10} /> {region}</span>}
        <span className="spacer" />
        <ChevronDown size={13} className="name-story-chev" />
      </div>
      <div className="name-story-text small">{text}</div>
    </div>
  );
}

function AgentCard({ a }: { a: Agent }) {
  const nav = useNavigate();
  const { data: meta } = useMeta();
  const model = meta?.models.find((m) => m.id === a.model);
  return (
    <div className="card agent-card fadein" style={{ ["--agent" as string]: a.color }} onClick={() => nav(`/agents/${a.id}`)}>
      <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
        <AgentAvatar agent={a} size={44} active={a.stats.active > 0} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row">
            <span className="strong" style={{ fontSize: 15 }}>{a.name}</span>
            {a.stats.active > 0 && <span className="pill" style={{ color: "var(--good)", background: "rgba(62,207,142,.1)" }}><span className="live-dot" style={{ width: 6, height: 6 }} /> working</span>}
            {!a.enabled && <span className="pill" style={{ color: "var(--muted)", border: "1px solid var(--line-2)" }}>disabled</span>}
          </div>
          <div className="small muted">{a.title}</div>
        </div>
      </div>
      <div className="small" style={{ color: "var(--text-2)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 40 }}>{a.description}</div>
      {a.name_story?.trim() && <NameStory name={a.name} story={a.name_story} />}
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="chip" style={{ background: "var(--panel-3)" }}>{model?.label ?? a.model}</span>
        <span className="chip" style={{ background: "var(--panel-3)" }}>effort · {a.effort}</span>
        <span className="chip" style={{ background: "var(--panel-3)" }}><BookOpen size={11} /> {a.knowledge.length}{a.custom_knowledge.trim() ? " + custom" : ""}</span>
        <span className="chip" style={{ background: "var(--panel-3)" }}>{a.tools.length} tools</span>
      </div>
      <hr className="sep" style={{ margin: 0 }} />
      <div className="stat-row">
        <div className="stat"><span className="v">{money(a.stats.costUsd)}</span><span className="l">cost</span></div>
        <div className="stat"><span className="v">{num(a.stats.calls)}</span><span className="l">calls</span></div>
        <div className="stat"><span className="v">{num(a.stats.runs)}</span><span className="l">runs</span></div>
        <div className="stat"><span className="v">{duration(a.stats.busyMs / 1000)}</span><span className="l">busy</span></div>
      </div>
    </div>
  );
}


function KnowledgeEditor({ pack, onClose }: { pack?: Knowledge; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(pack?.title ?? "");
  const [summary, setSummary] = useState(pack?.summary ?? "");
  const [content, setContent] = useState(pack?.content ?? "");
  const save = useMutation({
    mutationFn: () => api.post("/knowledge", { id: pack?.id, title, summary, content }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["knowledge"] });
      toast("Knowledge pack saved");
      onClose();
    },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <Modal
      onClose={onClose}
      title={pack ? `Edit ${pack.title}` : "New shared knowledge pack"}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!title || save.isPending} onClick={() => save.mutate()}>Save pack</button></>}
    >
      <div className="col" style={{ gap: 12 }}>
        <Field label="Title" help="Name of the shared knowledge pack, shown when you assign packs to agents."><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. CPQ pricing rules" /></Field>
        <Field label="Summary" help="One line describing what the pack teaches. Shown next to the checkbox on each agent's Knowledge section."><input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="One line — shown when assigning packs" /></Field>
        <Field label="Content (Markdown)" help="The knowledge itself, in Markdown. It's added to the prompt of every agent that has this pack ticked."><textarea className="textarea code" style={{ minHeight: 300 }} value={content} onChange={(e) => setContent(e.target.value)} /></Field>
        <div className="hint">Shared packs can be assigned to any agent. For knowledge that belongs to one agent only, use that agent's <b>Custom knowledge</b> section.</div>
      </div>
    </Modal>
  );
}

function KnowledgeLibrary() {
  const qc = useQueryClient();
  const { data: packs } = useQuery({ queryKey: ["knowledge"], queryFn: () => api.get<Knowledge[]>("/knowledge") });
  const { data: agents } = useAgents();
  const [open, setOpen] = useState<Knowledge | null>(null);
  const [edit, setEdit] = useState<Knowledge | "new" | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/knowledge/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge"] }),
  });
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="muted small">Built-in packs distil the DevOps story template, the Rudolf peer-testing method and engineering and testing standards. Add your own shared packs for anything else.</div>
        <span className="spacer" />
        <button className="btn" onClick={() => setEdit("new")}><Plus size={14} /> New pack</button>
      </div>
      <div className="grid g3">
        {packs?.map((k) => {
          const users = agents?.filter((a) => a.knowledge.includes(k.id)) ?? [];
          return (
            <div key={k.id} className="card card-pad col" style={{ gap: 8, cursor: "pointer" }} onClick={() => setOpen(k)}>
              <div className="row">
                <BookOpen size={15} color="var(--accent)" />
                <span className="strong ellipsis">{k.title}</span>
                <span className="spacer" />
                {k.custom ? <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>custom</span> : <Lock size={12} color="var(--faint)" />}
              </div>
              <div className="small muted" style={{ minHeight: 38 }}>{k.summary}</div>
              <div className="row">
                <div className="row" style={{ gap: 0 }}>{users.map((a, i) => <span key={a.id} style={{ marginLeft: i ? -6 : 0 }}><AgentAvatar agent={a} size={20} /></span>)}</div>
                <span className="spacer" />
                <span className="tiny faint">~{num(k.tokens)} tokens</span>
              </div>
            </div>
          );
        })}
      </div>
      {open && (
        <Modal
          onClose={() => setOpen(null)}
          title={open.title}
          footer={open.custom ? (
            <>
              <button className="btn danger" onClick={() => { del.mutate(open.id); setOpen(null); }}><Trash2 size={14} /> Delete</button>
              <button className="btn" onClick={() => { setEdit(open); setOpen(null); }}><Pencil size={14} /> Edit</button>
            </>
          ) : <span className="small muted">Built-in pack · read-only (copy it into an agent's custom knowledge to adapt it)</span>}
        >
          <Markdown>{open.content}</Markdown>
        </Modal>
      )}
      {edit && <KnowledgeEditor pack={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

export default function Agents() {
  const { data: agents } = useAgents();
  const [tab, setTab] = useState<"team" | "knowledge">("team");
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Agents</h1>
          <div className="page-sub">The seven agents of your delivery team, named after Iberian mythology — open a card to read why. Each one has a role, a model, a prompt, tools and knowledge you can tailor.</div>
        </div>
        <div className="row">
          <Seg value={tab} onChange={setTab} options={[{ value: "team", label: "Team" }, { value: "knowledge", label: "Knowledge library" }]} />

        </div>
      </div>
      {tab === "team" ? (
        agents?.length ? (
          <div className="grid g3 stagger">{agents.map((a) => <AgentCard key={a.id} a={a} />)}</div>
        ) : (
          <Empty title="No agents">Create one from a role template.</Empty>
        )
      ) : (
        <KnowledgeLibrary />
      )}

    </div>
  );
}
