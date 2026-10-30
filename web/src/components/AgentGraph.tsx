import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, Background, Controls, Handle, Position, EdgeLabelRenderer, useInternalNode, useReactFlow, useStore,
  type Node, type Edge, type NodeProps, type EdgeProps, BackgroundVariant,
} from "@xyflow/react";
import type { Graph, GraphNode } from "../lib/api";
import { useLiveEvent } from "../lib/live";
import { money, num } from "../lib/format";
import { AgentAvatar } from "./ui";

const ORDER = ["human", "orchestrator", "requirements", "architect", "planner", "developer", "qa", "writer", "release", "specialist"];
const SIZE = 58;
const HOT_MS = 6000;

type AgentNodeData = Record<string, never>;

/**
 * Live data (stats, activity, selection) reaches the nodes through context, NOT through node objects: React Flow
 * re-measures any node whose object changes and briefly drops its edges, which restarted every edge animation.
 */
const GraphLive = createContext<{ byId: Map<string, GraphNode>; selection: GraphSelection; related: (id: string) => boolean }>({
  byId: new Map(),
  selection: {},
  related: () => true,
});
type FlowEdgeData = { count: number; color: string; hot: boolean; hotAt: number; kinds: string[]; selected: boolean; dim: boolean; onPick: () => void };

const AgentNode = memo(function AgentNode({ id }: NodeProps<Node<AgentNodeData>>) {
  const live = useContext(GraphLive);
  const n = live.byId.get(id);
  if (!n) return null;
  const data = { selected: live.selection.agent === id, dim: !live.related(id) };
  const pseudo = n.role === "human" || n.role === "orchestrator";
  return (
    <div className="agent-node-body" style={{ width: SIZE, height: SIZE, position: "relative", opacity: data.dim ? 0.35 : 1, transition: "opacity .2s" }}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0, left: "50%", top: "50%" }} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, left: "50%", top: "50%" }} isConnectable={false} />
      <div
        style={{
          borderRadius: "50%",
          boxShadow: data.selected ? `0 0 0 3px var(--bg), 0 0 0 5px ${n.color}` : n.active ? `0 0 26px color-mix(in srgb, ${n.color} 55%, transparent)` : "none",
          transition: "box-shadow .2s",
        }}
      >
        <AgentAvatar agent={n} size={SIZE} active={n.active > 0} />
      </div>
      <div className="anode" style={{ position: "absolute", top: SIZE + 6, left: "50%", transform: "translateX(-50%)" }}>
        <div className="anode-name">{n.name}</div>
        <div className="anode-title">{n.title}</div>
        {!pseudo && (
          <div className="anode-stats">{money(n.costUsd)} · {num(n.calls)} calls</div>
        )}
        {n.active > 0 && <div className="anode-doing">● {n.activeItem ? `working on ${n.activeItem}` : n.activeStage}</div>}
      </div>
    </div>
  );
});

