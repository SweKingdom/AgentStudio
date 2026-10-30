import { useSyncExternalStore } from "react";

/** Open project tabs (browser-like), persisted per viewer. */
const KEY = "arm.openTabs";
let tabs: string[] = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; }
})();
const subs = new Set<() => void>();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(tabs)); } catch { /* private mode */ }
  subs.forEach((s) => s());
}
export function openTab(key: string) {
  if (!tabs.includes(key)) { tabs = [...tabs, key]; save(); }
}
export function closeTab(key: string) {
  tabs = tabs.filter((t) => t !== key);
  save();
}
export function useTabs() {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => tabs);
}
