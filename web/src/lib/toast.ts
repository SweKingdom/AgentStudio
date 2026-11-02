import { useSyncExternalStore } from "react";
import { t as translate } from "./i18n";
export interface Toast { id: number; text: string; kind: "info" | "bad" }
let toasts: Toast[] = [];
const subs = new Set<() => void>();
let n = 0;
export function toast(text: string, kind: Toast["kind"] = "info") {
  // Fixed messages are translated here, so every toast follows the interface language.
  const t = { id: ++n, text: translate(text), kind };
  toasts = [...toasts, t];
  subs.forEach((s) => s());
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); subs.forEach((s) => s()); }, 4500);
}
export function useToasts() {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => toasts);
}
