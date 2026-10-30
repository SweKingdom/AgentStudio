import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, MessageSquare, MessagesSquare, X } from "lucide-react";
import { openChat } from "./Modals";
import { api, type Graph, type Message } from "../lib/api";
import { useAgentLookup } from "../lib/queries";
import { money, num, tokens } from "../lib/format";
import AgentGraph, { type GraphSelection } from "./AgentGraph";
import { MessageList } from "./Feeds";
import { AgentAvatar, Empty } from "./ui";

export default function NetworkView({ projectId, projectKey }: { projectId?: string; projectKey?: string }) {
  // The project header is taller than the global page header; keep the graph fully inside the viewport.
  const height = projectId ? "calc(100vh - 330px)" : "calc(100vh - 190px)";
  const [sel, setSel] = useState<GraphSelection>({});
  const agent = useAgentLookup();
  const { data: graph } = useQuery({
    queryKey: ["graph", projectId ?? "all"],
    queryFn: () => api.get<Graph>(projectId ? `/projects/${projectId}/graph` : "/graph"),
  });
  const { data: messages } = useQuery({
    queryKey: ["messages", projectId ?? "all"],
    queryFn: () => api.get<Message[]>(projectId ? `/projects/${projectId}/messages` : "/messages?limit=300"),
  });

  const filtered = (messages ?? []).filter((m) =>
    sel.agent ? m.from_agent_id === sel.agent || m.to_agent_id === sel.agent : sel.pair ? m.from_agent_id === sel.pair[0] && m.to_agent_id === sel.pair[1] : true,
  );
  const node = sel.agent ? graph?.nodes.find((n) => n.id === sel.agent) : undefined;
  const totalMsgs = graph?.edges.reduce((n, e) => n + e.count, 0) ?? 0;

  return (
    <div className="grid net-grid">
      <div className="graph-wrap" style={{ height }}>
        {graph && graph.nodes.length ? <AgentGraph graph={graph} projectId={projectId} selection={sel} onSelect={setSel} /> : <Empty title="No agents yet" />}
        <div className="card" style={{ position: "absolute", top: 12, left: 12, padding: "8px 12px", fontSize: 12, display: "flex", gap: 14, alignItems: "center" }}>
          <span><b className="num">{graph?.nodes.length ?? 0}</b> <span className="muted">agents</span></span>
          <span><b className="num">{num(totalMsgs)}</b> <span className="muted">messages</span></span>
          <span className="muted row" style={{ gap: 5 }}><span style={{ width: 16, borderTop: "2px dashed var(--muted)" }} /> rework</span>
          <span className="muted row" style={{ gap: 5 }}><span className="dot" style={{ background: "var(--accent)" }} /> live message</span>
        </div>
      </div>
      <div className="card" style={{ height, minHeight: 460, display: "flex", flexDirection: "column" }}>
        <div className="card-head">
          {node ? (
            <div className="row" style={{ gap: 10, minWidth: 0 }}>
              <AgentAvatar agent={node} size={30} active={node.active > 0} />
              <div style={{ minWidth: 0 }}>
                <div className="strong">{node.name}</div>
                <div className="tiny muted ellipsis">{node.title}</div>
              </div>
            </div>
          ) : sel.pair ? (
            <div className="row small" style={{ gap: 6 }}>
              <AgentAvatar agent={agent(sel.pair[0])} size={22} /> <b>{agent(sel.pair[0]).name}</b>
              <ArrowRight size={12} />
              <AgentAvatar agent={agent(sel.pair[1])} size={22} /> <b>{agent(sel.pair[1]).name}</b>
            </div>
          ) : (
            <div className="card-title"><MessagesSquare size={15} /> Conversation</div>
          )}
          <div className="row" style={{ gap: 4 }}>
            {node && node.role !== "human" && node.role !== "orchestrator" && (
              <button className="btn sm" onClick={() => openChat(node.id, projectId)} title={`Ask ${node.name} about its work`}><MessageSquare size={13} /> Chat</button>
            )}
            {(sel.agent || sel.pair) && <button className="btn ghost sm icon" onClick={() => setSel({})} aria-label="Clear selection"><X size={14} /></button>}
          </div>
        </div>
        {node && node.role !== "human" && node.role !== "orchestrator" && (
          <div className="grid g3" style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
            <div className="stat"><span className="v">{money(node.costUsd)}</span><span className="l">cost</span></div>
            <div className="stat"><span className="v">{num(node.calls)}</span><span className="l">calls</span></div>
            <div className="stat"><span className="v">{tokens(node.tokens)}</span><span className="l">tokens</span></div>
          </div>
        )}
        <div style={{ overflowY: "auto", flex: 1 }}>
          <MessageList messages={filtered} projectKey={projectKey} empty={sel.agent || sel.pair ? "No messages for this selection." : "Agents haven't talked yet — start a project."} />
        </div>
        <div className="tiny faint" style={{ padding: "8px 14px", borderTop: "1px solid var(--line)" }}>Click an agent or an edge count to filter, and any message for details. Edge width grows with message volume.</div>
      </div>
    </div>
  );
}
