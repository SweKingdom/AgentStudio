import { useSyncExternalStore } from "react";
export interface Toast { id: number; text: string; kind: "info" | "bad" }
let toasts: Toast[] = [];
const subs = new Set<() => void>();
let n = 0;
export function toast(text: string, kind: Toast["kind"] = "info") {
  const t = { id: ++n, text, kind };
  toasts = [...toasts, t];
  subs.forEach((s) => s());
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); subs.forEach((s) => s()); }, 4500);
}
export function useToasts() {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => toasts);
}
