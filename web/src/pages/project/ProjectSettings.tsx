import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { api, type ChecksSettings, type Project } from "../../lib/api";
import { toast } from "../../lib/toast";
import { Field } from "../../components/Hint";
import { Modal, Switch } from "../../components/ui";
import { RepoFields, repoUrlError } from "../../components/Repo";
import { ChecksFields, useTeam } from "../../components/TeamSettings";
import { AdoSettings, adoConfigError, adoFormValue, adoSettingsOf } from "../../components/AdoSettings";
import { BookmarkPlus } from "lucide-react";
import { CodeReviewField, DESIGN_CRITIQUE_HELP, LESSONS_HELP } from "../../components/CodeReviewField";
import { useClaudeAccounts } from "../../components/ClaudeAccounts";
import { t } from "../../lib/i18n";
import { useMeta } from "../../lib/queries";

/** Edit a project after creation: identity, repository, run settings and checks. */
export function ProjectSettingsModal({ p, onClose }: { p: Project; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description);
  const [repo, setRepo] = useState({ url: p.settings.repo?.url ?? "", branch: p.settings.repo?.branch ?? "main", push: p.settings.repo?.push ?? false });
  const [s, setS] = useState({ gates: p.settings.gates, parallelism: p.settings.parallelism, budgetUsd: p.settings.budgetUsd, maxRework: p.settings.maxRework, codeReview: p.settings.codeReview ?? "off", designCritique: p.settings.designCritique !== false, lessons: p.settings.lessons !== false, claudeAccount: p.settings.claudeAccount ?? null, modelBySize: { small: p.settings.modelBySize?.small ?? null, large: p.settings.modelBySize?.large ?? null } , mergeMode: p.settings.mergeMode ?? "auto", reviewRework: p.settings.reviewRework ?? "ask"});
  const { data: meta } = useMeta();
  const sizeModel = (size: "small" | "large", label: string) => (
    <select className="input" aria-label={label} value={s.modelBySize[size] ?? ""} onChange={(e) => setS({ ...s, modelBySize: { ...s.modelBySize, [size]: e.target.value || null } })}>
      <option value="">{t("The agent's own model")}</option>
      {meta?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
    </select>
  );
  const { data: claude } = useClaudeAccounts();
  const { data: team } = useTeam();
  // Only what differs from the team defaults is stored on the project; an empty list follows the team.
  const [checks, setChecks] = useState<Partial<ChecksSettings>>(p.settings.checks ?? {});
  const [ado, setAdo] = useState(adoFormValue(p.settings.ado));
  const [commands, setCommands] = useState((p.settings.commands ?? []).join("\n"));
  const [protectedPaths, setProtectedPaths] = useState((p.settings.protectedPaths ?? []).join("\n"));
  const err = repoUrlError(repo.url);
  const save = useMutation({
    mutationFn: () => api.patch(`/projects/${p.id}`, { name, description, settings: { ...s, repo: { url: repo.url.trim(), branch: repo.branch.trim() || "main", push: repo.push }, checks: { commands: (checks.commands ?? []).filter((c) => c.command.trim()), ...(checks.timeoutMinutes ? { timeoutMinutes: checks.timeoutMinutes } : {}), ...(checks.install?.trim() ? { install: checks.install.trim() } : {}) }, ado: adoSettingsOf(ado), commands: commands.split("\n").map((c) => c.trim()).filter(Boolean), protectedPaths: protectedPaths.split("\n").map((c) => c.trim()).filter(Boolean) } }),
    onSuccess: () => { qc.invalidateQueries(); toast("Project settings saved"); onClose(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const running = p.pipelineRunning;
  return (
    <Modal
      onClose={onClose}
      title={`Project settings — ${p.key}`}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!!err || !!adoConfigError(ado) || !name.trim() || save.isPending} onClick={() => save.mutate()}><Save size={14} /> Save</button></>}
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
          <Field label={t("Merging")} help={t("Who merges a finished story. Review PR: AgentStudio opens the pull request and a person reviews and merges it; the story waits In Review and stories that build on it wait for the merge. Without GitHub the story gets a Merge button.")}>
            <select className="input" value={s.mergeMode} onChange={(e) => setS({ ...s, mergeMode: e.target.value as "auto" | "review" })}>
              <option value="auto">{t("AgentStudio merges")}</option>
              <option value="review">{t("Review PR: a person merges")}</option>
            </select>
          </Field>
          {s.mergeMode === "review" && (
            <Field label={t("When a reviewer requests changes")} help={t("Ask me: the story waits as Changes Requested with the reviewer's comments, which you can edit before sending them to the developer. Automatically: the comments go to the developer as soon as AgentStudio sees them.")}>
              <select className="input" value={s.reviewRework} onChange={(e) => setS({ ...s, reviewRework: e.target.value as "ask" | "auto" })}>
                <option value="ask">{t("Ask me (edit the feedback first)")}</option>
                <option value="auto">{t("Send to the developer automatically")}</option>
              </select>
            </Field>
          )}
          <CodeReviewField value={s.codeReview} onChange={(v) => setS({ ...s, codeReview: v })} />
          <Field label="Design critique" help={DESIGN_CRITIQUE_HELP}>
            <div className="row" style={{ height: 34 }}><Switch on={s.designCritique} onChange={(v) => setS({ ...s, designCritique: v })} label="Design critique" /><span className="small muted">{s.designCritique ? "On" : "Off"}</span></div>
          </Field>
          <Field label="Lessons learned" help={LESSONS_HELP}>
            <div className="row" style={{ height: 34 }}><Switch on={s.lessons} onChange={(v) => setS({ ...s, lessons: v })} label="Lessons learned" /><span className="small muted">{s.lessons ? "On" : "Off"}</span></div>
          </Field>
          <Field label={t("Model for small stories (1–2 points)")} help={t("The developer and QA use this model on small stories. A cheaper model costs less per story, but watch the rework rounds: if they go up, it costs more. Takes effect from the next agent run.")}>
            {sizeModel("small", t("Model for small stories (1–2 points)"))}
          </Field>
          <Field label={t("Model for large stories (8 points)")} help={t("The developer and QA use this model on 8-point stories, where a stronger model often saves rework rounds. Takes effect from the next agent run.")}>
            {sizeModel("large", t("Model for large stories (8 points)"))}
          </Field>
          <Field label="Claude account" help="Which Claude login this project's live agents use on the plan backend (Settings → Claude account). Takes effect from the next agent run.">
            <select className="input" value={s.claudeAccount ?? ""} onChange={(e) => setS({ ...s, claudeAccount: e.target.value || null })}>
              <option value="">{`Default (${claude?.accounts.find((a) => a.id === claude.active)?.label ?? "this computer's login"})`}</option>
              {claude?.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}{a.status.email ? ` — ${a.status.email}` : a.status.loggedIn ? "" : " — not signed in"}</option>)}
            </select>
          </Field>
        </div>
        <div className="col" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="strong small">Checks</span>
            <span className="tiny muted">Commands every story must pass. Empty: the team's checks (Settings → Team), else detected from package.json.</span>
          </div>
          <ChecksFields
            value={checks}
            onChange={setChecks}
            installPlaceholder={`Team: ${team?.checks.install || "auto"}${p.install ? ` — runs ${p.install}` : ""}`}
            placeholder={team?.checks.commands.length ? `Team checks: ${team.checks.commands.map((c) => c.command).join(" · ")}` : p.checks.length ? `Detected: ${p.checks.map((c) => c.command).join(" · ")}` : "No checks found — add one, e.g. npm test."}
          />
        </div>
        <Field
          label="Allowed commands"
          help="Commands the developer agent may run itself in a story's worktree, one per line — e.g. dotnet ef migrations add, or dotnet run -- --seed-only. A command must start with one of these, word for word; ; & | < > ` and $ are never allowed. It runs with this computer's rights and without AgentStudio's keys. Generated files are committed with the story. Empty: the agent asks you for a manual step instead."
        >
          <textarea className="textarea mono" style={{ minHeight: 64 }} value={commands} placeholder={"dotnet ef migrations add\ndotnet run -- --seed-only"} onChange={(e) => setCommands(e.target.value)} />
        </Field>
        <Field
          label="Protected paths"
          help="Files no story may add or change, one glob per line (* within a folder, ** across folders) — e.g. infra/prod/** or migrations/legacy/*. Added to the built-in ones: .env files (not .env.example), keys and certificates, .npmrc and other credential files. The security scan before every merge checks them, together with secrets, dependency sources and links out of the repository; it can't be turned off."
        >
          <textarea className="textarea mono" style={{ minHeight: 48 }} value={protectedPaths} placeholder={"infra/prod/**"} onChange={(e) => setProtectedPaths(e.target.value)} />
        </Field>
        <AdoSettings projectId={p.id} value={ado} onChange={setAdo} />
      </div>
    </Modal>
  );
}
