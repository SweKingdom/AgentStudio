import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, FileUp, Info, Loader2, RefreshCw, Save, Stethoscope, Upload, Users, XCircle } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { Field } from "./Hint";
import { Modal, Seg } from "./ui";

// ---------------------------------------------------------------- types

export interface Conventions {
  language: string;
  branchPattern: string;
  bugBranchPattern: string;
  commitPattern: string;
  mergePattern: string;
  prTemplate: string;
  reviewChecklist: string;
  ado: { areaPath: string; iterationPrefix: string; tags: string };
}
export interface SalesforceSettings { apiVersion: string; coverageMin: number; namespace: string; prefix: string; devTestLevel: "RunSpecifiedTests" | "RunLocalTests" }
interface TeamResponse { conventions: Conventions; salesforce: SalesforceSettings; defaults: { conventions: Conventions; salesforce: SalesforceSettings } }

export const useTeam = () => useQuery({ queryKey: ["team"], queryFn: () => api.get<TeamResponse>("/team") });

const fill = (p: string, v: Record<string, string>) => p.replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m);

// ---------------------------------------------------------------- system check

interface Check { id: string; group: string; label: string; status: "ok" | "warn" | "fail" | "info"; detail: string; fix?: string }
const ICON = {
  ok: <CheckCircle2 size={14} color="var(--good)" />,
  warn: <AlertTriangle size={14} color="var(--warn)" />,
  fail: <XCircle size={14} color="var(--bad)" />,
  info: <Info size={14} color="var(--muted)" />,
};