function FloatingEdge({ id, source, target, data, markerEnd }: EdgeProps<Edge<FlowEdgeData>>) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t || !data) return null;
  const sx0 = s.internals.positionAbsolute.x + SIZE / 2;
  const sy0 = s.internals.positionAbsolute.y + SIZE / 2;
  const tx0 = t.internals.positionAbsolute.x + SIZE / 2;
  const ty0 = t.internals.positionAbsolute.y + SIZE / 2;
  const dx = tx0 - sx0;
  const dy = ty0 - sy0;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / len;
  const uy = dy / len;
  // Bend to the left of travel direction so A→B and B→A never overlap.
  const bend = Math.min(60, len * 0.14);
  const cx = (sx0 + tx0) / 2 - uy * bend;
  const cy = (sy0 + ty0) / 2 + ux * bend;
  const r = SIZE / 2 + 4;
  const v1x = cx - sx0, v1y = cy - sy0, l1 = Math.hypot(v1x, v1y) || 1;
  const v2x = cx - tx0, v2y = cy - ty0, l2 = Math.hypot(v2x, v2y) || 1;
  const sx = sx0 + (v1x / l1) * r, sy = sy0 + (v1y / l1) * r;
  const tx = tx0 + (v2x / l2) * (r + 4), ty = ty0 + (v2y / l2) * (r + 4);
  const path = `M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`;
  const mx = 0.25 * sx + 0.5 * cx + 0.25 * tx;
  const my = 0.25 * sy + 0.5 * cy + 0.25 * ty;
  const width = 1.2 + Math.log2(data.count + 1) * 0.9;
  const opacity = data.dim ? 0.12 : data.hot || data.selected ? 1 : 0.55;
  return (
    <>
      <path id={id} d={path} fill="none" stroke={data.color} strokeWidth={width + (data.selected ? 1.5 : 0)} strokeOpacity={opacity} markerEnd={markerEnd}
        strokeDasharray={data.kinds.includes("rework") ? "5 4" : undefined}
        style={{ transition: "stroke-opacity .2s, stroke-width .3s" }} />
      <path d={path} fill="none" stroke="transparent" strokeWidth={14} style={{ cursor: "pointer" }} onClick={data.onPick} />
      {data.hot && (
        <>
          <path d={path} fill="none" stroke={data.color} strokeWidth={width + 5} strokeOpacity={0.18} />
          <circle key={data.hotAt} r={4.5} fill={data.color}>
            <animateMotion dur="1.1s" repeatCount="indefinite" path={path} />
          </circle>
        </>
      )}
      <EdgeLabelRenderer>
        <div
          className={`edge-label ${data.hot ? "hot" : ""}`}
          style={{ transform: `translate(-50%, -50%) translate(${mx}px, ${my}px)`, opacity: data.dim ? 0.25 : 1 }}
          onClick={data.onPick}
          title={`${data.count} message(s): ${data.kinds.join(", ")}`}
        >
          {data.count}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/** Re-fit whenever the set of agents changes, once React Flow has measured the nodes. */
function AutoFit({ signature }: { signature: string }) {
  const { fitView } = useReactFlow();
  // Not useNodesInitialized(): it also waits for handle bounds, and these nodes have no handles (floating edges), so it
  // never turns true and the graph was never fitted. Measured sizes are what fitView actually needs.
  const ready = useStore((st) => st.nodeLookup.size > 0 && [...st.nodeLookup.values()].every((n) => (n.measured?.width ?? 0) > 0));
  useEffect(() => {
    // A background tab measures nodes as 0×0 and would fit to max zoom — wait until the page is visible.
    if (!ready || document.visibilityState !== "visible") return;
    const t = setTimeout(() => fitView({ padding: 0.28, maxZoom: 1.15, duration: 250 }), 30);
    return () => clearTimeout(t);
  }, [ready, signature, fitView]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setTimeout(() => fitView({ padding: 0.28, maxZoom: 1.15 }), 60);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fitView]);
  return null;
}

const nodeTypes = { agent: AgentNode };
const edgeTypes = { floating: FloatingEdge };

export interface GraphSelection { agent?: string; pair?: [string, string] }

