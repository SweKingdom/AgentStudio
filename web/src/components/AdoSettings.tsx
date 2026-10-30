import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, Loader2, Plug, RefreshCw, XCircle } from "lucide-react";
import { api, type AdoConfig, type Project } from "../lib/api";
import { ago, dateTime } from "../lib/format";
import { toast } from "../lib/toast";
import { Field, Hint } from "./Hint";
import { Seg } from "./ui";

/** Form state: every field a string so inputs stay controlled. */
export interface AdoValue { orgUrl: string; project: string; areaPath: string; iterationRoot: string; stateMode: AdoConfig["stateMode"] }

interface AdoSyncSummary {
  at: string; ok: boolean; total: number; created: number; updated: number; recreated: number; failed: number;
  errors: { code: string; error: string }[]; warnings: { code: string; message: string }[];
  stateFallbacks: { code: string; state: string; sent: string }[]; durationMs: number; error?: string;
}
interface AdoStatus { configured: boolean; config: AdoConfig | null; tokenPresent: boolean; running: boolean; lastSync: AdoSyncSummary | null }
interface AdoTestResult { ok: boolean; project?: string; process?: string | null; error?: string }

export function adoFormValue(cfg?: AdoConfig | null): AdoValue {
  return { orgUrl: cfg?.orgUrl ?? "", project: cfg?.project ?? "", areaPath: cfg?.areaPath ?? "", iterationRoot: cfg?.iterationRoot ?? "", stateMode: cfg?.stateMode ?? "same" };
}

/** What the project PATCH stores: null switches the sync off (both URL and project empty). */
export function adoSettingsOf(v: AdoValue): AdoConfig | null {
  if (!v.orgUrl.trim() && !v.project.trim()) return null;
  return { orgUrl: v.orgUrl.trim(), project: v.project.trim(), areaPath: v.areaPath.trim() || undefined, iterationRoot: v.iterationRoot.trim() || undefined, stateMode: v.stateMode };
}

/** Same rules as the server: https only, no credentials in the URL, both fields or neither. */
export function adoConfigError(v: AdoValue): string | null {
  const url = v.orgUrl.trim();
  const project = v.project.trim();
  if (!url && !project) return null;
  if (!url) return "Enter the organization URL, e.g. https://dev.azure.com/your-org";
  if (!project) return "Enter the Azure DevOps project name.";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "The organization URL must look like https://dev.azure.com/your-org";
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return "The organization URL must use https://";
  if (u.username || u.password) return "Don't put a user or token in the URL — the token goes in .env as AZURE_DEVOPS_PAT.";
  return null;
}

const configured = (p: Project) => !!(p.settings.ado?.orgUrl && p.settings.ado?.project);

function useAdoStatus(projectId: string, enabled = true) {
  return useQuery({ queryKey: ["ado-status", projectId], queryFn: () => api.get<AdoStatus>(`/projects/${projectId}/ado/status`), enabled });
}

/** Project settings section: where the backlog syncs to in Azure DevOps. Controlled — the parent saves it with the project. */
export function AdoSettings({ projectId, value, onChange }: { projectId: string; value: AdoValue; onChange: (v: AdoValue) => void }) {
  const { data: status } = useAdoStatus(projectId);
  const err = adoConfigError(value);
  const set = (patch: Partial<AdoValue>) => onChange({ ...value, ...patch });
  const [r, setR] = useState<AdoTestResult | null>(null);
  const test = useMutation({
    mutationFn: () => api.post<AdoTestResult>(`/projects/${projectId}/ado/test`, { config: adoSettingsOf(value) }),
    onSuccess: setR,
    onError: (e: Error) => setR({ ok: false, error: e.message }),
  });
  const filled = !!(value.orgUrl.trim() && value.project.trim());
  return (
    <div className="col ado-settings" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="strong small">Azure DevOps</span>
        <span className="tiny muted">Optional. Sync the backlog to Azure Boards as Epics, Features, User Stories, Tasks and Bugs.</span>
      </div>
      <div className="grid g2" style={{ gap: 12 }}>
        <Field label="Organization URL" help="Your Azure DevOps organization, e.g. https://dev.azure.com/your-org. Leave this and the project empty to switch the sync off." hint={err ? <span style={{ color: "var(--bad)" }}>{err}</span> : undefined}>
          <input className="input mono" style={err ? { borderColor: "var(--bad)" } : undefined} value={value.orgUrl} onChange={(e) => { set({ orgUrl: e.target.value }); setR(null); }} placeholder="https://dev.azure.com/your-org" spellCheck={false} />
        </Field>
        <Field label="Azure DevOps project" help="The project name exactly as it appears in Azure DevOps. Work items are created there.">
          <input className="input" value={value.project} onChange={(e) => { set({ project: e.target.value }); setR(null); }} placeholder="Project name" spellCheck={false} />
        </Field>
        <Field label="Area path" help="Optional. Area every work item goes to, e.g. Project\Team. Empty: the project's default area.">
          <input className="input mono" value={value.areaPath} onChange={(e) => set({ areaPath: e.target.value })} placeholder="Project\Team" spellCheck={false} />
        </Field>
        <Field label="Iteration root" help="Optional. Sprint iterations live under it: an item in sprint 2 goes to <root>\<iteration prefix>2 (prefix from Settings → Team conventions); items without a sprint go to the root itself. The iterations must already exist in Azure DevOps.">
          <input className="input mono" value={value.iterationRoot} onChange={(e) => set({ iterationRoot: e.target.value })} placeholder="Project\Release 1" spellCheck={false} />
        </Field>
      </div>
      <Field label="States" help="Same names: send AgentStudio's states as they are — for a process that uses the same states (Ready for Sprint, In Peer Testing…). Agile mapping: New / Active / Resolved / Closed / Removed, Blocked becomes Active with a Blocked tag. If Azure DevOps refuses a state name, that item is sent with the Agile mapping and the sync reports it.">
        <Seg value={value.stateMode} onChange={(v) => set({ stateMode: v })} options={[{ value: "same", label: "Same names" }, { value: "agile", label: "Agile mapping" }]} />
      </Field>
      <div className="row wrap" style={{ gap: 10, alignItems: "flex-start" }}>
        <Hint text="Reads the Azure DevOps project with the token from .env. Nothing is created or changed.">
          <button type="button" className="btn sm" disabled={!filled || !!err || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? <Loader2 size={13} className="spin" /> : <Plug size={13} />} Test connection
          </button>
        </Hint>
        {r && (
          <div className="small" style={{ lineHeight: 1.45, minWidth: 0, flex: 1, color: r.ok ? "var(--good)" : "var(--bad)" }} role="status">
            {r.ok ? (
              <span className="row" style={{ gap: 5 }}><CheckCircle2 size={13} /> Connected to {r.project}{r.process ? ` · ${r.process} process` : ""}</span>
            ) : (
              <span className="row" style={{ gap: 5, alignItems: "flex-start" }}><XCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} /> {r.error}</span>
            )}
          </div>
        )}
      </div>
      <div className="ado-token-note tiny">
        <KeyRound size={12} />
        <span>
          The Personal Access Token is never stored by AgentStudio. Put it in <code className="code-tag">.env</code> as <code className="code-tag">AZURE_DEVOPS_PAT=…</code> (scope: Work Items read &amp; write) and restart.
          {status && (status.tokenPresent ? <b style={{ color: "var(--good)" }}> Token found.</b> : <b style={{ color: "var(--warn)" }}> No token yet.</b>)}
        </span>
      </div>
    </div>
  );
}

