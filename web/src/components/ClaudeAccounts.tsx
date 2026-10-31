import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Loader2, LogIn, LogOut, Plus, SquareTerminal, Trash2, XCircle } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { Field, Hint } from "./Hint";
import { Switch } from "./ui";
import { t } from "../lib/i18n";

export interface AccountStatus { loggedIn: boolean; email?: string; orgName?: string; authMethod?: string; error?: string }
export interface ClaudeAccountRow {
  id: string;
  label: string;
  status: AccountStatus;
  login: { state: "waiting" | "done" | "failed"; url: string | null; error: string | null } | null;
  loginCommand: string;
}
export interface ClaudeAccounts { active: string | null; computer: AccountStatus; accounts: ClaudeAccountRow[] }

export function useClaudeAccounts() {
  return useQuery({
    queryKey: ["claude-accounts"],
    queryFn: () => api.get<ClaudeAccounts>("/claude-accounts"),
    // While a sign-in is open, watch for it to finish.
    refetchInterval: (q) => (q.state.data?.accounts.some((a) => a.login?.state === "waiting") ? 2000 : false),
  });
}

function Who({ s }: { s: AccountStatus }) {
  if (s.loggedIn)
    return (
      <span className="row small" style={{ gap: 5, color: "var(--good)" }}>
        <CheckCircle2 size={13} /> {s.email ?? t("Logged in")}{s.orgName ? <span className="faint">· {s.orgName}</span> : null}
      </span>
    );
  return (
    <span className="row small" style={{ gap: 5, color: "var(--bad)" }}>
      <XCircle size={13} /> {s.error ?? t("Not logged in")}
    </span>
  );
}

