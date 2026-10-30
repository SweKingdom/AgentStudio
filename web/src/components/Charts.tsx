import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell, Rectangle } from "recharts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { money, tokens as fmtTokens, duration } from "../lib/format";
import type { AgentLike } from "../lib/queries";
import { roleLabel } from "../lib/constants";

const SURFACE = "var(--panel)";

/** Recharts restarts its animation whenever it gets a new data array. Parents rebuild arrays on every render (live
 *  queries re-render often while agents work), which kept bars frozen mid-animation and their labels hidden — so hand
 *  Recharts the previous array while the content is unchanged. */
function useStable<T>(value: T): T {
  const ref = useRef<{ json: string; value: T } | null>(null);
  const json = JSON.stringify(value);
  if (!ref.current || ref.current.json !== json) ref.current = { json, value };
  return ref.current.value;
}

/** True for the chart's first second on screen: the entrance animation plays once, and live updates
 *  (every few hundred ms while agents run) redraw in place instead of re-growing from zero. */
function useIntro() {
  const [intro, setIntro] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setIntro(false), 1000);
    return () => clearTimeout(t);
  }, []);
  return intro;
}

function Tip({ active, payload, label, fmt }: { active?: boolean; payload?: any[]; label?: string; fmt: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => p.value);
  const total = rows.reduce((n, p) => n + (p.value as number), 0);
  return (
    <div className="tt">
      <div className="tt-title">{label ?? payload[0]?.payload?.label}</div>
      {payload[0]?.payload?.title && <div className="tiny muted" style={{ marginTop: -2, marginBottom: 4 }}>{payload[0].payload.title}</div>}
      {rows.map((p) => (
        <div key={p.dataKey} className="row" style={{ gap: 8 }}>
          <span className="dot" style={{ background: p.color ?? p.payload?.color }} />
          <span className="muted">{p.name}</span>
          <span className="spacer" />
          <span className="num strong">{fmt(p.value)}</span>
        </div>
      ))}
      {rows.length > 1 && (
        <div className="row" style={{ gap: 8, borderTop: "1px solid var(--line)", marginTop: 4, paddingTop: 4 }}>
          <span className="muted">Total</span><span className="spacer" /><span className="num strong">{fmt(total)}</span>
        </div>
      )}
    </div>
  );
}

export type Fmt = "money" | "tokens" | "duration" | "count";
const FMT: Record<Fmt, (v: number) => string> = {
  money: (v) => money(v),
  tokens: (v) => fmtTokens(v),
  duration: (v) => duration(v),
  count: (v) => String(Math.round(v)),
};

/** One measure per agent as horizontal bars, coloured by agent identity, value labelled at the bar end. */
/** A bar segment that also draws a value just past its end. Drawn by the shape (every animation frame), so the label
 *  always shows and travels with the bar — Recharts' own LabelList hides while live updates keep re-animating. */
function labelledShape(text: (payload: any) => string | null) {
  return (props: any) => {
    const { x, y, width, height, fill, payload } = props;
    const label = text(payload);
    return (
      <g>
        {width > 0 && <Rectangle {...props} fill={fill} />}
        {label && (
          <text x={x + Math.max(0, width) + 6} y={y + height / 2} dy="0.35em" fill="var(--text-2)" fontSize={11.5} style={{ fontVariantNumeric: "tabular-nums" }}>
            {label}
          </text>
        )}
      </g>
    );
  };
}

