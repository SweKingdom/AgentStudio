import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Cloud, Loader2, LogIn, Plug, Plus, Trash2, XCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, type OrgType, type SfOrg } from "../lib/api";
import { useOrgs } from "../lib/queries";
import { toast } from "../lib/toast";
import { Field, Hint } from "./Hint";
import { Modal, Switch } from "./ui";

export const ORG_TYPE: Record<OrgType | "unknown", { label: string; color: string }> = {
  sandbox: { label: "Sandbox", color: "#3987e5" },
  scratch: { label: "Scratch org", color: "#199e70" },
  developer: { label: "Developer Edition", color: "#9085e9" },
  production: { label: "Production", color: "#f06a48" },
  unknown: { label: "Not registered", color: "#929190" },
};

export function OrgBadge({ alias, type }: { alias: string; type: OrgType | "unknown" }) {
  const t = ORG_TYPE[type];
  return (
    <span className="chip" style={{ background: `color-mix(in srgb, ${t.color} 14%, transparent)`, color: t.color }}>
      <Cloud size={11} /> {alias} · {t.label}
    </span>
  );
}

interface OrgTestResult { ok: boolean; name?: string; orgType?: string; isSandbox?: boolean; instance?: string; trialExpires?: string | null; warning?: string | null; error?: string }

/** Test the Salesforce CLI's login for this alias (a read-only query of the org), and start the CLI's browser login
 *  when it isn't logged in. Works in any mode — you start it. */
