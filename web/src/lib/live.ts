import { useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

export interface LiveEvent { type: string; projectId?: string | null; data?: any }

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let connected = false;
const statusListeners = new Set<(c: boolean) => void>();

function ensure() {
  // Print pages are static snapshots: no live stream (it would also keep headless "print to PDF" waiting forever).
  // A stream refused with 401 (signed out) is closed for good — open a fresh one after signing in.
  if ((source && source.readyState !== EventSource.CLOSED) || location.pathname.startsWith("/print/")) return;
  source = new EventSource("/api/events");
  source.onopen = () => { connected = true; statusListeners.forEach((l) => l(true)); };
  source.onerror = () => { connected = false; statusListeners.forEach((l) => l(false)); };
  source.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as LiveEvent;
      listeners.forEach((l) => l(e));
    } catch { /* ignore */ }
  };
}

/** Signing out: drop the stream that was opened with the old session. */
export function closeLive() {
  source?.close();
  source = null;
  connected = false;
  statusListeners.forEach((l) => l(false));
}

export function useLiveEvent(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ensure();
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
}

export function useConnected() {
  const [c, setC] = useState(connected);
  useEffect(() => {
    ensure();
    statusListeners.add(setC);
    return () => { statusListeners.delete(setC); };
  }, []);
  return c;
}

/** Translates server events into throttled react-query invalidations. Mounted once at the app root. */
export function useLiveInvalidation() {
  const qc = useQueryClient();
  const pending = useRef(new Map<string, QueryKey>());
  const timer = useRef<number | null>(null);
  const flush = () => {
    for (const key of pending.current.values()) qc.invalidateQueries({ queryKey: key });
    pending.current.clear();
    timer.current = null;
  };
  const mark = (...keys: QueryKey[]) => {
    for (const k of keys) pending.current.set(JSON.stringify(k), k);
    if (timer.current == null) timer.current = window.setTimeout(flush, 500);
  };
  useLiveEvent((e) => {
    const p = e.projectId ?? undefined;
    switch (e.type) {
      case "project":
        mark(["projects"], ["project"]);
        break;
      case "item":
        mark(["items", p], ["item"], ["project"], ["projects"], ["metrics", p], ["tests", p]);
        break;
      case "run":
        mark(["graph"], ["project"], ["projects"], ["agents"], ["items", p], ["agent"]);
        break;
      case "activity":
        mark(["activity"]);
        break;
      case "message":
        mark(["messages", p], ["graph"], ["item"]);
        break;
      case "cost":
        mark(["costs"], ["projects"], ["project"], ["agents"], ["graph"], ["items", p]);
        break;
      case "document":
        mark(["documents", p], ["doc"]);
        break;
      case "file":
        mark(["files", p]);
        break;
      case "question":
        mark(["questions", p], ["project"], ["projects"]);
        break;
      case "agent":
        mark(["agents"], ["agent"], ["graph"]);
        break;
    }
  });
}
