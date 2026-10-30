import { useState } from "react";
import { Link } from "react-router-dom";
import { MessageModal } from "./Modals";
import { useFresh } from "../lib/motion";
import { ArrowRight, CheckCircle2, FileCode2, FileText, Flag, MessageSquare, PlayCircle, AlertTriangle, PlusCircle, Pencil, ListChecks, ShieldCheck, Rocket, HelpCircle } from "lucide-react";
import type { Activity, Message } from "../lib/api";
import { ago } from "../lib/format";
import { useAgentLookup } from "../lib/queries";
import { AgentAvatar } from "./ui";

const KIND_COLOR: Record<string, string> = {
  handoff: "#5aa9ff", question: "#f5b84a", answer: "#3ecf8e", rework: "#f2555a", review: "#a66cf5", info: "#8a92a6", approval: "#efab00",
};

export function MessageList({ messages, projectKey, empty }: { messages: Message[]; projectKey?: string; empty?: string }) {
  const agent = useAgentLookup();
  const [open, setOpen] = useState<Message | null>(null);
  const fresh = useFresh(messages.map((m) => m.id));
  if (!messages.length) return <div className="empty small">{empty ?? "No messages yet."}</div>;
  return (
    <div>
      {open && <MessageModal message={open} all={messages} projectKey={projectKey} onClose={() => setOpen(null)} />}
      {messages.map((m) => {
        const from = agent(m.from_agent_id);
        const to = agent(m.to_agent_id);
        const color = KIND_COLOR[m.kind] ?? "#8a92a6";
        return (
          <div
            key={m.id}
            className={`msg clickable-msg ${fresh.has(m.id) ? "is-new" : "fadein"}`}
            role="button"
            tabIndex={0}
            title="Open message details"
            onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) setOpen(m); }}
            onKeyDown={(e) => { if (e.key === "Enter") setOpen(m); }}
          >
            <AgentAvatar agent={from} size={26} />
            <div style={{ minWidth: 0 }}>
              <div className="msg-head">
                <span className="from">{from.name}</span>
                <ArrowRight size={11} />
                <span style={{ color: to.color, fontWeight: 600 }}>{to.name}</span>
                <span className="chip" style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color, height: 18 }}>{m.kind}</span>
                {fresh.has(m.id) && <span className="new-badge">new</span>}
                {m.item_code && (projectKey ? <Link to={`/p/${projectKey}/board?item=${m.item_id}`} className="code-tag">{m.item_code}</Link> : <span className="code-tag">{m.item_code}</span>)}
                <span className="spacer" />
                <span className="faint tiny" title={m.created_at}>{ago(m.created_at)}</span>
              </div>
              <div className="msg-body" style={{ display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{m.content}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const TYPE_ICON: Record<string, [typeof FileText, string]> = {
  run_started: [PlayCircle, "#5aa9ff"],
  run_done: [CheckCircle2, "#3ecf8e"],
  run_failed: [AlertTriangle, "#f2555a"],
  tool_error: [AlertTriangle, "#f5b84a"],
  item_created: [PlusCircle, "#a66cf5"],
  item_updated: [Pencil, "#8a92a6"],
  item_planned: [ListChecks, "#f59e0b"],
  document: [FileText, "#10b981"],
  file: [FileCode2, "#4f8ff7"],
  test: [ShieldCheck, "#ef4444"],
  validation: [Rocket, "#ec4899"],
  pipeline: [Flag, "#b2a792"],
  gate: [HelpCircle, "#efab00"],
  approval: [CheckCircle2, "#efab00"],
  note: [MessageSquare, "#8a92a6"],
  blocked: [AlertTriangle, "#f2555a"],
};

export function ActivityFeed({ items, showProject, compact }: { items: Activity[]; showProject?: boolean; compact?: boolean }) {
  const agent = useAgentLookup();
  const fresh = useFresh(items.map((a) => a.id));
  if (!items.length) return <div className="empty small">Nothing has happened yet.</div>;
  return (
    <div className="feed">
      {items.map((a) => {
        const ag = agent(a.agent_id);
        const [Ico, color] = TYPE_ICON[a.type] ?? [MessageSquare, "#8a92a6"];
        return (
          <div key={a.id} className={`feed-row ${fresh.has(a.id) ? "is-new" : "fadein"}`} title={a.detail ?? undefined}>
            <AgentAvatar agent={ag} size={24} />
            <div className="what">
              <span className="who">{ag.name}</span>
              {fresh.has(a.id) && <span className="new-badge" style={{ marginRight: 6 }}>new</span>}
              <Ico size={12} color={color} style={{ verticalAlign: -1, marginRight: 5 }} />
              {showProject && a.project_key && <Link to={`/p/${a.project_key}/activity`} className="code-tag" style={{ marginRight: 6 }}>{a.project_key}</Link>}
              <span style={compact ? { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } : undefined}>{a.summary}</span>
            </div>
            <span className="when" title={a.created_at}>{ago(a.created_at)}</span>
          </div>
        );
      })}
    </div>
  );
}