/** Is this machine ready? Quick local checks on open; the full check also contacts GitHub, each org and Claude. */
export function SystemCheck() {
  const [network, setNetwork] = useState(false);
  const { data, isFetching, refetch } = useQuery({ queryKey: ["system-check", network], queryFn: () => api.get<Check[]>(`/system/check${network ? "?network=1" : ""}`), staleTime: Infinity });
  const groups = [...new Set((data ?? []).map((c) => c.group))];
  const fails = data?.filter((c) => c.status === "fail").length ?? 0;
  const warns = data?.filter((c) => c.status === "warn").length ?? 0;
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title"><Stethoscope size={15} /> System check</div>
          <div className="card-sub">Is this computer ready to run SiroccoARM — and live work? Read-only and free. Also available as <code className="code-tag">npm run doctor</code>.</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {data && <span className="small" style={{ color: fails ? "var(--bad)" : warns ? "var(--warn)" : "var(--good)" }}>{fails ? `${fails} problem(s)` : "Ready"}{warns ? ` · ${warns} warning(s)` : ""}</span>}
          <button className="btn sm" disabled={isFetching} onClick={() => (network ? refetch() : setNetwork(true))} title="Also checks GitHub access, every registered org and access to each agent's Claude model">
            {isFetching ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} {network ? "Run again" : "Full check (GitHub, orgs, models)"}
          </button>
        </div>
      </div>
      <div className="card-pad col" style={{ gap: 12 }}>
        {!data && <div className="small muted"><Loader2 size={13} className="spin" /> Checking…</div>}
        {groups.map((g) => (
          <div key={g}>
            <div className="tiny faint" style={{ textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{g}</div>
            {data!.filter((c) => c.group === g).map((c) => (
              <div key={c.id} className="row small" style={{ gap: 8, alignItems: "flex-start", padding: "4px 0" }}>
                <span style={{ marginTop: 1 }}>{ICON[c.status]}</span>
                <span className="strong" style={{ minWidth: 200 }}>{c.label}</span>
                <span className="col" style={{ gap: 2, minWidth: 0 }}>
                  <span className="muted" style={{ wordBreak: "break-word" }}>{c.detail}</span>
                  {c.fix && c.status !== "ok" && <span style={{ color: c.status === "fail" ? "var(--bad)" : "var(--warn)" }}>→ {c.fix}</span>}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- conventions + Salesforce defaults

export function TeamConventions() {
  const qc = useQueryClient();
  const { data } = useTeam();
  const [c, setC] = useState<Conventions | null>(null);
  const [sf, setSf] = useState<SalesforceSettings | null>(null);
  useEffect(() => {
    if (data && !c) {
      setC(data.conventions);
      setSf(data.salesforce);
    }
  }, [data]);
  const save = useMutation({
    mutationFn: () => api.put("/team", { conventions: c, salesforce: sf }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["team"] }); toast("Team conventions saved"); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  if (!c || !sf || !data) return null;
  const set = (p: Partial<Conventions>) => setC({ ...c, ...p });
  const dirty = JSON.stringify(c) !== JSON.stringify(data.conventions) || JSON.stringify(sf) !== JSON.stringify(data.salesforce);
  const example = { code: "US-103", slug: "email-to-case", type: "story", title: "email-to-case", stage: "development", summary: "Case service with tests", branch: fill(c.branchPattern, { code: "US-103", slug: "email-to-case", type: "story" }) };
  const reset = () => { setC(data.defaults.conventions); setSf(data.defaults.salesforce); };
  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title"><Users size={15} /> Team conventions</div>
            <div className="card-sub">How the team works — every agent follows these. They travel with the team export.</div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm ghost" onClick={reset}>Restore defaults</button>
            <button className="btn sm primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Save size={13} /> Save</button>
          </div>
        </div>
        <div className="card-pad col" style={{ gap: 12 }}>
          <div className="grid g3" style={{ gap: 12 }}>
            <Field label="Deliverables language" help="Agents write documents, work items, code comments and release notes in this language.">
              <input className="input" value={c.language} onChange={(e) => set({ language: e.target.value })} />
            </Field>
            <Field label="Task branch" help="Placeholders: {code} {slug} {type}. Must contain {code}." hint={<span className="mono tiny ellipsis" style={{ display: "block", maxWidth: "100%" }}>{fill(c.branchPattern, example)}</span>}>
              <input className="input mono" value={c.branchPattern} onChange={(e) => set({ branchPattern: e.target.value })} />
            </Field>
            <Field label="Bug branch" help="Branch name for bugs. Placeholders: {code} {slug}." hint={<span className="mono tiny ellipsis" style={{ display: "block", maxWidth: "100%" }}>{fill(c.bugBranchPattern, { ...example, code: "BG-120", slug: "fix-routing" })}</span>}>
              <input className="input mono" value={c.bugBranchPattern} onChange={(e) => set({ bugBranchPattern: e.target.value })} />
            </Field>
            <Field label="Commit message" help="One commit per agent run. Placeholders: {code} {stage} {summary} {agent}." hint={<span className="mono tiny ellipsis" style={{ display: "block", maxWidth: "100%" }}>{fill(c.commitPattern, { ...example, agent: "Trasgu" })}</span>}>
              <input className="input mono" value={c.commitPattern} onChange={(e) => set({ commitPattern: e.target.value })} />
            </Field>
            <Field label="Merge commit" help="When a finished task is merged into the default branch. Placeholders: {branch} {code} {title}." hint={<span className="mono tiny ellipsis" style={{ display: "block", maxWidth: "100%" }}>{fill(c.mergePattern, { ...example, title: "Email to case" })}</span>}>
              <input className="input mono" value={c.mergePattern} onChange={(e) => set({ mergePattern: e.target.value })} />
            </Field>
            <Field label="Azure DevOps area path" help="Adds Area Path and Iteration Path columns to the Azure DevOps import CSV, e.g. MyProject\Service Cloud. Empty = leave them out.">
              <input className="input mono" value={c.ado.areaPath} onChange={(e) => set({ ado: { ...c.ado, areaPath: e.target.value } })} placeholder="Project\Team" />
            </Field>
            <Field label="Iteration name" help="Prefix for sprints in the Iteration Path: 'Sprint ' → Project\Sprint 1.">
              <input className="input" value={c.ado.iterationPrefix} onChange={(e) => set({ ado: { ...c.ado, iterationPrefix: e.target.value } })} />
            </Field>
            <Field label="Extra Azure DevOps tags" help="Added to every imported work item (separate with ; or ,).">
              <input className="input" value={c.ado.tags} onChange={(e) => set({ ado: { ...c.ado, tags: e.target.value } })} />
            </Field>
          </div>
          <div className="grid g2" style={{ gap: 12 }}>
            <Field label="Pull request description" help="Written into each merge commit, filled from the story. Placeholders: {code} {title} {summary} {components} {tests} {how_to_test} {branch}.">
              <textarea className="input mono" rows={9} value={c.prTemplate} onChange={(e) => set({ prTemplate: e.target.value })} />
            </Field>
            <Field label="Code review checklist" help="QA checks every story against this list, and the developer gets it up front so it's right first time (fewer rework loops, fewer tokens).">
              <textarea className="input" rows={9} value={c.reviewChecklist} onChange={(e) => set({ reviewChecklist: e.target.value })} />
            </Field>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Salesforce defaults</div>
            <div className="card-sub">For every project unless the project overrides them (Project settings → Salesforce).</div>
          </div>
          <button className="btn sm primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Save size={13} /> Save</button>
        </div>
        <div className="card-pad grid g3" style={{ gap: 12 }}>
          <SalesforceFields value={sf} onChange={setSf} />
        </div>
      </div>
    </>
  );
}

/** Shared by the team defaults and the project overrides (where empty means "team default"). */
export function SalesforceFields({ value, onChange, placeholders }: { value: Partial<SalesforceSettings>; onChange: (v: SalesforceSettings) => void; placeholders?: SalesforceSettings }) {
  const set = (p: Partial<SalesforceSettings>) => onChange({ ...value, ...p } as SalesforceSettings);
  return (
    <>
      <Field label="API version" help="sourceApiVersion in sfdx-project.json, package.xml and every -meta.xml the agents write. Match your orgs (e.g. 62.0).">
        <input className="input mono" value={value.apiVersion ?? ""} placeholder={placeholders?.apiVersion} onChange={(e) => set({ apiVersion: e.target.value })} />
      </Field>
      <Field label="Min. coverage %" help="Every Apex class a story changes must reach this coverage in the org's test run — QA can't approve below it.">
        <input className="input" type="number" min={0} max={100} value={value.coverageMin ?? ""} placeholder={placeholders ? String(placeholders.coverageMin) : undefined} onChange={(e) => set({ coverageMin: e.target.value === "" ? (undefined as unknown as number) : Number(e.target.value) })} />
      </Field>
      <Field label="Name prefix" help="New custom objects, fields, classes and components start with it, e.g. SRC_. Empty = none.">
        <input className="input mono" value={value.prefix ?? ""} placeholder={placeholders?.prefix || "none"} onChange={(e) => set({ prefix: e.target.value })} />
      </Field>
      <Field label="Namespace" help="Only for managed-package development. Goes into sfdx-project.json.">
        <input className="input mono" value={value.namespace ?? ""} placeholder={placeholders?.namespace || "none"} onChange={(e) => set({ namespace: e.target.value })} />
      </Field>
      <Field label="Tests when validating a story" help="Specified: only the story's test classes (fast, cheap). Local: every local test in the org (slower, catches regressions).">
        <Seg value={value.devTestLevel ?? placeholders?.devTestLevel ?? "RunSpecifiedTests"} onChange={(v) => set({ devTestLevel: v })} options={[{ value: "RunSpecifiedTests", label: "Story tests" }, { value: "RunLocalTests", label: "All local" }]} />
      </Field>
    </>
  );
}

// ---------------------------------------------------------------- team template (export / import)

interface ImportPlan {
  agents: { name: string; role: string; action: "create" | "update" | "unchanged" | "skip"; changes: string[] }[];
  knowledge: { id: string; title: string; action: "create" | "update" }[];
  settings: string[];
  warnings: string[];
}

export function TeamTemplate() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("Sirocco Salesforce delivery team");
  const [pending, setPending] = useState<{ template: unknown; plan: ImportPlan; file: string } | null>(null);
  const preview = useMutation({
    mutationFn: async (f: File) => {
      const template = JSON.parse(await f.text());
      const plan = await api.post<ImportPlan>("/team/import/preview", { template });
      return { template, plan, file: f.name };
    },
    onSuccess: setPending,
    onError: (e: Error) => toast(e instanceof SyntaxError ? "That file isn't valid JSON." : e.message, "bad"),
  });
  const apply = useMutation({
    mutationFn: () => api.post<ImportPlan>("/team/import", { template: pending!.template }),
    onSuccess: () => { qc.invalidateQueries(); toast("Team imported — changed agents got a new version (restorable from their history)"); setPending(null); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title"><Download size={15} /> Export &amp; import the team</div>
          <div className="card-sub">Take this team to another computer, or share it: agents (prompts, models, effort, tools, knowledge), custom knowledge packs, conventions, Salesforce defaults and prices. Never included: API keys, org aliases and logins, git credentials, spend limits.</div>
        </div>
      </div>
      <div className="card-pad row wrap" style={{ gap: 10, alignItems: "flex-end" }}>
        <Field label="Template name" help="Stored in the file and shown when it's imported." style={{ flex: 1, minWidth: 220 }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <a className="btn primary" href={`/api/team/export?name=${encodeURIComponent(name)}`} download><Download size={14} /> Export team</a>
        <button className="btn" disabled={preview.isPending} onClick={() => fileRef.current?.click()}>{preview.isPending ? <Loader2 size={14} className="spin" /> : <FileUp size={14} />} Import team…</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) preview.mutate(f); e.target.value = ""; }} />
      </div>
      {pending && (
        <Modal
          onClose={() => setPending(null)}
          title={`Import ${pending.file}?`}
          footer={<><button className="btn ghost" onClick={() => setPending(null)}>Cancel</button><button className="btn primary" disabled={apply.isPending} onClick={() => apply.mutate()}><Upload size={14} /> Import</button></>}
        >
          <div className="col small" style={{ gap: 10 }}>
            <div>Nothing changes until you click Import. Agents are matched by role and name; updated agents get a new version you can restore.</div>
            <table className="table">
              <tbody>
                {pending.plan.agents.map((a) => (
                  <tr key={a.role + a.name}>
                    <td className="strong">{a.name}</td>
                    <td className="muted">{a.role}</td>
                    <td style={{ color: a.action === "create" ? "var(--good)" : a.action === "update" ? "var(--warn)" : "var(--muted)" }}>{a.action === "create" ? "New agent" : a.action === "update" ? `Update: ${a.changes.join(", ")}` : a.action === "skip" ? "Skipped — not on this team" : "No changes"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pending.plan.knowledge.length > 0 && <div>Knowledge packs: {pending.plan.knowledge.map((k) => `${k.title} (${k.action === "create" ? "new" : "update"})`).join(", ")}</div>}
            {pending.plan.settings.length > 0 && <div>Also replaces: {pending.plan.settings.join(", ")}</div>}
            {pending.plan.warnings.map((w) => <div key={w} style={{ color: "var(--warn)" }}><AlertTriangle size={12} /> {w}</div>)}
          </div>
        </Modal>
      )}
    </div>
  );
}
