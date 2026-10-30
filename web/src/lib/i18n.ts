/**
 * UI language: English (the source text) or Swedish. `t("English text")` returns the Swedish translation when Swedish is
 * chosen and one exists, otherwise the English text — so an untranslated string never breaks the page.
 * `{name}` placeholders are filled from `vars`. The choice is kept in this browser only.
 */
import { useSyncExternalStore } from "react";
import { SV } from "./sv";

export type Lang = "en" | "sv";

const KEY = "agentstudio.lang";
const listeners = new Set<() => void>();

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "sv") return saved;
  } catch {
    /* storage blocked: fall through */
  }
  return navigator.language?.toLowerCase().startsWith("sv") ? "sv" : "en";
}

let lang: Lang = initial();
document.documentElement.lang = lang;

export function getLang() {
  return lang;
}

export function setLang(next: Lang) {
  if (next === lang) return;
  lang = next;
  document.documentElement.lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  for (const l of listeners) l();
}

/** Re-renders the caller (and so the tree under it) when the language changes. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lang,
  );
}

export function t(en: string, vars?: Record<string, string | number>): string {
  const text = lang === "sv" ? (SV[en] ?? en) : en;
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k]))) : text;
}