export function OrgConnection({ alias, compact }: { alias: string; compact?: boolean }) {
  const [result, setResult] = useState<OrgTestResult | null>(null);
  const test = useMutation({
    mutationFn: () => api.post<OrgTestResult>(`/salesforce/orgs/${encodeURIComponent(alias)}/test`, {}),
    onSuccess: setResult,
    onError: (e: Error) => setResult({ ok: false, error: e.message }),
  });
  const login = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>(`/salesforce/orgs/${encodeURIComponent(alias)}/login`, {}),
    onSuccess: (r) => {
      if (r.ok) {
        toast(`Logged in to ${alias}`);
        test.mutate();
      } else toast(r.error ?? "Login didn't complete", "bad");
    },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const notLoggedIn = result && !result.ok && /authoriz|no auth|not found|expired|refresh token|NamedOrgNotFound|login/i.test(result.error ?? "");
  return (
    <div className="col" style={{ gap: 6, minWidth: 0 }}>
      <div className="row" style={{ gap: 6 }}>
        <Hint text={`Check that this computer's Salesforce CLI is logged in to ${alias}: runs a read-only query of the org's details. Nothing is changed and no credentials are read or stored.`}>
          <button type="button" className="btn sm" disabled={test.isPending || login.isPending} onClick={() => test.mutate()}>
            {test.isPending ? <Loader2 size={13} className="spin" /> : <Plug size={13} />} Test
          </button>
        </Hint>
        {(!compact || notLoggedIn) && (
          <Hint text={`Opens Salesforce's own login page in your browser (through the Salesforce CLI) to connect ${alias}. You sign in there; the CLI keeps the session — SiroccoARM never sees or stores your credentials.`}>
            <button type="button" className="btn sm ghost" disabled={login.isPending} onClick={() => login.mutate()}>
              {login.isPending ? <Loader2 size={13} className="spin" /> : <LogIn size={13} />} {login.isPending ? "Waiting for the browser login…" : "Log in"}
            </button>
          </Hint>
        )}
      </div>
      {result && (
        <div className="small fade-in" style={{ color: result.ok ? "var(--good)" : "var(--bad)", lineHeight: 1.4 }}>
          {result.ok ? (
            <span className="row" style={{ gap: 5, alignItems: "flex-start" }}>
              <CheckCircle2 size={13} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                Connected · <b>{result.name}</b> · {result.orgType}{result.isSandbox ? " (sandbox)" : ""}{result.instance ? ` · ${result.instance}` : ""}
                {result.warning && <span style={{ color: "var(--warn)", display: "block" }}>{result.warning}</span>}
              </span>
            </span>
          ) : (
            <span className="row" style={{ gap: 5, alignItems: "flex-start" }}>
              <XCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{result.error}{notLoggedIn ? " — use Log in to connect it." : ""}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Select a registered org. Production orgs that weren't explicitly allowed are listed but can't be chosen. */
export function OrgPicker({ value, onChange, emptyLabel = "No target org", onAdd }: { value: string | null | undefined; onChange: (alias: string | null) => void; emptyLabel?: string; onAdd?: () => void }) {
  const { data: orgs } = useOrgs();
  const [removing, setRemoving] = useState<string | null>(null);
  const registered = value ? orgs?.find((o) => o.alias === value) : undefined;
  return (
    <div className="row" style={{ gap: 6 }}>
      {removing && <RemoveOrgModal alias={removing} onClose={() => setRemoving(null)} onRemoved={() => onChange(null)} />}
      <select className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{emptyLabel}</option>
        {orgs?.map((o) => (
          <option key={o.alias} value={o.alias} disabled={!o.selectable}>
            {o.alias} — {ORG_TYPE[o.type].label}{o.selectable ? (o.type === "production" ? " (allowed)" : "") : " (not allowed)"}
          </option>
        ))}
        {value && orgs && !orgs.some((o) => o.alias === value) && <option value={value}>{value} — not registered</option>}
      </select>
      {registered && <OrgConnection alias={registered.alias} compact />}
      {registered && (
        <Hint text={`Delete ${registered.alias} from the ARM. The release agent and any project using it fall back to static validation.`}>
          <button type="button" className="btn icon danger" onClick={() => setRemoving(registered.alias)} aria-label={`Delete ${registered.alias}`}><Trash2 size={14} /></button>
        </Hint>
      )}
      {onAdd && (
        <Hint text="Register another org (alias, type and URL — no credentials).">
          <button type="button" className="btn icon" onClick={onAdd} aria-label="Add org"><Plus size={14} /></button>
        </Hint>
      )}
    </div>
  );
}

/** Confirm deletion of a registered org, showing what currently uses it. */
export function RemoveOrgModal({ alias, onClose, onRemoved }: { alias: string; onClose: () => void; onRemoved?: () => void }) {
  const qc = useQueryClient();
  const { data: agents } = useQuery({ queryKey: ["agents"], queryFn: () => api.get<{ name: string; config?: { targetOrg?: string } }[]>("/agents") });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<{ key: string; settings: { targetOrg?: string | null } }[]>("/projects") });
  const users = [...(agents ?? []).filter((a) => a.config?.targetOrg === alias).map((a) => `${a.name} (default)`), ...(projects ?? []).filter((p) => p.settings.targetOrg === alias).map((p) => p.key)];
  const remove = useMutation({
    mutationFn: () => api.del<{ cleared: string[] }>(`/salesforce/orgs/${encodeURIComponent(alias)}`),
    onSuccess: () => {
      qc.invalidateQueries();
      toast(`${alias} deleted`);
      onRemoved?.();
      onClose();
    },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <Modal
      onClose={onClose}
      title={`Delete ${alias}?`}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 size={14} /> Delete org</button></>}
    >
      <div className="col small" style={{ gap: 8 }}>
        <div>The org is removed from the ARM. Nothing changes in Salesforce — the ARM never stored credentials for it.</div>
        {users.length ? <div>It's currently used by <b>{users.join(", ")}</b>; they'll fall back to static validation until you choose another org.</div> : <div className="muted">No agent or project uses it.</div>}
      </div>
    </Modal>
  );
}

export function AddOrgModal({ onClose, onAdded }: { onClose: () => void; onAdded?: (alias: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<{ alias: string; type: OrgType; instanceUrl: string; allowProduction: boolean }>({ alias: "", type: "sandbox", instanceUrl: "", allowProduction: false });
  const save = useMutation({
    mutationFn: () => api.post<SfOrg[]>("/salesforce/orgs", f),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["orgs"] }); qc.invalidateQueries({ queryKey: ["meta"] }); toast(`Org ${f.alias} registered`); onAdded?.(f.alias); onClose(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <Modal
      onClose={onClose}
      title="Register a Salesforce org"
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.alias.trim() || save.isPending} onClick={() => save.mutate()}><Plus size={14} /> Register</button></>}
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="banner info small">Only the alias, type and URL are stored — never usernames, passwords or tokens. The Salesforce CLI on this computer keeps the login (use <b>Log in</b> after registering). In simulation nothing is sent to the org.</div>
        <Field label="Alias" help="The name you use for this org, e.g. CLIENT-DEV. In live mode it must match the alias of an org you've logged into with the Salesforce CLI.">
          <input className="input" value={f.alias} onChange={(e) => setF({ ...f, alias: e.target.value })} placeholder="e.g. CLIENT-DEV" autoFocus />
        </Field>
        <Field label="Type" help="Sandboxes, scratch orgs and Developer Edition orgs are deploy targets. A production org — a Trailhead Playground is one — is a target only if you allow it below; agents then only validate against it, and real deploys happen in the release step.">
          <select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as OrgType })}>
            {(Object.keys(ORG_TYPE) as (OrgType | "unknown")[]).filter((t) => t !== "unknown").map((t) => <option key={t} value={t}>{ORG_TYPE[t].label}</option>)}
          </select>
        </Field>
        {f.type === "production" && (
          <label className="row small" style={{ gap: 8, alignItems: "flex-start", padding: 10, borderRadius: 8, background: "color-mix(in srgb, var(--bad) 8%, transparent)" }}>
            <input type="checkbox" checked={f.allowProduction} onChange={(e) => setF({ ...f, allowProduction: e.target.checked })} style={{ marginTop: 2 }} />
            <span>
              <b>Allow agents to use this production org</b> (e.g. a Trailhead Playground for a demo). Developers and QA only <i>validate</i> against it (check-only, nothing saved); the release step deploys to it when the release agent is set to deploy. Anonymous Apex is never run on it.
            </span>
          </label>
        )}
        <Field label="Login URL (optional)" help="Used by Log in and shown in release notes. My Domain URL, or https://login.salesforce.com (production, Developer Edition, Trailhead) / https://test.salesforce.com (sandboxes).">
          <input className="input" value={f.instanceUrl} onChange={(e) => setF({ ...f, instanceUrl: e.target.value })} placeholder="https://…my.salesforce.com" />
        </Field>
      </div>
    </Modal>
  );
}

/** Production orgs (e.g. a Trailhead Playground) are only used by agents when you switch this on. */
function AllowProduction({ alias, allowed }: { alias: string; allowed: boolean }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (allow: boolean) => api.patch(`/salesforce/orgs/${encodeURIComponent(alias)}`, { allowProduction: allow }),
    onSuccess: (_r, allow) => { qc.invalidateQueries(); toast(allow ? `Agents can now use ${alias} (validate only; deploys at release)` : `${alias} is no longer a target`); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <Hint text="A production org — a Trailhead Playground is one — is used by agents only when allowed. Developers and QA then only validate against it (check-only); real deploys happen at release, and anonymous Apex is never run on it.">
      <span><Switch on={allowed} onChange={(v) => set.mutate(v)} label={allowed ? "Allowed (production)" : "Not allowed (production)"} /></span>
    </Hint>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** Settings card: the manual org registry. */
export function OrgRegistry() {
  const { data: orgs } = useOrgs();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title"><Cloud size={15} /> Salesforce orgs</div>
          <div className="card-sub">Orgs agents work against. Registered by hand — the ARM never reads the Salesforce CLI's saved logins or any credentials. Test checks the connection; Log in opens Salesforce's login in your browser.</div>
        </div>
        <button className="btn sm" onClick={() => setAdding(true)}><Plus size={13} /> Register org</button>
      </div>
      {orgs?.length ? (
        <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead><tr><th>Alias</th><th>Type</th><th>Login URL</th><th>Deploy target</th><th>Connection</th><th /></tr></thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.alias}>
                <td className="strong">{o.alias}</td>
                <td><span className="chip" style={{ background: `color-mix(in srgb, ${ORG_TYPE[o.type].color} 14%, transparent)`, color: ORG_TYPE[o.type].color }}>{ORG_TYPE[o.type].label}</span></td>
                <td className="small muted mono" title={o.instanceUrl ?? undefined}><span className="ellipsis" style={{ display: "inline-block", maxWidth: 220, verticalAlign: "bottom" }}>{o.instanceUrl ? hostOf(o.instanceUrl) : "—"}</span></td>
                <td className="small">{o.type === "production" ? <AllowProduction alias={o.alias} allowed={!!o.allowProduction} /> : "Allowed"}</td>
                <td style={{ minWidth: 260 }}><OrgConnection alias={o.alias} /></td>
                <td className="right"><button className="btn ghost sm icon danger" onClick={() => setRemoving(o.alias)} aria-label={`Delete ${o.alias}`}><Trash2 size={13} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : (
        <div className="empty small">No orgs registered yet. Releases run static validation only until you register one and pick it on the release agent or a project.</div>
      )}
      {adding && <AddOrgModal onClose={() => setAdding(false)} />}
      {removing && <RemoveOrgModal alias={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}
