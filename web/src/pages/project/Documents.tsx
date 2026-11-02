import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookText, Download, FileText, Lightbulb, Pencil, Plus, Printer, Save } from "lucide-react";
import { api, storyAssetBase, type Doc, type DocMeta, type Project } from "../../lib/api";
import { DOC_KINDS } from "../../lib/constants";
import { ago } from "../../lib/format";
import { t } from "../../lib/i18n";
import { useAgentLookup } from "../../lib/queries";
import { toast } from "../../lib/toast";
import { AgentTag, Empty, Markdown } from "../../components/ui";

const ORDER = ["requirements_brief", "project_brief", "solution_design", "design_critique", "delivery_plan", "plan_review", "project_lessons", "user_manual", "technical_overview", "changelog", "release_notes"];
/** Selected when the project has no lessons document yet (it's created by the first lesson). */
const NEW_LESSONS = "lessons";

export default function Documents({ p }: { p: Project }) {
  const agent = useAgentLookup();
  const { data: docs } = useQuery({ queryKey: ["documents", p.id], queryFn: () => api.get<DocMeta[]>(`/projects/${p.id}/documents`) });
  const [sel, setSel] = useState<string | null>(null);
  const { data: doc } = useQuery({ queryKey: ["doc", sel], queryFn: () => api.get<Doc>(`/documents/${sel}`), enabled: !!sel && sel !== NEW_LESSONS });
  const general = (docs ?? []).filter((d) => !d.item_id).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const perTask = (docs ?? []).filter((d) => d.item_id);
  const lessonsOn = p.settings.lessons !== false;
  const noLessonsDoc = lessonsOn && !general.some((d) => d.kind === "project_lessons");
  useEffect(() => { if (!sel && docs) setSel(docs.length ? (general[0] ?? docs[0]).id : lessonsOn ? NEW_LESSONS : null); }, [docs]);
  if (docs && !docs.length && !lessonsOn) return <Empty icon={<BookText size={20} />} title="No documents yet">The analyst writes the project brief first; the technical writer keeps the user manual, technical overview and changelog current after every task.</Empty>;
  const Item = ({ id, label, version }: { id: string; label: string; version?: number }) => (
    <div className={`tree-item ${sel === id ? "on" : ""}`} onClick={() => setSel(id)} style={{ padding: "6px 10px" }}>
      <FileText size={13} /> <span className="ellipsis" style={{ flex: 1 }}>{label}</span> {version !== undefined && <span className="tiny faint">v{version}</span>}
    </div>
  );
  return (
    <div className="grid" style={{ gridTemplateColumns: "280px minmax(0, 1fr)", alignItems: "start" }}>
      <div className="card card-pad col" style={{ gap: 2, position: "sticky", top: 60 }}>
        <div className="label" style={{ padding: "0 4px 6px" }}>Living documents</div>
        {general.map((d) => <Item key={d.id} id={d.id} label={d.kind === "project_lessons" ? t(DOC_KINDS[d.kind]) : DOC_KINDS[d.kind] ?? d.title} version={d.version} />)}
        {noLessonsDoc && <Item id={NEW_LESSONS} label={t(DOC_KINDS.project_lessons)} />}
        {perTask.length > 0 && <div className="label" style={{ padding: "12px 4px 6px" }}>Per task</div>}
        {perTask.map((d) => <Item key={d.id} id={d.id} label={`${d.item_code} · ${d.kind === "test_report" ? "🦌 Test report" : d.title.replace(`${d.item_code} `, "")}`} version={d.version} />)}
      </div>
      <div className="card">
        {sel === NEW_LESSONS ? (
          <Lessons p={p} onSaved={(id) => setSel(id)} />
        ) : doc?.kind === "project_lessons" ? (
          <Lessons p={p} doc={doc} meta={<>{t("version")} {doc.version} · {t("updated")} {ago(doc.updated_at)}{doc.agent_id ? <> · <AgentTag agent={agent(doc.agent_id)} /></> : null}</>} />
        ) : doc ? (
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

/** The one document the product owner edits: a wrong lesson can be fixed before it spreads to later stories. */
function Lessons({ p, doc, meta, onSaved }: { p: Project; doc?: Doc; meta?: React.ReactNode; onSaved?: (id: string) => void }) {
  const qc = useQueryClient();
  const content = doc?.content ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(content); }, [content]);
  const save = async (next: string) => {
    setBusy(true);
    try {
      const saved = await api.put<Doc>(`/projects/${p.id}/lessons`, { content: next });
      qc.invalidateQueries({ queryKey: ["documents", p.id] });
      qc.invalidateQueries({ queryKey: ["doc", saved.id] });
      setEditing(false);
      setLine("");
      toast("Lessons saved");
      onSaved?.(saved.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    const text = line.trim().replace(/^[-*]\s+/, "");
    if (text) save(`${content.trim() ? `${content.trim()}\n` : ""}- ${text} (product owner)`);
  };
  return (
    <>
      <div className="card-head">
        <div>
          <div className="card-title">{t("Lessons learned")}</div>
          <div className="card-sub row" style={{ gap: 8 }}>{meta ?? t("What earlier stories were sent back for. The developer, QA and architect follow these on every later story.")}</div>
        </div>
        <div className="row">
          {doc && !editing && <a className="btn sm" href={`/api/documents/${doc.id}/download`} title="Download this document as a Markdown file"><Download size={13} /> .md</a>}
          {!editing && <button className="btn sm" onClick={() => { setDraft(content); setEditing(true); }}><Pencil size={13} /> {t("Edit")}</button>}
        </div>
      </div>
      <div style={{ padding: "22px 32px" }} className="col">
        {p.settings.lessons === false && <div className="small muted">{t("Lessons learned are turned off in this project's settings: agents don't see them and no new ones are written.")}</div>}
        {editing ? (
          <>
            <textarea className="textarea mono" style={{ minHeight: 260 }} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="small muted">{t("One lesson per line, at most 20 lines of 200 characters. The tag at the end says where it came from; lines you write get (product owner) and are never removed automatically.")}</div>
            <div className="row">
              <button className="btn primary sm" disabled={busy} onClick={() => save(draft)}><Save size={13} /> {t("Save")}</button>
              <button className="btn sm" disabled={busy} onClick={() => setEditing(false)}>{t("Cancel")}</button>
            </div>
          </>
        ) : content.trim() ? (
          <Markdown>{content}</Markdown>
        ) : (
          <Empty icon={<Lightbulb size={20} />} title={t("No lessons yet")}>{t("They are added when a story is approved after rework, or you can add one.")}</Empty>
        )}
        {!editing && (
          <div className="row" style={{ marginTop: 8 }}>
            <input className="input" style={{ flex: 1 }} maxLength={200} placeholder={t("A rule later stories should follow, e.g. Validation errors return 400, never 500.")} value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
            <button className="btn sm" disabled={busy || !line.trim()} onClick={add}><Plus size={13} /> {t("Add lesson")}</button>
          </div>
        )}
      </div>
    </>
  );
}
