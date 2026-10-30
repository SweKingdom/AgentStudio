import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BookOpen, Bot, Brain, Bug, CheckCircle2, Cloud, Code2, Compass, Cpu, Crown, Database, FileText, ListOrdered, Network,
  Rocket, ScrollText, ShieldCheck, Sparkles, Trophy, User, Workflow, Wrench, X, Zap, ClipboardList, type LucideIcon,
} from "lucide-react";
import { category, stateColor, TYPE } from "../lib/constants";
import type { AgentLike } from "../lib/queries";

export const ICONS: Record<string, LucideIcon> = {
  ScrollText, Compass, ListOrdered, Code2, ShieldCheck, BookOpen, Rocket, Sparkles, Bot, Brain, Database, Wrench, Network, Cpu, Cloud, Zap, Workflow, User,
};

export function Icon({ name, size = 16, color }: { name: string; size?: number; color?: string }) {
  const C = ICONS[name] ?? Bot;
  return <C size={size} color={color} strokeWidth={1.9} />;
}

export function AgentAvatar({ agent, size = 28, active = false }: { agent: Pick<AgentLike, "color" | "icon" | "name">; size?: number; active?: boolean }) {
  return (
    <span
      className={`avatar ${active ? "pulse" : ""}`}
      title={agent.name}
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${agent.color} 18%, var(--panel))`,
        border: `1.5px solid color-mix(in srgb, ${agent.color} 70%, transparent)`,
        color: agent.color,
      }}
    >
      <Icon name={agent.icon} size={Math.round(size * 0.52)} />
    </span>
  );
}

export function AgentTag({ agent, active }: { agent: AgentLike; active?: boolean }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <AgentAvatar agent={agent} size={20} active={active} />
      <span className="strong small">{agent.name}</span>
    </span>
  );
}

export function CategoryChip({ value, small }: { value: string; small?: boolean }) {
  const c = category(value);
  return (
    <span className="chip" style={{ background: `color-mix(in srgb, ${c.color} 16%, transparent)`, color: c.color, height: small ? 18 : 20 }}>
      <span className="dot" style={{ background: c.color, width: 6, height: 6 }} />
      {c.label}
    </span>
  );
}

const TYPE_ICON: Record<string, LucideIcon> = { epic: Crown, feature: Trophy, story: FileText, task: ClipboardList, bug: Bug };

export function TypeIcon({ type, size = 14 }: { type: string; size?: number }) {
  const C = TYPE_ICON[type] ?? FileText;
  return <C size={size} color={TYPE[type]?.color ?? "#8a92a6"} strokeWidth={2.1} />;
}

export function StatePill({ state }: { state: string }) {
  const color = stateColor(state);
  return (
    <span className="pill" style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color, borderColor: `color-mix(in srgb, ${color} 30%, transparent)` }}>
      {state === "Deployed (Done)" ? <CheckCircle2 size={12} /> : <span className="dot" style={{ background: color, width: 6, height: 6 }} />}
      {state}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    draft: ["Draft", "#8a92a6"],
    ready: ["Ready to start", "#5aa9ff"],
    running: ["Running", "#3ecf8e"],
    paused: ["Paused", "#f5b84a"],
    awaiting_approval: ["Needs your approval", "#efab00"],
    completed: ["Completed", "#3ecf8e"],
    failed: ["Failed", "#f2555a"],
    stopped: ["Stopped", "#8a92a6"],
  };
  const [label, color] = map[status] ?? [status, "#8a92a6"];
  return (
    <span className="pill" style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color, borderColor: `color-mix(in srgb, ${color} 32%, transparent)` }}>
      {status === "running" ? <span className="live-dot" style={{ width: 6, height: 6 }} /> : <span className="dot" style={{ background: color, width: 6, height: 6 }} />}
      {label}
    </span>
  );
}

/** Markdown renderer. `assetBase` resolves relative image paths (e.g. test evidence) — images open full-size on click. */
export function Markdown({ children, assetBase }: { children: string; assetBase?: string }) {
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => {
            const raw = typeof src === "string" ? src : "";
            const resolved = assetBase && raw && !/^(https?:|\/|data:)/.test(raw) ? `${assetBase}${encodeURIComponent(raw)}` : raw;
            if (!/^(https?:|\/api\/|data:image\/)/.test(resolved)) return <span className="faint">[image: {alt}]</span>;
            return (
              <img src={resolved} alt={alt ?? ""} className="md-img" loading="lazy" onClick={() => setZoom({ src: resolved, alt: alt ?? "" })} title="Click to enlarge" />
            );
          },
        }}
      >
        {children || "_Empty_"}
      </ReactMarkdown>
      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)} role="dialog" aria-label={zoom.alt}>
          <img src={zoom.src} alt={zoom.alt} />
          <div className="lightbox-cap">{zoom.alt} · click anywhere to close</div>
        </div>
      )}
    </div>
  );
}

export function Kpi({ label, value, foot, icon, accent }: { label: string; value: ReactNode; foot?: ReactNode; icon?: ReactNode; accent?: boolean }) {
  return (
    <div className="card kpi">
      <div className="kpi-label">{icon}{label}</div>
      <div className={`kpi-value ${accent ? "accent" : ""}`}>{value}</div>
      {foot && <div className="kpi-foot">{foot}</div>}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon ?? <Sparkles size={20} />}</div>
      <h3>{title}</h3>
      {children && <div className="small" style={{ maxWidth: 440 }}>{children}</div>}
      {action}
    </div>
  );
}

export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" role="dialog">{children}</aside>
    </>
  );
}

export function Modal({ onClose, title, children, footer, wide }: { onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog">
        <div className="card-head">
          <div className="card-title">{title}</div>
          <button className="btn ghost sm icon" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="card-pad">{children}</div>
        {footer && <div className="card-head" style={{ borderTop: "1px solid var(--line)", borderBottom: 0, justifyContent: "flex-end" }}>{footer}</div>}
      </div>
    </>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)} aria-pressed={on} aria-label={label} />;
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button type="button" key={o.value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">{title}{right}</div>
      {children}
    </div>
  );
}

export function TestBadge({ t }: { t?: { pass: number; fail: number; blocked: number } | null }) {
  if (!t || (!t.pass && !t.fail && !t.blocked)) return null;
  return (
    <span className="row tiny" style={{ gap: 6 }}>
      {t.pass > 0 && <span style={{ color: "var(--good)" }}>✓{t.pass}</span>}
      {t.fail > 0 && <span style={{ color: "var(--bad)" }}>✗{t.fail}</span>}
      {t.blocked > 0 && <span style={{ color: "var(--warn)" }}>⛔{t.blocked}</span>}
    </span>
  );
}
