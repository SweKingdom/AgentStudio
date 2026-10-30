import { cloneElement, isValidElement, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

/**
 * Hover/focus tooltip rendered in a portal so cards with overflow never clip it.
 * Wrap any input (or group of inputs) to explain what it is for.
 */
export function Hint({ text, children, block, placement = "top" }: { text: ReactNode; children: ReactNode; block?: boolean; placement?: "top" | "bottom" }) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const show = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const below = placement === "bottom" || r.top < 90;
      setPos({ x: Math.min(Math.max(12, r.left), window.innerWidth - 332), y: below ? r.bottom + 8 : r.top - 8, below });
    }, 280);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setPos(null);
  };
  const child = isValidElement(children) ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, { "aria-describedby": id }) : children;
  return (
    <span ref={ref} className={`hint-wrap ${block ? "block" : ""}`} onMouseEnter={show} onMouseLeave={hide} onFocusCapture={show} onBlurCapture={hide}>
      {child}
      {pos &&
        createPortal(
          <div role="tooltip" id={id} className={`tooltip ${pos.below ? "below" : ""}`} style={{ left: pos.x, top: pos.y }}>
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}

/** Label + control + explanation on hover. Use for every form input in the app. */
/** Red asterisk for required fields (with screen-reader text). */
export function Req() {
  return (
    <span className="req" title="Required">
      *<span className="sr-only"> (required)</span>
    </span>
  );
}

export function Field({ label, help, children, hint, className, style, required }: { label?: ReactNode; help: ReactNode; children: ReactNode; hint?: ReactNode; className?: string; style?: React.CSSProperties; required?: boolean }) {
  return (
    <div className={`field ${className ?? ""}`} style={style}>
      {label && (
        <label className="row" style={{ gap: 5 }}>
          <span>{label}{required && <Req />}</span>
          <Hint text={help}>
            <Info size={12} className="field-info" aria-label="What is this?" tabIndex={0} />
          </Hint>
        </label>
      )}
      <Hint text={help} block>
        {children}
      </Hint>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
