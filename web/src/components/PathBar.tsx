import type { ReactNode } from "react";
import { Check, Hand, Loader2, X } from "lucide-react";
import { Hint } from "./Hint";
import { t } from "../lib/i18n";

export interface PathStep {
  key: string;
  label: string;
  status: "pending" | "running" | "done" | "skipped" | "awaiting_approval" | "failed";
  gate?: boolean;
  /** Small trailing content. */
  extra?: ReactNode;
  /** Identity colours of the agents that own the stage — drawn as the step's border, split when there are several. */
  colors?: string[];
  help?: ReactNode;
}

const STATUS_TEXT: Record<PathStep["status"], string> = {
  done: "Done",
  running: "In progress",
  awaiting_approval: "Waiting for your approval",
  skipped: "Skipped — no agent for this stage",
  pending: "Not started",
  failed: "Failed",
};

/** Hard-stop gradient: one equal band per agent, so a shared step's border is split into their colours. */
function edgeGradient(colors: string[]) {
  if (colors.length === 1) return colors[0];
  const w = 100 / colors.length;
  return `linear-gradient(90deg, ${colors.map((c, i) => `${c} ${(i * w).toFixed(2)}% ${((i + 1) * w).toFixed(2)}%`).join(", ")})`;
}

/** Chevron path: one arrow per stage, coloured by status. */
export function PathBar({ steps, compact }: { steps: PathStep[]; compact?: boolean }) {
  return (
    <ol className={`path ${compact ? "compact" : ""}`} aria-label="Pipeline stages">
      {steps.map((s, i) => {
        const icon =
          s.status === "done" ? <Check size={13} strokeWidth={3} /> :
          s.status === "running" ? <Loader2 size={13} className="spin" /> :
          s.status === "awaiting_approval" ? <Hand size={13} /> :
          s.status === "failed" ? <X size={13} strokeWidth={3} /> : null;
        return (
          <li
            key={s.key}
            className={`path-step ${s.status} ${s.gate ? "gate" : ""} ${i === 0 ? "first" : ""} ${i === steps.length - 1 ? "last" : ""} ${s.colors?.length ? "owned" : ""}`}
            style={s.colors?.length ? { ["--edge" as string]: edgeGradient(s.colors) } : undefined}
            aria-current={s.status === "running" || s.status === "awaiting_approval" ? "step" : undefined}
          >
            <span className="path-fill" aria-hidden />
            <Hint
              block
              text={
                <>
                  <b>{t(s.label)}</b> — {t(STATUS_TEXT[s.status])}
                  {s.help ? <div style={{ marginTop: 4, fontWeight: 400 }}>{s.help}</div> : null}
                </>
              }
            >
              <div className="path-inner">
                {icon && <span className="path-icon">{icon}</span>}
                <span className="path-label">{t(s.label)}</span>
                {s.extra && !compact && <span className="path-extra">{s.extra}</span>}
              </div>
            </Hint>
          </li>
        );
      })}
    </ol>
  );
}
