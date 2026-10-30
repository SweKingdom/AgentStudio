import { useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Hammer, Plus, ShieldCheck, Trash2, TriangleAlert, Users } from "lucide-react";
import type { EnvPurpose, Environment, Project, TestLevel } from "../lib/api";
import { Field, Hint } from "./Hint";
import { Seg, Switch } from "./ui";
import { AddOrgModal, OrgPicker } from "./Orgs";

export const PURPOSES: Record<EnvPurpose, { label: string; help: string; icon: typeof Hammer }> = {
  build: { label: "Build", help: "Where stories are developed, validated and peer-tested (developer and QA tools use this org).", icon: Hammer },
  stage: { label: "Stage", help: "A step the release goes through before production, e.g. UAT or pre-production.", icon: Users },
  production: { label: "Production", help: "The last step. With approval and deploy mode on, the release is validated check-only first and deployed after you approve.", icon: ShieldCheck },
};

const TEST_LEVELS: { value: TestLevel; label: string }[] = [
  { value: "RunLocalTests", label: "Local tests" },
  { value: "RunSpecifiedTests", label: "Specified tests" },
  { value: "RunAllTestsInOrg", label: "All tests in org" },
  { value: "NoTestRun", label: "No tests (not on production)" },
];

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "env";

/** A key that's unique in the list (keys name the pipeline stages, e.g. release:uat). */
function uniqueKey(name: string, envs: Environment[]) {
  let key = /^[a-z]/.test(slug(name)) ? slug(name) : `env-${slug(name)}`.slice(0, 20);
  for (let n = 2; envs.some((e) => e.key === key); n++) key = `${slug(name).slice(0, 17)}-${n}`;
  return key;
}

export function newEnvironment(purpose: EnvPurpose, envs: Environment[]): Environment {
  const name = purpose === "build" ? "Test" : purpose === "production" ? "Production" : envs.some((e) => e.name === "UAT") ? "Staging" : "UAT";
  return { key: uniqueKey(name, envs), name, purpose, org: null, deployMode: "deploy", testLevel: "RunLocalTests", approval: purpose !== "build" };
}

/** The usual starting point: Test (build) → Production (with approval). */
export function defaultEnvironments(): Environment[] {
  const test = newEnvironment("build", []);
  return [{ ...test, approval: false }, newEnvironment("production", [test])];
}

/** Same rules as the server (cleanEnvironments) so problems show before saving. */
export function environmentsError(envs: Environment[]): string | null {
  if (envs.some((e) => !e.name.trim())) return "Every environment needs a name.";
  const keys = envs.map((e) => e.key);
  if (new Set(keys).size !== keys.length) return "Two environments share a key — rename one.";
  const builds = envs.filter((e) => e.purpose === "build");
  if (builds.length > 1) return "Only one build environment.";
  if (builds.length && envs[0].purpose !== "build") return "The build environment comes first.";
  const prods = envs.filter((e) => e.purpose === "production");
  if (prods.length > 1) return "Only one production environment.";
  if (prods.length && envs[envs.length - 1].purpose !== "production") return "Production comes last.";
  return null;
}

/** Hover help for an environment stage of the pipeline path (release:uat, approve:prod, validate:prod). */
export function envStageHelp(p: Pick<Project, "settings">, key: string): string | undefined {
  const m = /^(validate|approve|release):(.+)$/.exec(key);
  const e = m ? p.settings.environments?.find((x) => x.key === m[2]) : undefined;
  if (!m || !e) return undefined;
  const org = e.org ? `org ${e.org}` : "no org mapped — static validation";
  if (m[1] === "approve") return `You approve before the release goes to ${e.name} (${org}).`;
  if (m[1] === "validate") return `Check-only validation against ${e.name} (${org}) before your approval — nothing is deployed yet.`;
  return `The release manager ${e.deployMode === "deploy" ? "validates and deploys to" : "validates against"} ${e.name} (${org}) and smoke-tests every item.`;
}

/** Compact chain: Test → UAT ✋ → Production ✋. */
export function EnvironmentChain({ envs }: { envs: Environment[] }) {
  return (
    <div className="env-chain" aria-label="Environment chain">
      {envs.map((e, i) => {
        const P = PURPOSES[e.purpose];
        return (
          <span key={e.key} className="row" style={{ gap: 6 }}>
            {i > 0 && <ArrowRight size={12} className="faint" aria-hidden />}
            <Hint text={`${P.label}: ${e.org ? `org ${e.org}` : "no org mapped"} · ${e.deployMode === "deploy" ? "deploys" : "validates only"}${e.approval ? " · waits for your approval first" : ""}`}>
              <span className={`env-pill ${e.purpose}`}>
                <P.icon size={11} /> {e.name || "Unnamed"}{e.approval && <span className="env-gate" aria-label="approval">✋</span>}
              </span>
            </Hint>
          </span>
        );
      })}
    </div>
  );
}

/**
 * Ordered environments editor: add, remove, reorder; name, purpose, org, deploy mode, test level and approval.
 * `slots` hides the org pickers (templates hold environment slots, not orgs).
 */