/** Settings → Claude account: which Claude login live agents use on the plan backend. */
export function ClaudeAccountsSettings() {
  const qc = useQueryClient();
  const { data, isLoading } = useClaudeAccounts();
  const [label, setLabel] = useState("");
  const [sso, setSso] = useState(false);
  const [email, setEmail] = useState("");
  const call = useMutation({
    mutationFn: (o: { method: "post" | "put" | "del"; path: string; body?: unknown }) =>
      o.method === "del" ? api.del<ClaudeAccounts>(o.path) : o.method === "put" ? api.put<ClaudeAccounts>(o.path, o.body) : api.post<ClaudeAccounts>(o.path, o.body),
    onSuccess: (d) => qc.setQueryData(["claude-accounts"], d),
    onError: (e: Error) => toast(e.message, "bad"),
  });
  if (isLoading || !data) return <div className="card card-pad small muted"><Loader2 size={13} className="spin" /> {t("Reading the Claude logins…")}</div>;

  const add = () => {
    if (!label.trim()) return;
    call.mutate({ method: "post", path: "/claude-accounts", body: { label } }, { onSuccess: (d) => { qc.setQueryData(["claude-accounts"], d); setLabel(""); } });
  };
  const radio = (id: string | null) => (
    <input type="radio" name="claude-account" checked={data.active === id} onChange={() => call.mutate({ method: "put", path: "/claude-accounts/active", body: { id } })} aria-label={t("Use for live agents")} />
  );

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{t("Claude account")}</div>
            <div className="card-sub">{t("Which Claude login live agents use on the plan backend. Each account is its own sign-in, kept apart from Claude Code in your terminal. AgentStudio never stores a token: the login stays in Claude's own files under data/claude-accounts. A project can use another account in its own settings.")}</div>
          </div>
        </div>
        <div className="col" style={{ gap: 0 }}>
          <label className="row card-pad" style={{ gap: 12, borderBottom: "1px solid var(--line)", cursor: "pointer" }}>
            {radio(null)}
            <div className="col" style={{ gap: 3, flex: 1, minWidth: 0 }}>
              <span className="strong small">{t("This computer's login")}</span>
              <span className="tiny muted">{t("The account claude uses in a terminal on this computer (claude auth login).")}</span>
            </div>
            <Who s={data.computer} />
          </label>
          {data.accounts.map((a) => (
            <div key={a.id} className="card-pad col" style={{ gap: 8, borderBottom: "1px solid var(--line)" }}>
              <label className="row" style={{ gap: 12, cursor: "pointer" }}>
                {radio(a.id)}
                <div className="col" style={{ gap: 3, flex: 1, minWidth: 0 }}>
                  <span className="strong small">{a.label}</span>
                  <span className="tiny faint mono ellipsis">data/claude-accounts/{a.id}</span>
                </div>
                <Who s={a.status} />
              </label>
              <div className="row wrap" style={{ gap: 8, paddingLeft: 26 }}>
                {!a.status.loggedIn && a.login?.state !== "waiting" && (
                  <Hint text={t("Opens your browser to sign in to Claude. Pick the organisation (for example your Team) on the sign-in page.")}>
                    <button className="btn sm primary" disabled={call.isPending} onClick={() => call.mutate({ method: "post", path: `/claude-accounts/${a.id}/login`, body: { sso, email } })}><LogIn size={13} /> {t("Sign in")}</button>
                  </Hint>
                )}
                {a.login?.state === "waiting" && (
                  <>
                    <span className="row small" style={{ gap: 6 }}><Loader2 size={13} className="spin" /> {t("Waiting for the sign-in in your browser…")}</span>
                    {a.login.url && <a className="btn sm" href={a.login.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> {t("Open the sign-in page")}</a>}
                    <button className="btn sm ghost" onClick={() => call.mutate({ method: "del", path: `/claude-accounts/${a.id}/login` })}>{t("Cancel")}</button>
                  </>
                )}
                {!a.status.loggedIn && (
                  <Hint text={`${t("Signs in from a terminal window, where you can paste the code the sign-in page shows. Or run it yourself:")} ${a.loginCommand}`}>
                    <button className="btn sm ghost" disabled={call.isPending} onClick={() => call.mutate({ method: "post", path: `/claude-accounts/${a.id}/login/terminal` })}><SquareTerminal size={13} /> {t("Sign in from a terminal")}</button>
                  </Hint>
                )}
                {a.status.loggedIn && (
                  <button className="btn sm ghost" disabled={call.isPending} onClick={() => call.mutate({ method: "post", path: `/claude-accounts/${a.id}/logout` })}><LogOut size={13} /> {t("Log out")}</button>
                )}
                <button className="btn sm ghost danger" disabled={call.isPending} onClick={() => confirm(t("Remove this account and its sign-in from AgentStudio?")) && call.mutate({ method: "del", path: `/claude-accounts/${a.id}` })}><Trash2 size={13} /> {t("Remove")}</button>
              </div>
              {a.login?.state === "failed" && <div className="small" style={{ color: "var(--bad)", paddingLeft: 26 }}>{a.login.error} — {t("try Sign in from a terminal.")}</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div className="card-title">{t("Add an account")}</div></div>
        <div className="card-pad col" style={{ gap: 12 }}>
          <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
            <Field label={t("Name")} help={t("Your own name for it, e.g. Work or Private.")}>
              <input className="input" style={{ width: 220 }} value={label} placeholder={t("Work")} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
            </Field>
            <button className="btn primary" disabled={!label.trim() || call.isPending} onClick={add}><Plus size={14} /> {t("Add account")}</button>
          </div>
          <div className="row wrap" style={{ gap: 16 }}>
            <Field label={t("Email for the sign-in page (optional)")} help={t("Filled in on Claude's sign-in page for you.")}>
              <input className="input" style={{ width: 260 }} value={email} placeholder="name@company.com" onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label={t("Single sign-on")} help={t("For a Team or Enterprise organisation that signs in through your company's SSO.")}>
              <Switch on={sso} onChange={setSso} label={t("Sign in with SSO")} />
            </Field>
          </div>
          <div className="tiny muted">{t("After adding it, press Sign in on the account and choose it as the one live agents use. Check that your organisation allows its Claude account to be used for this: AgentStudio sends the project's requirements and code to Claude.")}</div>
        </div>
      </div>
    </>
  );
}