export default function AgentGraph({
  graph, projectId, selection, onSelect,
}: { graph: Graph; projectId?: string; selection: GraphSelection; onSelect: (s: GraphSelection) => void }) {
  const [recent, setRecent] = useState<Record<string, number>>({});
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 600 });
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const [, tick] = useState(0);

  useLiveEvent((e) => {
    if (e.type !== "message" || !e.data) return;
    if (projectId && e.projectId !== projectId) return;
    const key = `${e.data.from_agent_id}>${e.data.to_agent_id}`;
    setRecent((r) => ({ ...r, [key]: Date.now() }));
  });
  // Re-render only when a live highlight expires (not on a fixed interval, which restarts SVG animations).
  useEffect(() => {
    const next = Math.min(...Object.values(recent).map((t) => t + HOT_MS - Date.now()).filter((ms) => ms > 0));
    if (!Number.isFinite(next)) return;
    const t = setTimeout(() => tick((x) => x + 1), next + 30);
    return () => clearTimeout(t);
  }, [recent]);

  const positions = useMemo(() => {
    // You in the centre, the orchestrator just below, every agent on a circle around you (pipeline order, clockwise from the top).
    const pos: Record<string, { x: number; y: number }> = {};
    const center = graph.nodes.filter((n) => n.role === "human" || n.role === "orchestrator");
    const ring = graph.nodes
      .filter((n) => n.role !== "human" && n.role !== "orchestrator")
      .sort((a, b) => {
        const ra = ORDER.indexOf(a.role), rb = ORDER.indexOf(b.role);
        return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.name.localeCompare(b.name);
      });
    for (const n of center) pos[n.id] = n.role === "human" ? { x: -SIZE / 2, y: -SIZE - 40 } : { x: -SIZE / 2, y: 40 };
    const count = Math.max(ring.length, 1);
    // A true circle, big enough that neighbours' labels (~160px wide) never touch and the centre pair has room.
    const r = Math.max(270, (count * 175) / (2 * Math.PI), Math.min(size.w, size.h) * 0.36);
    ring.forEach((node, i) => {
      const a = -Math.PI / 2 + (i / count) * Math.PI * 2;
      pos[node.id] = { x: Math.cos(a) * r - SIZE / 2, y: Math.sin(a) * r - SIZE / 2 };
    });
    return pos;
  }, [graph.nodes.map((n) => n.id + n.role).join("|"), Math.round(size.w / 40), Math.round(size.h / 40)]);

  const layoutKey = graph.nodes.map((n) => `${n.id}@${Math.round(positions[n.id]?.x ?? 0)},${Math.round(positions[n.id]?.y ?? 0)}`).join("|");
  const nodes: Node<AgentNodeData>[] = useMemo(
    () => graph.nodes.map((n) => ({ id: n.id, type: "agent", position: positions[n.id] ?? { x: 0, y: 0 }, data: {}, draggable: false })),
    [layoutKey],
  );
  const live = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const related = (id: string) =>
      selection.agent
        ? id === selection.agent || graph.edges.some((e) => (e.from === selection.agent && e.to === id) || (e.to === selection.agent && e.from === id))
        : selection.pair
          ? selection.pair.includes(id)
          : true;
    return { byId, selection, related };
  }, [graph, selection]);

  const now = Date.now();
  const colorOf = (id: string) => graph.nodes.find((n) => n.id === id)?.color ?? "#8a92a6";
  const edges: Edge<FlowEdgeData>[] = graph.edges.map((e) => {
    const hot = now - (recent[`${e.from}>${e.to}`] ?? 0) < HOT_MS;
    const sel = selection.pair ? selection.pair[0] === e.from && selection.pair[1] === e.to : false;
    const dim = selection.agent ? e.from !== selection.agent && e.to !== selection.agent : selection.pair ? !sel : false;
    const color = colorOf(e.from);
    return {
      id: `${e.from}>${e.to}`,
      source: e.from,
      target: e.to,
      type: "floating",
      markerEnd: { type: "arrowclosed" as never, color, width: 16, height: 16 },
      data: { count: e.count, color, hot, hotAt: recent[`${e.from}>${e.to}`] ?? 0, kinds: e.kinds, selected: sel, dim, onPick: () => onSelect({ pair: [e.from, e.to] }) },
    };
  });

  return (
    <GraphLive.Provider value={live}>
    <div ref={box} style={{ width: "100%", height: "100%" }}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitViewOptions={{ padding: 0.28, maxZoom: 1.15 }}
      minZoom={0.3}
      maxZoom={1.8}
      onNodeClick={(_e, n) => onSelect(selection.agent === n.id ? {} : { agent: n.id })}
      onPaneClick={() => onSelect({})}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
    >
      <AutoFit signature={`${graph.nodes.map((n) => n.id).join("|")}:${Math.round(size.w / 40)}x${Math.round(size.h / 40)}`} />
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--line-2)" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
    </div>
    </GraphLive.Provider>
  );
}
