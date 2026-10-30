import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../lib/motion";

/** Number that counts up (from 0 on first render, then from its previous value) with an ease-out curve. */
export function Count({ value, format, duration = 750 }: { value: number; format: (n: number) => string; duration?: number }) {
  const from = useRef(0);
  const [shown, setShown] = useState(prefersReducedMotion() ? value : 0);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (prefersReducedMotion() || !Number.isFinite(value)) {
      setShown(value);
      from.current = value;
      return;
    }
    const a = from.current;
    const b = value;
    if (a === b) return;
    let raf = 0;
    const start = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(a + (b - a) * e);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = b;
    };
    raf = requestAnimationFrame(step);
    if (a !== 0) {
      setBump(true);
      window.setTimeout(() => setBump(false), 700);
    }
    return () => {
      cancelAnimationFrame(raf);
      from.current = b;
    };
  }, [value]);
  return <span className={bump ? "count-bump" : undefined}>{format(shown)}</span>;
}
