import { useEffect, useRef, useState } from "react";

export function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Returns the ids that appeared after the list was first shown, for `ttl` ms — so new entries can be highlighted
 * without flashing everything on page load. An initially empty list counts as "loaded" after a short grace period.
 */
export function useFresh<T extends string | number>(ids: T[], ttl = 5000) {
  const seen = useRef<Set<T> | null>(null);
  const mountedAt = useRef(Date.now());
  const timers = useRef<number[]>([]);
  const [fresh, setFresh] = useState<Set<T>>(() => new Set());
  const key = ids.join("|");
  useEffect(() => {
    if (!seen.current) {
      if (ids.length === 0 && Date.now() - mountedAt.current < 1500) return;
      seen.current = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !seen.current!.has(id));
    if (!added.length) return;
    added.forEach((id) => seen.current!.add(id));
    setFresh((prev) => new Set([...prev, ...added]));
    timers.current.push(
      window.setTimeout(() => {
        setFresh((prev) => {
          const next = new Set(prev);
          added.forEach((a) => next.delete(a));
          return next;
        });
      }, ttl),
    );
  }, [key]);
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  return fresh;
}
