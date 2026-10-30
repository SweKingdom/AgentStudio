import { useEffect, useState } from "react";
import { createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** GitHub's own light/dark themes, following the app theme. Only the languages the agents write are bundled. */
export const THEMES = { dark: "github-dark-default", light: "github-light-default" } as const;
export const CODE_BG = { dark: "#0d1117", light: "#ffffff" } as const;

let instance: Promise<HighlighterCore> | null = null;
function highlighter() {
  instance ??= createHighlighterCore({
    themes: [import("shiki/themes/github-dark-default.mjs"), import("shiki/themes/github-light-default.mjs")],
    langs: [
      import("shiki/langs/apex.mjs"),
      import("shiki/langs/xml.mjs"),
      import("shiki/langs/html.mjs"),
      import("shiki/langs/javascript.mjs"),
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/shellscript.mjs"),
      import("shiki/langs/markdown.mjs"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/css.mjs"),
      import("shiki/langs/sql.mjs"),
    ],
    engine: createJavaScriptRegexEngine(),
  });
  return instance;
}

export function langFor(path: string) {
  const p = path.toLowerCase();
  if (/\.(cls|trigger|apex)$/.test(p)) return "apex";
  if (/\.xml$/.test(p)) return "xml";
  if (/\.html?$/.test(p)) return "html";
  if (/\.(js|mjs|cjs)$/.test(p)) return "javascript";
  if (/\.ts$/.test(p)) return "typescript";
  if (/\.(sh|bash)$/.test(p)) return "shellscript";
  if (/\.md$/.test(p)) return "markdown";
  if (/\.json$/.test(p)) return "json";
  if (/\.css$/.test(p)) return "css";
  if (/\.(soql|sql)$/.test(p)) return "sql";
  return "text";
}

/** Current app theme ("dark" unless the user picked light). */
export function useAppTheme(): "dark" | "light" {
  const read = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [theme, setTheme] = useState<"dark" | "light">(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

export type TokenLine = ThemedToken[];

/** Tokenises code into lines of coloured tokens; returns null until the highlighter has loaded. */
export function useTokens(code: string | undefined, path: string, theme: "dark" | "light") {
  const [lines, setLines] = useState<TokenLine[] | null>(null);
  useEffect(() => {
    if (code == null) return;
    let alive = true;
    const lang = langFor(path);
    if (lang === "text") {
      setLines(code.split("\n").map((l) => [{ content: l, offset: 0 } as ThemedToken]));
      return;
    }
    highlighter()
      .then((h) => h.codeToTokensBase(code, { lang, theme: THEMES[theme] }))
      .then((t) => alive && setLines(t))
      .catch(() => alive && setLines(code.split("\n").map((l) => [{ content: l, offset: 0 } as ThemedToken])));
    return () => {
      alive = false;
    };
  }, [code, path, theme]);
  return lines;
}
