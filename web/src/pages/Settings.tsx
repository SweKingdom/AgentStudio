import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Save, RotateCcw, AlertTriangle, SlidersHorizontal, Stethoscope, Users, FolderKanban, Coins, ShieldCheck, UserRound } from "lucide-react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import { api, type AppSettings, type ModelPrice } from "../lib/api";
import { useMeta } from "../lib/queries";
import { Seg, Switch } from "../components/ui";
import { money } from "../lib/format";
import { toast } from "../lib/toast";
import { Field, Hint } from "../components/Hint";
import { PageSkeleton } from "../components/Skeleton";
import { SystemCheck, TeamConventions, TeamTemplate } from "../components/TeamSettings";
import { UsersAccess } from "../components/Users";
import { ClaudeAccountsSettings } from "../components/ClaudeAccounts";
import { t } from "../lib/i18n";

const SECTIONS = [
  { key: "general", label: "General", icon: SlidersHorizontal, sub: "Mode, spend limits", saves: true },
  { key: "claude", label: "Claude account", icon: UserRound, sub: "Which Claude login agents use", saves: false },
  { key: "system", label: "System check", icon: Stethoscope, sub: "Is this computer ready?", saves: false },
  { key: "team", label: "Team", icon: Users, sub: "Conventions, checks, template", saves: false },
  { key: "projects", label: "Projects", icon: FolderKanban, sub: "Defaults, human baseline, currency", saves: true },
  { key: "pricing", label: "Model prices", icon: Coins, sub: "Prices for every cost figure", saves: true },
  { key: "users", label: "Users & access", icon: ShieldCheck, sub: "Login, roles, audit log", saves: false },
] as const;

