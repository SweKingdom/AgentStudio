import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookText, Download, FileText, Printer } from "lucide-react";
import { api, storyAssetBase, type Doc, type DocMeta, type Project } from "../../lib/api";
import { DOC_KINDS } from "../../lib/constants";
import { ago } from "../../lib/format";
import { useAgentLookup } from "../../lib/queries";
import { AgentTag, Empty, Markdown } from "../../components/ui";

const ORDER = ["project_brief", "solution_design", "delivery_plan", "user_manual", "technical_overview", "changelog", "release_notes"];

export default function Documents({ p }: { p: Project }) {
  const agent = useAgentLookup();
  const { data: docs } = useQuery({ queryKey: ["documents", p.id], queryFn: () => api.get<DocMeta[]>(`/projects/${p.id}/documents`) });
  const [sel, setSel] = useState<string | null>(null);
  const { data: doc } = useQuery({ queryKey: ["doc", sel], queryFn: () => api.get<Doc>(`/documents/${sel}`), enabled: !!sel });
  const general = (docs ?? []).filter((d) => !d.item_id).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const perTask = (docs ?? []).filter((d) => d.item_id);
  useEffect(() => { if (!sel && docs?.length) setSel((general[0] ?? docs[0]).id); }, [docs]);
  if (docs && !docs.length) return <Empty icon={<BookText size={20} />} title="No documents yet">The analyst writes the project brief first; the technical writer keeps the user manual, technical overview and changelog current after every task.</Empty>;
  const Item = ({ d, label }: { d: DocMeta; label: string }) => (
    <div className={`tree-item ${sel === d.id ? "on" : ""}`} onClick={() => setSel(d.id)} style={{ padding: "6px 10px" }}>
      <FileText size={13} /> <span className="ellipsis" style={{ flex: 1 }}>{label}</span> <span className="tiny faint">v{d.version}</span>
    </div>
  );
  return (
    <div className="grid" style={{ gridTemplateColumns: "280px minmax(0, 1fr)", alignItems: "start" }}>
      <div className="card card-pad col" style={{ gap: 2, position: "sticky", top: 60 }}>
        <div className="label" style={{ padding: "0 4px 6px" }}>Living documents</div>
        {general.map((d) => <Item key={d.id} d={d} label={DOC_KINDS[d.kind] ?? d.title} />)}
        {perTask.length > 0 && <div className="label" style={{ padding: "12px 4px 6px" }}>Per task</div>}
        {perTask.map((d) => <Item key={d.id} d={d} label={`${d.item_code} · ${d.kind === "test_report" ? "🦌 Test report" : d.title.replace(`${d.item_code} `, "")}`} />)}
      </div>
      <div className="card">
        {doc ? (
          <>
            <div className="card-head">
              <div>
                <div className="card-title">{doc.title}</div>
                <div className="card-sub row" style={{ gap: 8 }}>{DOC_KINDS[doc.kind]} · version {doc.version} · updated {ago(doc.updated_at)} by <AgentTag agent={agent(doc.agent_id)} /></div>
              </div>
              <div className="row">
                <a className="btn sm" href={`/api/documents/${doc.id}/download`} title="Download this document as a Markdown file"><Download size={13} /> .md</a>
                <a className="btn sm" href={`/print/${p.key}?doc=${doc.id}&auto=1`} target="_blank" rel="noreferrer" title="Open a print-ready version — choose Save as PDF"><Printer size={13} /> PDF</a>
              </div>
            </div>
            <div style={{ padding: "22px 32px" }}><Markdown assetBase={docs?.find((d) => d.id === doc.id)?.item_code ? storyAssetBase(p.id, docs!.find((d) => d.id === doc.id)!.item_code!) : undefined}>{doc.content}</Markdown></div>
          </>
        ) : <div className="empty small">Select a document.</div>}
      </div>
    </div>
  );
}
