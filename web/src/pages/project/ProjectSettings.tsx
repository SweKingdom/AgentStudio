import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { api, type Project } from "../../lib/api";
import { toast } from "../../lib/toast";
import { Field, Hint } from "../../components/Hint";
import { Modal, Switch } from "../../components/ui";
import { RepoFields, repoUrlError } from "../../components/Repo";
import { AddOrgModal, OrgPicker } from "../../components/Orgs";
import { SalesforceFields, useTeam, type SalesforceSettings } from "../../components/TeamSettings";
import { AdoSettings, adoConfigError, adoFormValue, adoSettingsOf } from "../../components/AdoSettings";
import { EnvironmentsEditor, defaultEnvironments, environmentsError } from "../../components/Environments";
import { BookmarkPlus } from "lucide-react";
import { CodeReviewField } from "../../components/CodeReviewField";

/** Edit a project after creation: identity, repository, run settings and target org. */
export function ProjectSettingsModal({ p, onClose }: { p: Project; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description);
  const [repo, setRepo] = useState({ url: p.settings.repo?.url ?? "", branch: p.settings.repo?.branch ?? "main", push: p.settings.repo?.push ?? false });
  const [s, setS] = useState({ gates: p.settings.gates, parallelism: p.settings.parallelism, budgetUsd: p.settings.budgetUsd, maxRework: p.settings.maxRework, codeReview: p.settings.codeReview ?? "off", targetOrg: p.settings.targetOrg ?? null });
  const [addingOrg, setAddingOrg] = useState(false);
  const { data: team } = useTeam();
  // Only what differs from the team defaults is stored on the project; empty fields follow the team.
  const [sfo, setSfo] = useState<Partial<SalesforceSettings>>(p.settings.salesforce ?? {});
  const [ado, setAdo] = useState(adoFormValue(p.settings.ado));
  // Environments replace the single "Deploy to" org; only sent when changed (it rebuilds the release stages).
  const [envs, setEnvs] = useState(p.settings.environments ?? []);
  const envsChanged = JSON.stringify(envs) !== JSON.stringify(p.settings.environments ?? []);
  const err = repoUrlError(repo.url);
  const save = useMutation({
    mutationFn: () => api.patch(`/projects/${p.id}`, { name, description, settings: { ...s, repo: { url: repo.url.trim(), branch: repo.branch.trim() || "main", push: repo.push }, salesforce: Object.fromEntries(Object.entries(sfo).filter(([k, v]) => v !== "" && v !== undefined && v !== null && !(k === "devTestLevel" && v === team?.salesforce.devTestLevel))), ado: adoSettingsOf(ado), ...(envsChanged ? { environments: envs } : {}) } }),
    onSuccess: () => { qc.invalidateQueries(); toast("Project settings saved"); onClose(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const running = p.pipelineRunning;
  return (
    <Modal
      onClose={onClose}
      title={`Project settings — ${p.key}`}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!!err || !!adoConfigError(ado) || !!environmentsError(envs) || !name.trim() || save.isPending} onClick={() => save.mutate()}><Save size={14} /> Save</button></>}
    >
      <div className="col" style={{ gap: 14 }}>
        <Field label="Project name" help="Shown in tabs, the sidebar and every export. The project key (e.g. SCR) never changes.">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Context for the team" help="Extra context every agent receives: client, goals, constraints, priorities.">
          <textarea className="textarea" style={{ minHeight: 70 }} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <RepoFields {...repo} onChange={setRepo} />
        <div className="grid g2" style={{ gap: 12 }}>
          <Field label="Approval gates" help={running ? "Can't be changed while the pipeline is running — pause it first." : "On: the pipeline pauses for you after the backlog, after the plan and before release. Off: autopilot."}>
            <div className="row" style={{ height: 34, opacity: running ? 0.5 : 1 }}><Switch on={s.gates} onChange={(v) => !running && setS({ ...s, gates: v })} label="Approval gates" /><span className="small muted">{s.gates ? "On" : "Autopilot"}</span></div>
          </Field>
          <Field label="Parallel lanes" help="How many stories are built, tested and documented at the same time.">
            <input className="input" type="number" min={1} max={8} value={s.parallelism} onChange={(e) => setS({ ...s, parallelism: Math.max(1, Number(e.target.value)) })} />
          </Field>
          <Field label="Budget cap (USD)" help="The pipeline pauses when the project's AI cost reaches this amount. 0 = no limit.">
            <input className="input" type="number" min={0} value={s.budgetUsd} onChange={(e) => setS({ ...s, budgetUsd: Number(e.target.value) })} />
          </Field>
          <Field label="Max QA rework" help="How many times QA can send a story back before it's Blocked for you to review.">
            <input className="input" type="number" min={0} max={5} value={s.maxRework} onChange={(e) => setS({ ...s, maxRework: Number(e.target.value) })} />
          </Field>
          <CodeReviewField value={s.codeReview} onChange={(v) => setS({ ...s, codeReview: v })} />
        </div>
        {envs.length ? (
          <div className="col" style={{ gap: 6 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="strong small">Environments</span>
              <span className="tiny muted">{running ? "Can't be changed while the pipeline is running — pause it first." : "Stories are built on the build environment; the release walks the others in order."}</span>
              <span className="spacer" />
              <Hint text="Go back to a single target org and a single release step."><button type="button" className="btn sm ghost" disabled={running} onClick={() => setEnvs([])}>Use a single org</button></Hint>
            </div>
            <EnvironmentsEditor value={envs} onChange={setEnvs} disabled={running} />
          </div>
        ) : (
          <Field label="Deploy to" help="The Salesforce org this project's releases go to. Leave it on the release agent's default, or pick a registered org. In simulation the deployment is simulated." hint={<button type="button" className="btn sm ghost" style={{ marginTop: 4 }} disabled={running} onClick={() => setEnvs(defaultEnvironments().map((e) => (e.purpose === "build" ? { ...e, org: s.targetOrg } : e)))}>Use environments instead (Test → Production, add UAT…)</button>}>
            <OrgPicker value={s.targetOrg} onChange={(v) => setS({ ...s, targetOrg: v })} emptyLabel="Release agent's default" onAdd={() => setAddingOrg(true)} />
          </Field>
        )}
        {addingOrg && <AddOrgModal onClose={() => setAddingOrg(false)} onAdded={(a) => setS({ ...s, targetOrg: a })} />}
        <div className="col" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="strong small">Salesforce</span>
            <span className="tiny muted">Empty fields use the team defaults (Settings → Salesforce defaults).</span>
          </div>
          <div className="grid g3" style={{ gap: 12 }}>
            {team && <SalesforceFields value={sfo} onChange={setSfo} placeholders={team.salesforce} />}
          </div>
        </div>
        <AdoSettings projectId={p.id} value={ado} onChange={setAdo} />
      </div>
    </Modal>
  );
}