export default function Settings() {
  const { section = "general" } = useParams();
  const current = SECTIONS.find((x) => x.key === section);
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const [s, setS] = useState<AppSettings | null>(null);
  const [models, setModels] = useState<ModelPrice[] | null>(null);
  useEffect(() => {
    if (meta && !s) { setS(meta.settings); setModels(meta.models); }
  }, [meta, s]);
  const save = useMutation({
    mutationFn: async () => {
      await api.put("/settings", s);
      await api.put("/models", models);
    },
    onSuccess: () => { qc.invalidateQueries(); toast("Settings saved"); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  if (!current) return <Navigate to="/settings/general" replace />;
  if (!meta || !s || !models) return <PageSkeleton />;
  const dirty = JSON.stringify(s) !== JSON.stringify(meta.settings) || JSON.stringify(models) !== JSON.stringify(meta.models);
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setS({ ...s, [k]: v });
  // The backend the form would use once saved: Plan, or Auto without an API key.
  const planChosen = s.backend === "subscription" || (s.backend === "auto" && !meta.hasApiKey);
  const setPrice = (i: number, k: keyof ModelPrice, v: string) => setModels(models.map((m, j) => (j === i ? { ...m, [k]: k === "id" || k === "label" ? v : Number(v) } : m)));

  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <div className="page-sub">{t("How AgentStudio runs, how the team works, and the prices used for every cost figure.")}</div>
        </div>
        {current.saves && (
          <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending || !dirty} title={dirty ? "Save the changes in General, Projects and Model prices" : "No unsaved changes"}>
            <Save size={14} /> {dirty ? "Save changes" : "Saved"}
          </button>
        )}
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((x) => (
            <NavLink key={x.key} to={`/settings/${x.key}`} className={({ isActive }) => `settings-nav-item ${isActive ? "on" : ""}`}>
              <x.icon size={15} />
              <span className="col" style={{ gap: 1, minWidth: 0 }}>
                <span>{t(x.label)}</span>
                <span className="tiny faint ellipsis">{t(x.sub)}</span>
              </span>
            </NavLink>
          ))}
        </nav>
      <div className="col settings-body fade-in" key={current.key} style={{ gap: 14 }}>
        {current.key === "claude" && <ClaudeAccountsSettings />}
        {current.key === "general" && (<>
        <div className="card">
          <div className="card-head"><div className="card-title">{t("Execution")}</div></div>
          <div className="card-pad col" style={{ gap: 16 }}>
            <div>
              {meta.backend === "subscription" ? (
                <div className="banner info">
                  <CheckCircle2 size={16} color="var(--good)" />
                  <div className="small"><b>{t("Using your Claude plan.")}</b> Live agents run on the Claude login chosen under <NavLink to="/settings/claude" style={{ textDecoration: "underline" }}>{t("Claude account")}</NavLink>; usage counts against that plan's limits, and the dollar figures are estimates.</div>
                </div>
              ) : (
                <div className={`banner ${meta.hasApiKey ? "info" : "warn"}`}>
                  {meta.hasApiKey ? <CheckCircle2 size={16} color="var(--good)" /> : <KeyRound size={16} color="var(--warn)" />}
                  <div className="small">
                    {meta.hasApiKey ? <><b>Claude API key found.</b> Agents can run live.</> : <><b>No API key.</b> Add <code className="code-tag">ANTHROPIC_API_KEY=…</code> to <code className="code-tag">.env</code> in the project root and restart.</>}
                  </div>
                </div>
              )}
            </div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div className="strong small">{t("Mode")}</div>
                <div className="hint">
                  {t("Simulation: free, nothing is sent to Claude and no checks run.")}{" "}
                  {planChosen
                    ? t("Live: agents run on your Claude plan through this computer's claude login — no API charges, but it uses the plan's usage limits, and the project's checks really run.")
                    : t("Live: agents call the Claude API with your key — real tokens, billed per use, and the project's checks really run.")}{" "}
                  {t("Running now:")} <b style={{ color: meta.mode === "live" ? "var(--bad)" : undefined }}>{meta.mode === "live" ? "LIVE" : t("simulation")}</b>
                  {s.mode === "live" && meta.backend === "api" && !meta.hasApiKey && <span style={{ color: "var(--warn)" }}> — Live needs ANTHROPIC_API_KEY in .env; until then agents keep simulating.</span>}
                </div>
              </div>
              <Hint text={t("Live shows a red LIVE badge while it's on. Projects keep the mode they were created in: create a new project after switching.")}>
                <Seg value={s.mode} onChange={(v) => set("mode", v)} options={[{ value: "simulation", label: t("Simulation") }, { value: "live", label: t("Live") }]} />
              </Hint>
            </div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div><div className="strong small">{t("Claude backend")}</div><div className="hint">Plan: your own Claude subscription via <code className="code-tag">claude /login</code> (personal use). API: the key in .env, billed per token. Auto uses the API when a key is set. Running now: <b>{meta.backend === "subscription" ? "plan" : "API"}</b></div></div>
              <Hint text="Plan runs agents through the Claude Agent SDK on this machine's Claude login. API calls the Claude API with ANTHROPIC_API_KEY. A team or always-on use needs the API.">
                <Seg value={s.backend} onChange={(v) => set("backend", v)} options={[{ value: "auto", label: "Auto" }, { value: "subscription", label: "Plan" }, { value: "api", label: "API" }]} />
              </Hint>
            </div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div><div className="strong small">{t("Simulation speed")}</div><div className="hint">{t("Multiplier on simulated work time. 1 = realistic pace, 0.2 = fast demo.")}</div></div>
              <Hint text="Multiplier on how long each simulated agent step takes. 1 ≈ realistic pace so you can watch the graph; 0.2 = fast demo; 0 = instant.">
                <input className="input" type="number" step={0.1} min={0} max={5} style={{ width: 100 }} value={s.simulationSpeed} onChange={(e) => set("simulationSpeed", Number(e.target.value))} />
              </Hint>
            </div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div><div className="strong small">{t("Refusal fallback")}</div><div className="hint">If a model declines a request, the API retries it on a fallback model automatically (Opus 5.5, Sonnet 5.5, Fable 5.1).</div></div>
              <Hint text="Live mode only: if a model declines a request, the API automatically retries it on a fallback model instead of stopping the run.">
                <Switch on={s.refusalFallback} onChange={(v) => set("refusalFallback", v)} label="Refusal fallback" />
              </Hint>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Spend limits & automatic pause</div>
              <div className="card-sub">When a limit is reached, or the Claude API runs out of capacity or credits, all work pauses and can continue later. Spent so far: {money(meta.spend.today)} today · {money(meta.spend.month)} this month{meta.mode === "simulation" ? " (simulated)" : ""}.</div>
            </div>
          </div>
          <div className="card-pad grid g3" style={{ gap: 16 }}>
            <Field label="Daily limit (USD)" help="Maximum AI spend per day across all projects. When reached, everything pauses. 0 = no limit.">
              <input className="input" type="number" min={0} step={1} value={s.dailyLimitUsd} onChange={(e) => set("dailyLimitUsd", Number(e.target.value))} />
            </Field>
            <Field label="Monthly limit (USD)" help="Maximum AI spend per calendar month across all projects. When reached, everything pauses. 0 = no limit.">
              <input className="input" type="number" min={0} step={10} value={s.monthlyLimitUsd} onChange={(e) => set("monthlyLimitUsd", Number(e.target.value))} />
            </Field>
            <Field label="Resume automatically" help="On: work resumes by itself when the day or month rolls over. Rate limits and API overloads always resume by themselves; missing credits or an invalid API key always wait for you.">
              <div className="row" style={{ height: 34 }}><Switch on={s.autoResumeLimits} onChange={(v) => set("autoResumeLimits", v)} label="Resume automatically" /><span className="small muted">{s.autoResumeLimits ? "When the period resets" : "Wait for me"}</span></div>
            </Field>
          </div>
        </div>

        </>)}

        {current.key === "system" && <SystemCheck />}


        {current.key === "users" && <UsersAccess />}

        {current.key === "team" && (<>
        <TeamConventions />

        <TeamTemplate />

        </>)}

        {current.key === "projects" && (<>
        <div className="card">
          <div className="card-head"><div className="card-title">Project defaults</div></div>
          <div className="card-pad grid g2" style={{ gap: 16 }}>
            <Field label="Parallel delivery lanes" help="Default for new projects: how many stories are built and tested at the same time." hint="Stories built/tested at the same time."><input className="input" type="number" min={1} max={8} value={s.defaultParallelism} onChange={(e) => set("defaultParallelism", Number(e.target.value))} /></Field>
            <Field label="Budget per project (USD)" help="Default budget cap for new projects. The pipeline pauses when it's reached. 0 = no limit." hint="The pipeline pauses when reached. 0 = no limit."><input className="input" type="number" min={0} value={s.defaultBudgetUsd} onChange={(e) => set("defaultBudgetUsd", Number(e.target.value))} /></Field>
            <Field label="Max QA rework loops" help="Default for new projects: after this many QA rejections a story is Blocked for you to review." hint="After this many rejections a story is Blocked for you to review."><input className="input" type="number" min={0} max={5} value={s.maxRework} onChange={(e) => set("maxRework", Number(e.target.value))} /></Field>
            <Field label="Approval gates" help="Default for new projects: pause for your approval after the backlog, after the plan and before release."><div className="row" style={{ height: 34 }}><Switch on={s.defaultGates} onChange={(v) => set("defaultGates", v)} /> <span className="small muted">Pause for your approval after backlog, plan and before release</span></div></Field>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">Human baseline & currency</div><span className="card-sub">Used for the "faster than a human team" comparison</span></div>
          <div className="card-pad grid g4" style={{ gap: 16 }}>
            <Field label="Hours per story point" help="How many hours a human team spends per story point (build + test). Used for the 'faster than a human team' comparison."><input className="input" type="number" min={1} value={s.hoursPerStoryPoint} onChange={(e) => set("hoursPerStoryPoint", Number(e.target.value))} /></Field>
            <Field label="Human rate (USD/h)" help="Blended hourly cost of a human team member, used to compare AI cost with human cost."><input className="input" type="number" min={0} value={s.humanHourlyRateUsd} onChange={(e) => set("humanHourlyRateUsd", Number(e.target.value))} /></Field>
            <Field label="Display currency" help="Currency for every cost shown in the app. Costs are recorded in USD and converted for display."><Seg value={s.currency} onChange={(v) => set("currency", v)} options={[{ value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }]} /></Field>
            <Field label="USD → EUR" help="Exchange rate used when the display currency is EUR."><input className="input" type="number" step={0.01} value={s.usdToEur} onChange={(e) => set("usdToEur", Number(e.target.value))} /></Field>
          </div>
        </div>

        </>)}

        {current.key === "pricing" && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">Model prices</div>
            <button className="btn sm ghost" onClick={async () => { await api.put("/models", []); await qc.invalidateQueries({ queryKey: ["meta"] }); setModels(null); setS(null); toast("List prices restored"); }}><RotateCcw size={13} /> Restore list prices</button>
          </div>
          <table className="table">
            <thead><tr><th>Model</th><th className="num">Input $/M</th><th className="num">Output $/M</th><th className="num">Cache read $/M</th><th className="num">Cache write $/M</th><th className="num">Speed tok/s</th></tr></thead>
            <tbody>
              {models.map((m, i) => (
                <tr key={m.id}>
                  <td><div className="strong small">{m.label}</div><div className="tiny mono faint">{m.id}</div></td>
                  {(["input", "output", "cacheRead", "cacheWrite", "tokensPerSecond"] as const).map((k) => (
                    <td key={k} className="num">
                      <Hint text={({ input: "USD per million input tokens (uncached).", output: "USD per million output tokens, including thinking.", cacheRead: "USD per million tokens read from the prompt cache — usually ~5–10% of the input price.", cacheWrite: "USD per million tokens written to the prompt cache (1.25× input for the 5-minute cache).", tokensPerSecond: "Approximate output speed, used only for time estimates and simulated pacing." } as Record<string, string>)[k]}>
                        <input className="input num" style={{ width: 90, textAlign: "right", padding: "4px 8px" }} type="number" step="0.01" value={m[k]} onChange={(e) => setPrice(i, k, e.target.value)} />
                      </Hint>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </div>
      </div>
    </div>
  );
}
