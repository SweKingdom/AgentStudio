import { Fragment, useMemo, useState } from "react";
import { diffLines } from "diff";
import { ChevronsUpDown } from "lucide-react";
import { CODE_BG, useAppTheme, useTokens, type TokenLine } from "../lib/highlight";

function Tokens({ line, fallback }: { line?: TokenLine; fallback: string }) {
  if (!line) return <>{fallback || " "}</>;
  if (!line.length) return <> </>;
  return (
    <>
      {line.map((t, i) => (
        <span key={i} style={{ color: t.color, fontStyle: t.fontStyle === 1 ? "italic" : undefined, fontWeight: t.fontStyle === 2 ? 600 : undefined }}>
          {t.content}
        </span>
      ))}
    </>
  );
}

/** A whole file, syntax-highlighted with GitHub's theme. */
export function FileCode({ content, path, maxHeight }: { content: string; path: string; maxHeight?: string }) {
  const theme = useAppTheme();
  const tokens = useTokens(content, path, theme);
  const lines = content.split("\n");
  return (
    <div className={`gh-code gh-${theme}`} style={{ background: CODE_BG[theme], maxHeight }}>
      <table className="gh-table">
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="gh-num">{i + 1}</td>
              <td className="gh-line"><Tokens line={tokens?.[i]} fallback={l} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Row = { kind: "ctx" | "add" | "del"; oldNo: number | null; newNo: number | null; text: string };

function buildRows(before: string, after: string): Row[] {
  const rows: Row[] = [];
  let o = 1;
  let n = 1;
  for (const part of diffLines(before, after)) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    for (const text of lines) {
      if (part.added) rows.push({ kind: "add", oldNo: null, newNo: n++, text });
      else if (part.removed) rows.push({ kind: "del", oldNo: o++, newNo: null, text });
      else rows.push({ kind: "ctx", oldNo: o++, newNo: n++, text });
    }
  }
  return rows;
}

const CONTEXT = 3;

/** Unified diff (GitHub style): green additions, red deletions, unchanged runs collapsed. */
export function FileDiff({ before, after, path, maxHeight }: { before: string; after: string; path: string; maxHeight?: string }) {
  const theme = useAppTheme();
  const oldTokens = useTokens(before, path, theme);
  const newTokens = useTokens(after, path, theme);
  const rows = useMemo(() => buildRows(before, after), [before, after]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const added = rows.filter((r) => r.kind === "add").length;
  const removed = rows.filter((r) => r.kind === "del").length;

  // Group unchanged runs so long ones collapse to a clickable "N unchanged lines" row.
  const blocks: ({ type: "rows"; rows: Row[] } | { type: "gap"; id: number; rows: Row[] })[] = [];
  let i = 0;
  let gapId = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "ctx") {
      const start = i;
      while (i < rows.length && rows[i].kind !== "ctx") i++;
      blocks.push({ type: "rows", rows: rows.slice(start, i) });
      continue;
    }
    const start = i;
    while (i < rows.length && rows[i].kind === "ctx") i++;
    const run = rows.slice(start, i);
    const head = start === 0 ? 0 : CONTEXT;
    const tail = i === rows.length ? 0 : CONTEXT;
    if (run.length > head + tail + 2) {
      if (head) blocks.push({ type: "rows", rows: run.slice(0, head) });
      blocks.push({ type: "gap", id: gapId++, rows: run.slice(head, run.length - tail) });
      if (tail) blocks.push({ type: "rows", rows: run.slice(run.length - tail) });
    } else blocks.push({ type: "rows", rows: run });
  }

  const line = (r: Row, k: string) => (
    <tr key={k} className={`gh-${r.kind}`}>
      <td className="gh-num">{r.oldNo ?? ""}</td>
      <td className="gh-num">{r.newNo ?? ""}</td>
      <td className="gh-mark">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</td>
      <td className="gh-line">
        <Tokens line={r.kind === "del" ? oldTokens?.[(r.oldNo ?? 1) - 1] : newTokens?.[(r.newNo ?? 1) - 1]} fallback={r.text} />
      </td>
    </tr>
  );

  return (
    <div className={`gh-code gh-${theme}`} style={{ background: CODE_BG[theme], maxHeight }}>
      <div className="gh-diffstat">
        <span className="gh-plus">+{added}</span> <span className="gh-minus">−{removed}</span>
        <span className="gh-bar">
          {Array.from({ length: 5 }, (_, k) => {
            const total = added + removed || 1;
            const greens = Math.round((added / total) * 5);
            return <i key={k} className={k < greens ? "a" : added + removed ? "d" : "n"} />;
          })}
        </span>
        {!before && <span className="tiny faint">new file</span>}
        {!after && <span className="tiny faint">deleted</span>}
      </div>
      <table className="gh-table">
        <tbody>
          {blocks.map((b, bi) =>
            b.type === "rows" ? (
              <Fragment key={bi}>{b.rows.map((r, ri) => line(r, `${bi}-${ri}`))}</Fragment>
            ) : expanded.has(b.id) ? (
              <Fragment key={bi}>{b.rows.map((r, ri) => line(r, `${bi}-${ri}`))}</Fragment>
            ) : (
              <tr key={bi} className="gh-gap" onClick={() => setExpanded(new Set([...expanded, b.id]))} title="Show unchanged lines">
                <td colSpan={3} className="gh-num"><ChevronsUpDown size={12} /></td>
                <td className="gh-line">{b.rows.length} unchanged line{b.rows.length === 1 ? "" : "s"}</td>
              </tr>
            ),
          )}
          {!rows.length && (
            <tr><td colSpan={4} className="gh-line" style={{ padding: 12 }}>No changes.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** "+12 −3" chip used in file lists. */
export function ChangeCount({ added, removed }: { added?: number | null; removed?: number | null }) {
  if (!added && !removed) return null;
  return (
    <span className="tiny mono nowrap">
      {added ? <span className="gh-plus">+{added}</span> : null}
      {added && removed ? " " : null}
      {removed ? <span className="gh-minus">−{removed}</span> : null}
    </span>
  );
}