function summaryText(s: AdoSyncSummary) {
  const parts = [`${s.created} created`, `${s.updated} updated`];
  if (s.failed) parts.push(`${s.failed} failed`);
  if (s.stateFallbacks.length) parts.push(`${s.stateFallbacks.length} sent with Agile states`);
  return parts.join(", ");
}

/** "Sync to Azure DevOps" for the Backlog header. Renders nothing unless the project has Azure DevOps configured. */
export function AdoSyncButton({ p }: { p: Project }) {
  const qc = useQueryClient();
  const on = configured(p);
  const { data: status } = useAdoStatus(p.id, on);
  const sync = useMutation({
    mutationFn: () => api.post<AdoSyncSummary>(`/projects/${p.id}/ado/sync`),
    onSuccess: (s) => {
      const first = s.errors[0] ? ` — ${s.errors[0].code}: ${s.errors[0].error}` : "";
      toast(`Azure DevOps: ${summaryText(s)}${first}`, s.failed ? "bad" : "info");
      qc.invalidateQueries({ queryKey: ["ado-status", p.id] });
      qc.invalidateQueries({ queryKey: ["items", p.id] });
      qc.invalidateQueries({ queryKey: ["item"] });
    },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  if (!on) return null;
  const last = status?.lastSync;
  const busy = sync.isPending || status?.running;
  const help = !status?.tokenPresent
    ? "Add AZURE_DEVOPS_PAT=… to .env and restart to enable the sync. The token is never stored by AgentStudio."
    : `Creates or updates every epic, feature, story, task and bug in ${p.settings.ado!.project}. Parents first; items deleted in Azure DevOps are created again.${last ? ` Last sync ${dateTime(last.at)}: ${summaryText(last)}.` : ""}`;
  return (
    <div className="row ado-sync" style={{ gap: 6 }}>
      {last && (
        <span className={`tiny ${last.ok ? "muted" : ""}`} style={last.ok ? undefined : { color: "var(--warn)" }} title={last.errors.map((e) => `${e.code}: ${e.error}`).join("\n") || undefined}>
          {!last.ok && <AlertTriangle size={11} style={{ verticalAlign: -1, marginRight: 3 }} />}synced {ago(last.at)}
        </span>
      )}
      <Hint text={help}>
        <button className="btn sm" disabled={busy || !status?.tokenPresent} onClick={() => sync.mutate()}>
          {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Sync to Azure DevOps
        </button>
      </Hint>
    </div>
  );
}

/** "ADO #1234" chip linking to the work item in Azure DevOps (item drawer). */
export function AdoChip({ project, adoId }: { project: Project; adoId?: number | null }) {
  const cfg = project.settings.ado;
  if (!adoId || !cfg?.orgUrl || !cfg.project) return null;
  const href = `${cfg.orgUrl.replace(/\/+$/, "")}/${encodeURIComponent(cfg.project)}/_workitems/edit/${adoId}`;
  return (
    <a className="chip mono ado-chip" href={href} target="_blank" rel="noreferrer" title="Open this work item in Azure DevOps">
      ADO #{adoId} <ExternalLink size={10} />
    </a>
  );
}
