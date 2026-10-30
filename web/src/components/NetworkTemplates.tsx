import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookmarkPlus, LayoutTemplate, Lock, Loader2, Trash2 } from "lucide-react";
import { api, type NetworkTemplate, type Project } from "../lib/api";
import { useMeta } from "../lib/queries";
import { toast } from "../lib/toast";
import { Field, Hint } from "./Hint";
import { Modal } from "./ui";

export interface ResolvedTemplate { template: NetworkTemplate; agentIds: string[]; missingRoles: string[]; settings: NetworkTemplate["settings"] }

export function useTemplates() {
  return useQuery({ queryKey: ["templates"], queryFn: () => api.get<NetworkTemplate[]>("/templates") });
}

function RoleChips({ roles }: { roles: string[] }) {
  const { data: meta } = useMeta();
  return (
    <div className="row wrap" style={{ gap: 4 }}>
      {roles.map((r) => {
        const def = meta?.roles.find((x) => x.role === r);
        return <span key={r} className="chip" style={{ background: `color-mix(in srgb, ${def?.color ?? "var(--muted)"} 14%, transparent)`, color: def?.color ?? "var(--muted)" }}>{def?.title ?? r}</span>;
      })}
    </div>
  );
}

/** "Start from a template" on the New project page: picking one pre-selects agents, settings and environment slots. */
export function TemplatePicker({ value, onPick }: { value: string | null; onPick: (r: ResolvedTemplate | null) => void }) {
  const { data: templates } = useTemplates();
  const [loading, setLoading] = useState<string | null>(null);
  const pick = async (id: string | null) => {
    if (!id) return onPick(null);
    setLoading(id);
    try {
      const r = await api.get<ResolvedTemplate>(`/templates/${id}/resolve`);
      if (r.missingRoles.length) toast(`No enabled agent for: ${r.missingRoles.join(", ")} — those stages will be skipped.`, "bad");
      onPick(r);
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setLoading(null);
    }
  };
  return (
    <div className="tpl-grid" role="radiogroup" aria-label="Project templates">
      {(templates ?? []).map((t) => (
        <Hint key={t.id} block text={`${t.description || t.name} Selecting it sets the team and run settings — you can still change everything below.`}>
          <button type="button" role="radio" aria-checked={value === t.id} className={`tpl-card ${value === t.id ? "on" : ""}`} onClick={() => pick(value === t.id ? null : t.id)}>
            <span className="row" style={{ gap: 6 }}>
              {loading === t.id ? <Loader2 size={13} className="spin" /> : <LayoutTemplate size={13} />}
              <span className="strong small ellipsis">{t.name}</span>
              {!t.builtin && <span className="chip" style={{ background: "var(--panel-3)" }}>Custom</span>}
            </span>
            <span className="tiny muted tpl-desc">{t.description}</span>
          </button>
        </Hint>
      ))}
    </div>
  );
}

/** Settings → Team: built-in and custom network templates; custom ones can be deleted. */
export function NetworkTemplates() {
  const qc = useQueryClient();
  const { data: templates } = useTemplates();
  const [deleting, setDeleting] = useState<NetworkTemplate | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/templates/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["templates"] }); toast("Template deleted"); setDeleting(null); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title"><LayoutTemplate size={15} /> Network templates</div>
          <div className="card-sub">Reusable project setups: which roles are on the team and the run settings. Save your own from a project's settings; custom templates travel in the team template file.</div>
        </div>
      </div>
      <div className="card-pad col" style={{ gap: 10 }}>
        {(templates ?? []).map((t) => (
          <div key={t.id} className="tpl-row">
            <div className="col" style={{ gap: 6, flex: 1, minWidth: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="strong">{t.name}</span>
                {t.builtin ? <Hint text="Built-in templates can't be changed or deleted."><span className="chip" style={{ background: "var(--panel-3)" }}><Lock size={10} /> Built-in</span></Hint> : <span className="chip" style={{ background: "var(--panel-3)" }}>Custom</span>}
              </div>
              {t.description && <div className="small muted">{t.description}</div>}
              <RoleChips roles={t.roles} />
              <div className="row wrap tiny muted" style={{ gap: "4px 12px" }}>
                <span>Gates {t.settings.gates ? "on" : "off"}</span>
                <span>{t.settings.parallelism} lane(s)</span>
                <span>Max rework {t.settings.maxRework}</span>
                <span>Budget {t.settings.budgetUsd ? `$${t.settings.budgetUsd}` : "no limit"}</span>
              </div>            </div>
            {!t.builtin && (
              <Hint text={`Delete the template "${t.name}". Projects created from it keep their settings.`}>
                <button type="button" className="btn icon danger" onClick={() => setDeleting(t)} aria-label={`Delete ${t.name}`}><Trash2 size={14} /></button>
              </Hint>
            )}
          </div>
        ))}
      </div>
      {deleting && (
        <Modal
          onClose={() => setDeleting(null)}
          title={`Delete template "${deleting.name}"?`}
          footer={<><button className="btn ghost" onClick={() => setDeleting(null)}>Cancel</button><button className="btn danger" disabled={del.isPending} onClick={() => del.mutate(deleting.id)}><Trash2 size={14} /> Delete</button></>}
        >
          <div className="small">Projects created from it keep their own team and settings.</div>
        </Modal>
      )}
    </div>
  );
}

/** "Save as template" from a project: its team roles, run settings and environment slots (orgs left out). */
export function SaveAsTemplateModal({ p, onClose }: { p: Pick<Project, "id" | "name" | "key">; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(`${p.name} setup`);
  const [description, setDescription] = useState(`Saved from project ${p.key}.`);
  const save = useMutation({
    mutationFn: () => api.post<NetworkTemplate>(`/projects/${p.id}/save-template`, { name: name.trim(), description }),
    onSuccess: (t) => { qc.invalidateQueries({ queryKey: ["templates"] }); toast(`Template "${t.name}" saved`); onClose(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <Modal
      onClose={onClose}
      title="Save as template"
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}><BookmarkPlus size={14} /> Save template</button></>}
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="small muted">Saves this project's team roles, run settings and environment chain. Org aliases are left out — each new project maps its own.</div>
        <Field label="Template name" help="Shown in “Start from a template” on the New project page and in Settings → Team.">
          <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Description" help="When to use this setup — shown on the template card.">
          <textarea className="textarea" style={{ minHeight: 60 }} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
