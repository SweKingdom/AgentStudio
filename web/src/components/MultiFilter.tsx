import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { t } from "../lib/i18n";

/** A filter with several values: a button that opens a checklist. Empty selection = no filter. */
export function MultiFilter({ label, options, value, onChange }: { label: string; options: { value: string; label?: string; count?: number }[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className={`btn sm ${value.length ? "" : "ghost"}`} aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(!open)}>
        {label}{value.length ? ` (${value.length})` : ""} <ChevronDown size={12} />
      </button>
      {open && (
        <div className="card" role="listbox" aria-multiselectable="true" aria-label={label} style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 30, minWidth: 220, maxHeight: 320, overflow: "auto", padding: 6, boxShadow: "var(--shadow-lg, 0 8px 24px rgba(0,0,0,.3))" }}>
          {options.length ? options.map((o) => (
            <label key={o.value} className="row small" style={{ gap: 8, padding: "5px 6px", cursor: "pointer", borderRadius: 6 }}>
              <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
              <span style={{ flex: 1 }} className="ellipsis">{o.label ?? o.value}</span>
              {o.count !== undefined && <span className="tiny faint">{o.count}</span>}
            </label>
          )) : <div className="small muted" style={{ padding: 6 }}>{t("Nothing to filter on")}</div>}
          {value.length > 0 && <button type="button" className="btn sm ghost" style={{ width: "100%", marginTop: 4 }} onClick={() => onChange([])}>{t("Clear")}</button>}
        </div>
      )}
    </div>
  );
}
