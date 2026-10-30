import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { Printer } from "lucide-react";
import siroccoLogo from "../assets/sirocco-logo.svg?raw";
import { api, storyAssetBase, type Doc } from "../lib/api";
import { DOC_KINDS } from "../lib/constants";
import { dateTime } from "../lib/format";
import { Markdown } from "../components/ui";

/** /print/:key            → all living documents of a project
 *  /print/:key?tasks=1    → plus every per-task document
 *  /print/:key?doc=<id>   → a single document
 *  &auto=1 opens the print dialog automatically (Save as PDF). */
export default function PrintView() {
  const loc = useLocation();
  const key = loc.pathname.split("/")[2];
  const q = new URLSearchParams(loc.search);
  const docId = q.get("doc");
  const { data: book } = useQuery({
    queryKey: ["print", key, q.get("tasks")],
    queryFn: () => api.get<{ project: { key: string; name: string; mode: string }; documents: (Doc & { item_code?: string | null })[] }>(`/projects/${key}/print${q.get("tasks") ? "?tasks=1" : ""}`),
    enabled: !docId,
  });
  const { data: single } = useQuery({ queryKey: ["doc", docId], queryFn: () => api.get<Doc>(`/documents/${docId}`), enabled: !!docId });
  const docs = docId ? (single ? [single] : []) : book?.documents ?? [];
  const ready = docId ? !!single : !!book;

  useEffect(() => {
    document.documentElement.dataset.theme = "light";
    document.title = docId ? single?.title ?? "Document" : `${book?.project.name ?? key} — documentation`;
    if (ready && q.get("auto")) setTimeout(() => window.print(), 400);
  }, [ready]);

  return (
    <div className="print-root">
      <div className="print-toolbar no-print">
        <span className="small muted">{docs.length} document(s) · use “Save as PDF” in the print dialog</span>
        <button className="btn primary" onClick={() => window.print()}><Printer size={14} /> Print / Save as PDF</button>
      </div>
      <header className="print-cover">
        <span className="print-logo" dangerouslySetInnerHTML={{ __html: siroccoLogo }} />
        <h1>{docId ? single?.title : book?.project.name}</h1>
        <div className="muted">{docId ? DOC_KINDS[single?.kind ?? ""] : "Project documentation"} · {key} · generated {dateTime(new Date().toISOString())}{book?.project.mode === "simulation" ? " · simulation" : ""}</div>
        {!docId && docs.length > 1 && (
          <ol className="print-toc">
            {docs.map((d) => <li key={d.id}><a href={`#${d.id}`}>{d.title}</a> <span className="muted">v{d.version}</span></li>)}
          </ol>
        )}
      </header>
      {docs.map((d) => (
        <section key={d.id} id={d.id} className="print-doc">
          <div className="print-meta muted">{DOC_KINDS[d.kind] ?? d.kind} · version {d.version} · updated {dateTime(d.updated_at)}</div>
          <Markdown assetBase={(d as Doc & { item_code?: string | null }).item_code ? storyAssetBase(key, (d as Doc & { item_code?: string | null }).item_code!) : undefined}>{d.content}</Markdown>
        </section>
      ))}
    </div>
  );
}