export function EnvironmentsEditor({ value, onChange, disabled, slots }: { value: Environment[]; onChange: (v: Environment[]) => void; disabled?: boolean; slots?: boolean }) {
  const [addingFor, setAddingFor] = useState<number | null>(null);
  const set = (i: number, patch: Partial<Environment>) => onChange(value.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...value];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  const add = (purpose: EnvPurpose) => {
    const env = newEnvironment(purpose, value);
    // Keep the build env first and production last when adding.
    if (purpose === "build") onChange([env, ...value]);
    else if (purpose === "stage" && value.at(-1)?.purpose === "production") onChange([...value.slice(0, -1), env, value.at(-1)!]);
    else onChange([...value, env]);
  };
  const err = environmentsError(value);
  const unmapped = slots ? [] : value.filter((e) => !e.org).map((e) => e.name);
  return (
    <div className="col env-editor" style={{ gap: 10, opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? "none" : undefined }}>
      {value.length > 0 && <EnvironmentChain envs={value} />}
      <ol className="env-list">
        {value.map((e, i) => (
          <li key={i} className={`env-row ${e.purpose}`}>
            <div className="env-row-head">
              <span className="code-tag">{i + 1}</span>
              <Field label="Name" help="Shown in the pipeline path, approvals and release notes (e.g. Test, UAT, Production)." style={{ flex: 1, minWidth: 120 }}>
                <input className="input" value={e.name} maxLength={40} onChange={(ev) => set(i, { name: ev.target.value })} />
              </Field>
              <Field label="Purpose" help={<>Build: stories are developed and tested there. Stage: a release step before production (UAT). Production: the last step.<br />{PURPOSES[e.purpose].help}</>} style={{ width: 150 }}>
                <select className="select" value={e.purpose} onChange={(ev) => set(i, { purpose: ev.target.value as EnvPurpose, ...(ev.target.value === "build" ? { approval: false } : {}) })}>
                  {(Object.keys(PURPOSES) as EnvPurpose[]).map((p) => <option key={p} value={p}>{PURPOSES[p].label}</option>)}
                </select>
              </Field>
              <div className="row env-row-tools">
                <Hint text="Move up"><button type="button" className="btn icon ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${e.name} up`}><ArrowUp size={14} /></button></Hint>
                <Hint text="Move down"><button type="button" className="btn icon ghost" disabled={i === value.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${e.name} down`}><ArrowDown size={14} /></button></Hint>
                <Hint text={`Remove ${e.name || "this environment"}`}><button type="button" className="btn icon danger" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${e.name}`}><Trash2 size={14} /></button></Hint>
              </div>
            </div>
            <div className="env-row-body">
              {!slots && (
                <Field label="Org" help="The registered Salesforce org (alias) for this environment. Empty: static validation only. In simulation nothing is sent to Salesforce." style={{ gridColumn: "1 / -1" }}>
                  <OrgPicker value={e.org} onChange={(v) => set(i, { org: v })} emptyLabel="No org — static validation only" onAdd={() => setAddingFor(i)} />
                </Field>
              )}
              <Field label="Deploy mode" help={e.purpose === "build" ? "Deploy: stories are deployed to this org when the developer validates them. Validate: check-only, nothing is saved in the org." : "Deploy: the release is validated, then deployed. Validate: check-only validation, nothing is deployed."}>
                <Seg value={e.deployMode} onChange={(v) => set(i, { deployMode: v })} options={[{ value: "validate", label: "Validate" }, { value: "deploy", label: "Deploy" }]} />
              </Field>
              <Field label="Test level" help="Apex tests run when the release is validated or deployed here. Production always runs at least local tests.">
                <select className="select" value={e.testLevel} onChange={(ev) => set(i, { testLevel: ev.target.value as TestLevel })}>
                  {TEST_LEVELS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </Field>
              <Field label="Approval" help={e.purpose === "build" ? "Stories are built here continuously — the build environment has no approval step." : "On: the pipeline pauses for your approval before the release goes here (independent of the general approval gates)."}>
                <div className="row" style={{ height: 34, gap: 8, opacity: e.purpose === "build" ? 0.5 : 1 }}>
                  <Switch on={e.approval} onChange={(v) => e.purpose !== "build" && set(i, { approval: v })} label={`Approval before ${e.name}`} />
                  <span className="small muted">{e.approval ? "Waits for you" : "Automatic"}</span>
                </div>
              </Field>
            </div>
          </li>
        ))}
      </ol>
      <div className="row wrap" style={{ gap: 6 }}>
        <Hint text="The environment stories are developed and tested in (only one, always first)."><button type="button" className="btn sm" disabled={value.some((e) => e.purpose === "build")} onClick={() => add("build")}><Plus size={13} /> Build env</button></Hint>
        <Hint text="A release step before production, e.g. UAT."><button type="button" className="btn sm" onClick={() => add("stage")}><Plus size={13} /> Stage env</button></Hint>
        <Hint text="The last step of the release (only one)."><button type="button" className="btn sm" disabled={value.some((e) => e.purpose === "production")} onClick={() => add("production")}><Plus size={13} /> Production</button></Hint>
      </div>
      {err && <div className="banner warn small"><TriangleAlert size={14} /> {err}</div>}
      {!err && unmapped.length > 0 && <div className="hint">No org mapped for {unmapped.join(", ")} — {unmapped.length === 1 ? "it runs" : "they run"} static validation only.</div>}
      {addingFor !== null && <AddOrgModal onClose={() => setAddingFor(null)} onAdded={(a) => set(addingFor, { org: a })} />}
    </div>
  );
}
