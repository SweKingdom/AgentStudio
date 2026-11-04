import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CloudDownload, Eye } from "lucide-react";
import { api, type Project } from "../lib/api";
import { t } from "../lib/i18n";
import { toast } from "../lib/toast";
import { Field } from "./Hint";
import { Modal } from "./ui";

interface Preview { total: number; byType: Record<string, number>; byState: Record<string, number>; byAssignee: Record<string, number>; byIteration: Record<string, number> }
interface Result { created: number; updated: number; done: number; questions: number; total: number }

const list = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const counts = (m: Record<string, number>, empty: string) =>
  Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k || empty} ${n}`).join(" · ");

/** Import a backlog that's already under way in Azure DevOps. Reads only: nothing in Azure DevOps changes. */
export function AdoImportModal({ p, onClose }: { p: Project; onClose: () => void }) {
  const qc = useQueryClient();
  const saved = p.settings.ado;
  const filter = p.settings.adoImport;
  const [orgUrl, setOrgUrl] = useState(saved?.orgUrl ?? "https://dev.azure.com/");
  const [adoProject, setAdoProject] = useState(saved?.project ?? "");
  const [areaPath, setAreaPath] = useState(filter?.areaPath ?? saved?.areaPath ?? "");
  const [iterationPath, setIterationPath] = useState(filter?.iterationPath ?? "");
  const [tags, setTags] = useState((filter?.tags ?? []).join(", "));
  const [mine, setMine] = useState((p.settings.workRule?.assignees ?? []).join(", "));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const body = () => ({
    config: { orgUrl: orgUrl.trim(), project: adoProject.trim(), areaPath: saved?.areaPath, iterationRoot: saved?.iterationRoot, stateMode: saved?.stateMode ?? "same" },
    filter: { areaPath: areaPath.trim(), iterationPath: iterationPath.trim(), tags: list(tags) },
  });
  const run = async (what: "preview" | "import") => {
    setBusy(true);
    try {
      if (what === "preview") setPreview(await api.post<Preview>(`/projects/${p.id}/ado/import/preview`, body()));
      else {
        const names = list(mine);
        const r = await api.post<Result>(`/projects/${p.id}/ado/import`, { ...body(), ...(names.length ? { rule: { ...(p.settings.workRule ?? {}), assignees: names } } : {}) });
        await Promise.all([qc.invalidateQueries({ queryKey: ["items", p.id] }), qc.invalidateQueries({ queryKey: ["project", p.key] })]);
        toast(t("Imported {n} item(s): {c} new, {u} updated, {d} already done", { n: r.total, c: r.created, u: r.updated, d: r.done }) + (r.questions ? ` · ${t("{q} question(s) about unclear stories", { q: r.questions })}` : ""));
        onClose();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("Import from Azure DevOps")}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" disabled={busy || !adoProject.trim()} onClick={() => run("preview")}><Eye size={13} /> {t("Preview")}</button>
          <button className="btn primary" disabled={busy || !adoProject.trim()} onClick={() => run("import")}><CloudDownload size={13} /> {t("Import")}</button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="small muted">{t("Brings in the epics, features, stories, tasks and bugs that are already in Azure DevOps, with their state, who they're assigned to, iteration and tags. Only reads: nothing in Azure DevOps changes. Importing again updates what was imported before. The token is AZURE_DEVOPS_PAT in .env.")}</div>
        <div className="grid g2" style={{ gap: 12 }}>
          <Field label={t("Organization URL")} help={t("https://dev.azure.com/ and your organization's name.")}><input className="input" value={orgUrl} onChange={(e) => setOrgUrl(e.target.value)} placeholder="https://dev.azure.com/org" /></Field>
          <Field label={t("Azure DevOps project")} help={t("The project the work items are in.")}><input className="input" value={adoProject} onChange={(e) => setAdoProject(e.target.value)} placeholder="Sirocco SAFe" /></Field>
          <Field label={t("Area path (optional)")} help={t("Only items under this area, e.g. Sirocco SAFe\\Team Capybaras.")}><input className="input" value={areaPath} onChange={(e) => setAreaPath(e.target.value)} /></Field>
          <Field label={t("Iteration path (optional)")} help={t("Only items in this iteration or under it, e.g. Sirocco SAFe\\2026-23.")}><input className="input" value={iterationPath} onChange={(e) => setIterationPath(e.target.value)} /></Field>
          <Field label={t("Tags (optional)")} help={t("Only items with these tags, separated by commas.")}><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Zephyr" /></Field>
          <Field label={t("AgentStudio builds what's assigned to (optional)")} help={t("Names as in Azure DevOps, separated by commas. Saved as AgentStudio's rule: it builds those items, and everyone else's stay theirs. Empty: AgentStudio builds everything not done.")}><input className="input" value={mine} onChange={(e) => setMine(e.target.value)} placeholder="Philip Oxelius" /></Field>
        </div>
        {preview && (
          <div className="card card-pad small col" style={{ gap: 4 }}>
            <div className="strong">{t("{n} item(s) would be imported", { n: preview.total })}</div>
            <div className="muted">{t("Types")}: {counts(preview.byType, "—")}</div>
            <div className="muted">{t("States")}: {counts(preview.byState, "—")}</div>
            <div className="muted">{t("Assigned to")}: {counts(preview.byAssignee, t("Unassigned"))}</div>
            <div className="muted">{t("Iterations")}: {counts(preview.byIteration, "—")}</div>
          </div>
        )}
        <div className="hint">{t("Imported stories are merged after review (a person merges each PR). Done items come in as delivered and are never rebuilt. Stories without acceptance criteria get a question instead of a guess.")}</div>
      </div>
    </Modal>
  );
}
