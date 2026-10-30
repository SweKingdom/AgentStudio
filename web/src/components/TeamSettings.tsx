import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, FileUp, Info, Loader2, RefreshCw, Save, Stethoscope, Upload, Users, XCircle } from "lucide-react";
import { Plus, Trash2 } from "lucide-react";
import { api, type ChecksSettings } from "../lib/api";
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
interface TeamResponse { conventions: Conventions; checks: ChecksSettings; defaults: { conventions: Conventions; checks: ChecksSettings } }

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

/** Is this machine ready? Quick local checks on open; the full check also contacts GitHub and Claude. */
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
          <div className="card-sub">Is this computer ready to run AgentStudio — and live work? Read-only and free. Also available as <code className="code-tag">npm run doctor</code>.</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {data && <span className="small" style={{ color: fails ? "var(--bad)" : warns ? "var(--warn)" : "var(--good)" }}>{fails ? `${fails} problem(s)` : "Ready"}{warns ? ` · ${warns} warning(s)` : ""}</span>}
          <button className="btn sm" disabled={isFetching} onClick={() => (network ? refetch() : setNetwork(true))} title="Also checks GitHub access and access to each agent's Claude model">
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

// ---------------------------------------------------------------- conventions + checks

export function TeamConventions() {
  const qc = useQueryClient();
  const { data } = useTeam();
  const [c, setC] = useState<Conventions | null>(null);
  const [checks, setChecks] = useState<ChecksSettings | null>(null);
  useEffect(() => {
    if (data && !c) {
      setC(data.conventions);
      setChecks(data.checks);
    }
  }, [data]);
  const save = useMutation({
    mutationFn: () => api.put("/team", { conventions: c, checks }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["team"] }); toast("Team conventions saved"); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  if (!c || !checks || !data) return null;
  const set = (p: Partial<Conventions>) => setC({ ...c, ...p });
  const dirty = JSON.stringify(c) !== JSON.stringify(data.conventions) || JSON.stringify(checks) !== JSON.stringify(data.checks);
  const example = { code: "US-103", slug: "export-orders", type: "story", title: "export-orders", stage: "development", summary: "Order export with tests", branch: fill(c.branchPattern, { code: "US-103", slug: "export-orders", type: "story" }) };
  const reset = () => { setC(data.defaults.conventions); setChecks(data.defaults.checks); };
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
            <Field label="Azure DevOps area path" help="Adds Area Path and Iteration Path columns to the Azure DevOps import CSV, e.g. MyProject\Web. Empty = leave them out.">
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
            <div className="card-title">Checks</div>
            <div className="card-sub">Commands every story must pass before hand-over, approval and release (Project settings can override them). Empty: detected from each repository's package.json (typecheck, lint, test, build).</div>
          </div>
          <button className="btn sm primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Save size={13} /> Save</button>
        </div>
        <div className="card-pad col" style={{ gap: 12 }}>
          <ChecksFields value={checks} onChange={(v) => setChecks({ ...checks, ...v } as ChecksSettings)} />
        </div>
      </div>
    </>
  );
}

/** Shared by the team defaults and the project overrides (where an empty list means "the team's checks"). */
export function ChecksFields({ value, onChange, placeholder }: { value: Partial<ChecksSettings>; onChange: (v: Partial<ChecksSettings>) => void; placeholder?: string }) {
  const commands = value.commands ?? [];
  const setCommand = (i: number, p: Partial<{ name: string; command: string }>) => onChange({ ...value, commands: commands.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  return (
    <>
      {commands.length === 0 && <div className="small muted">{placeholder ?? "No checks set — detected from package.json."}</div>}
      {commands.map((c, i) => (
        <div key={i} className="row" style={{ gap: 8 }}>
          <input className="input" style={{ width: 140 }} value={c.name} placeholder="Name" aria-label="Check name" onChange={(e) => setCommand(i, { name: e.target.value })} />
          <input className="input mono" style={{ flex: 1 }} value={c.command} placeholder="npm test" aria-label="Command" onChange={(e) => setCommand(i, { command: e.target.value })} />
          <button type="button" className="btn icon ghost" aria-label={`Remove ${c.name || "check"}`} onClick={() => onChange({ ...value, commands: commands.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
        </div>
      ))}
      <div className="row" style={{ gap: 12, justifyContent: "space-between" }}>
        <button type="button" className="btn sm ghost" disabled={commands.length >= 10} onClick={() => onChange({ ...value, commands: [...commands, { name: "", command: "" }] })}><Plus size={13} /> Add check</button>
        <Field label="Timeout per check (minutes)" help="A check that runs longer is stopped and counts as failed.">
          <input className="input" type="number" min={1} max={120} style={{ width: 100 }} value={value.timeoutMinutes ?? ""} placeholder="15" onChange={(e) => onChange({ ...value, timeoutMinutes: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </Field>
      </div>
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
  const [name, setName] = useState("AgentStudio delivery team");
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
          <div className="card-sub">Take this team to another computer, or share it: agents (prompts, models, effort, tools, knowledge), custom knowledge packs, conventions, checks and prices. Never included: API keys, logins, git credentials, spend limits.</div>
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