export function AgentBars({ rows, fmt = "money", height }: { rows: { agent: AgentLike; value: number }[]; fmt?: Fmt; height?: number }) {
  const f = FMT[fmt];
  const data = useStable(rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value).map((r) => ({ label: r.agent.name, role: roleLabel(r.agent), title: r.agent.title, value: r.value, color: r.agent.color })));
  const roles = useMemo(() => Object.fromEntries(data.map((d) => [d.label, d.role])), [data]);
  const shape = useMemo(() => labelledShape((p) => f(p.value)), [f]);
  if (!data.length) return <div className="empty small">No data yet.</div>;
  return (
    <ResponsiveContainer width="100%" height={height ?? Math.max(60, data.length * 40 + 16)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 64, bottom: 4, left: 4 }} barCategoryGap={10}>
        <XAxis type="number" hide domain={[0, "dataMax"]} />
        <YAxis type="category" dataKey="label" width={140} tickLine={false} axisLine={false} tick={(p: any) => <AgentTick {...p} role={roles[p.payload?.value]} />} />
        <Tooltip cursor={{ fill: "var(--panel-2)" }} content={<Tip fmt={f} />} />
        <Bar dataKey="value" name="Value" radius={[0, 4, 4, 0]} barSize={14} animationDuration={600} animationEasing="ease-out" shape={shape}>
          {data.map((d) => <Cell key={d.label} fill={d.color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Y-axis label for an agent row: name, and its role underneath, right-aligned against the bar. */
function AgentTick({ x, y, payload, role }: { x: number; y: number; payload: { value: string }; role?: string }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={-6} y={role ? -3 : 0} dy="0.35em" textAnchor="end" fill="var(--text-2)" fontSize={12} fontWeight={600}>{payload.value}</text>
      {role && <text x={-6} y={11} dy="0.35em" textAnchor="end" fill="var(--faint)" fontSize={10.5}>{role}</text>}
    </g>
  );
}

/** Stacked horizontal bars: one row per category (task/stage), segments per agent. */
export function StackedByAgent({
  rows, agents, fmt = "money", labelWidth = 120, empty = "No data yet.",
}: { rows: { label: string; values: Record<string, number> }[]; agents: AgentLike[]; fmt?: Fmt; labelWidth?: number; empty?: string }) {
  const f = FMT[fmt];
  const used = agents.filter((a) => rows.some((r) => (r.values[a.id] ?? 0) > 0));
  // Missing agents are 0 (not undefined) so every row has every segment — rows still in progress included. The total is
  // drawn by the row's last non-empty segment, so it sits at the end of the stack whichever agents have worked so far.
  const data = useStable(rows.map((r) => ({
    label: r.label,
    ...Object.fromEntries(used.map((a) => [a.id, r.values[a.id] ?? 0])),
    __total: Object.values(r.values).reduce((n, v) => n + v, 0),
    __last: [...used].reverse().find((a) => (r.values[a.id] ?? 0) > 0)?.id,
  })));
  const usedIds = used.map((a) => a.id).join(",");
  const shapes = useMemo(() => Object.fromEntries(used.map((a) => [a.id, labelledShape((p) => (p.__last === a.id ? f(p.__total) : null))])), [usedIds, f]);
  if (!rows.length) return <div className="empty small">{empty}</div>;
  return (
    <>
      <Legend items={used.map((a) => ({ color: a.color, label: <>{a.name} <span className="faint">· {roleLabel(a)}</span></> }))} />
      <ResponsiveContainer width="100%" height={Math.max(60, data.length * 28 + 20)}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 64, bottom: 4, left: 4 }} barCategoryGap={6}>
          <XAxis type="number" hide domain={[0, "dataMax"]} />
          <YAxis type="category" dataKey="label" width={labelWidth} tickLine={false} axisLine={false} tick={{ fill: "var(--text-2)", fontSize: 11.5 }} interval={0} />
          <Tooltip cursor={{ fill: "var(--panel-2)" }} content={<Tip fmt={f} />} />
          {used.map((a) => (
            <Bar key={a.id} dataKey={a.id} name={`${a.name} · ${roleLabel(a)}`} stackId="s" fill={a.color} stroke={SURFACE} strokeWidth={2} barSize={14}
              animationDuration={600} animationEasing="ease-out" shape={shapes[a.id]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </>
  );
}

/** Spend over time, stacked by agent. */
export function TimelineByAgent({ buckets, agents, fmt = "money" }: { buckets: { label: string; values: Record<string, number> }[]; agents: AgentLike[]; fmt?: Fmt }) {
  const intro = useIntro();
  const f = FMT[fmt];
  const used = agents.filter((a) => buckets.some((b) => (b.values[a.id] ?? 0) > 0));
  // Zeros instead of gaps so stacked areas stay continuous; a lone bucket is drawn as a flat step from zero.
  const rows = buckets.map((b) => ({ label: b.label, ...Object.fromEntries(used.map((a) => [a.id, b.values[a.id] ?? 0])) }));
  if (rows.length === 1) rows.unshift({ label: "", ...Object.fromEntries(used.map((a) => [a.id, 0])) });
  const data = useStable(rows);
  if (!buckets.length) return <div className="empty small">No spend recorded yet.</div>;
  return (
    <>
      <Legend items={used.map((a) => ({ color: a.color, label: <>{a.name} <span className="faint">· {roleLabel(a)}</span></> }))} />
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="0" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(v) => f(Number(v))} />
          <Tooltip content={<Tip fmt={f} />} cursor={{ stroke: "var(--faint)", strokeWidth: 1 }} />
          {used.map((a) => (
            <Area key={a.id} type="linear" dataKey={a.id} name={`${a.name} · ${roleLabel(a)}`} stackId="t" stroke={a.color} strokeWidth={2} fill={a.color} fillOpacity={0.22} dot={false} isAnimationActive={intro} animationDuration={800} animationEasing="ease-out" />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </>
  );
}

export function Legend({ items }: { items: { color: string; label: ReactNode }[] }) {
  if (items.length < 2) return null;
  return (
    <div className="row wrap" style={{ gap: 12, marginBottom: 8 }}>
      {items.map((i, idx) => (
        <span key={idx} className="row small muted" style={{ gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Thin proportional bar used inside tables and cards. */
export function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div className="mini-bar" style={{ height: 6, background: "var(--panel-3)", borderRadius: 4, overflow: "hidden", minWidth: 60 }}>
      <div style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%`, height: "100%", background: color, borderRadius: 4 }} />
    </div>
  );
}
