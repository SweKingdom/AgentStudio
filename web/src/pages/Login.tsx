import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, LogIn, ShieldCheck } from "lucide-react";
import siroccoLogo from "../assets/sirocco-logo.svg?raw";
import { api } from "../lib/api";
import { afterSignIn, type AuthStatus } from "../lib/auth";
import { Field } from "../components/Hint";

const MIN_PASSWORD = 10;

/** Create the first admin. Used full-page and inside Settings → Users & access. Signing in happens as part of it. */
export function SetupForm({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState("admin");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem =
    password.length > 0 && password.length < MIN_PASSWORD ? `At least ${MIN_PASSWORD} characters.` : confirm && confirm !== password ? "The two passwords don't match." : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || !password || confirm !== password) return setError(problem ?? "Type the password twice.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<AuthStatus>("/auth/setup", { username, displayName, password });
      afterSignIn(qc, { enabled: true, setupNeeded: false, user: r.user });
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="col login-form" style={{ gap: compact ? 12 : 14 }} onSubmit={submit}>
      <div className="grid g2" style={{ gap: 12 }}>
        <Field label="Username" help="What you type to sign in: 2–40 lower-case letters, digits, dot, dash or underscore.">
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required aria-label="Username" />
        </Field>
        <Field label="Display name" help="How you appear in the sidebar and in the audit log. Optional.">
          <input className="input" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Optional" aria-label="Display name" />
        </Field>
      </div>
      <Field label="Password" help={`At least ${MIN_PASSWORD} characters. It is stored only as a salted scrypt hash — nobody, including SiroccoARM, can read it back.`}>
        <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={MIN_PASSWORD} aria-label="Password" />
      </Field>
      <Field label="Repeat password" help="Type it again to rule out a typo — there's no e-mail reset, another admin has to set a new one.">
        <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required aria-label="Repeat password" />
      </Field>
      {(error || problem) && <div className="login-error" role="alert">{error ?? problem}</div>}
      <button className="btn primary login-submit" type="submit" disabled={busy}>
        {busy ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />} Create admin & turn on login
      </button>
    </form>
  );
}

function SignInForm() {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<AuthStatus>("/auth/login", { username, password });
      afterSignIn(qc, { enabled: true, setupNeeded: false, user: r.user });
    } catch (err) {
      setError((err as Error).message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="col login-form" style={{ gap: 14 }} onSubmit={submit}>
      <Field label="Username" help="The username an admin created for you in Settings → Users & access.">
        <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required aria-label="Username" />
      </Field>
      <Field label="Password" help="Forgot it? Ask an admin to set a new one for you — there's no e-mail reset.">
        <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required aria-label="Password" />
      </Field>
      {error && <div className="login-error" role="alert">{error}</div>}
      <button className="btn primary login-submit" type="submit" disabled={busy || !username || !password}>
        {busy ? <Loader2 size={15} className="spin" /> : <LogIn size={15} />} Sign in
      </button>
    </form>
  );
}

/** Full-page sign-in, or the first-run "Create the admin account" variant. */
export default function Login({ mode = "signin" }: { mode?: "signin" | "setup" }) {
  return (
    <div className="login-page">
      <div className="login-card card">
        <div className="login-brand">
          <span className="brand-logo login-logo" dangerouslySetInnerHTML={{ __html: siroccoLogo }} />
          <div className="brand-product">
            <span className="brand-name">ARM</span>
            <span className="brand-sub">Agent Relationship Management</span>
          </div>
        </div>
        <div className="col" style={{ gap: 4 }}>
          <h1 className="login-title">{mode === "setup" ? "Create the admin account" : "Sign in"}</h1>
          <p className="login-sub">
            {mode === "setup"
              ? "Once an admin exists, everyone needs to sign in. The admin then adds members and viewers in Settings → Users & access."
              : "This ARM is shared — sign in to see projects and agents."}
          </p>
        </div>
        {mode === "setup" ? <SetupForm /> : <SignInForm />}
      </div>
      <div className="login-foot">Sirocco Group · you stay signed in for 12 hours after your last activity</div>
    </div>
  );
}
