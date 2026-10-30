import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, Plus, ScrollText, ShieldCheck, Trash2, UserPlus, Users as UsersIcon } from "lucide-react";
import { api } from "../lib/api";
import { ROLE_INFO, signOut, useAuth, type AuditEntry, type AuthUser, type UserRole } from "../lib/auth";
import { ago, dateTime } from "../lib/format";
import { toast } from "../lib/toast";
import { Field, Hint } from "./Hint";
import { Empty, Modal, Seg, Switch } from "./ui";
import { SetupForm } from "../pages/Login";

const MIN_PASSWORD = 10;
const ROLE_OPTIONS = (Object.keys(ROLE_INFO) as UserRole[]).map((r) => ({ value: r, label: ROLE_INFO[r].label }));

/** Signed-in user + Sign out, for the sidebar footer. Renders nothing while login is off. */
export function SidebarUser() {
  const { data } = useAuth();
  const qc = useQueryClient();
  const user = data?.user;
  if (!data?.enabled || !user) return null;
  const name = user.display_name || user.username;
  return (
    <div className="row sidebar-user">
      <span className="user-initial" aria-hidden>{name.slice(0, 1).toUpperCase()}</span>
      <span className="col" style={{ gap: 0, minWidth: 0, flex: 1 }}>
        <span className="ellipsis" style={{ color: "var(--text)" }} title={user.username}>{name}</span>
        <span className="tiny faint">{ROLE_INFO[user.role].label}</span>
      </span>
      <button className="btn ghost sm icon" onClick={() => void signOut(qc)} title="Sign out" aria-label="Sign out">
        <LogOut size={14} />
      </button>
    </div>
  );
}

/** Settings → Users & access. Turning login on, managing users (admin), changing your password, and the audit log. */
export function UsersAccess() {
  const { data: status } = useAuth();
  const [setup, setSetup] = useState(false);
  if (!status) return null;
  if (!status.enabled) {
    return (
      <div className="card">
        <div className="card-head"><div className="card-title"><ShieldCheck size={15} /> Login is off</div></div>
        <div className="card-pad col" style={{ gap: 12 }}>
          <div className="small" style={{ lineHeight: 1.6, maxWidth: 720 }}>
            Right now anyone who can open this AgentStudio can use it — fine while it only listens on this computer. Turn on login when several
            people share it: you create the first <b>admin</b>, then add <b>members</b> (run projects) and <b>viewers</b> (read-only).
            Every important change — deleting a project, approving a gate, changing settings or the team — is recorded in an audit log.
          </div>
          <div className="small muted" style={{ maxWidth: 720 }}>
            Passwords are stored only as salted hashes and sessions end after 12 hours without activity. This doesn't affect git
            or Claude — they keep using this machine's own logins.
          </div>
          <div><button className="btn primary" onClick={() => setSetup(true)}><ShieldCheck size={14} /> Create admin & turn on login</button></div>
        </div>
        {setup && (
          <Modal onClose={() => setSetup(false)} title="Create the admin account">
            <SetupForm compact onDone={() => { setSetup(false); toast("Login is on — you're signed in as admin"); }} />
          </Modal>
        )}
      </div>
    );
  }
  const me = status.user;
  return (
    <>
      {me?.role === "admin" ? <UserList me={me} /> : (
        <div className="banner info">Only an admin can add users or change roles. You're signed in as <b>{me?.display_name || me?.username}</b> ({me ? ROLE_INFO[me.role].label : "—"}).</div>
      )}
      <OwnPassword />
      {me?.role === "admin" && <AuditLog />}
    </>
  );
}

function UserList({ me }: { me: AuthUser }) {
  const qc = useQueryClient();
  const { data: users } = useQuery({ queryKey: ["auth-users"], queryFn: () => api.get<AuthUser[]>("/auth/users") });
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<AuthUser | null>(null);
  const [deleting, setDeleting] = useState<AuthUser | null>(null);
  const done = () => {
    qc.invalidateQueries({ queryKey: ["auth-users"] });
    qc.invalidateQueries({ queryKey: ["audit"] });
    qc.invalidateQueries({ queryKey: ["auth"] });
  };
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch<AuthUser>(`/auth/users/${id}`, body),
    onSuccess: done,
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title"><UsersIcon size={15} /> Users</div>
        <Hint text="Create an account for someone. You choose their first password and tell them; they can change it afterwards.">
          <button className="btn sm" onClick={() => setAdding(true)}><UserPlus size={13} /> Add user</button>
        </Hint>
      </div>
      {!users ? <div className="card-pad muted small">Loading…</div> : (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr><th>User</th><th>Role</th><th>Last sign-in</th><th>Active</th><th /></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={u.disabled ? { opacity: 0.55 } : undefined}>
                  <td>
                    <div className="col" style={{ gap: 0 }}>
                      <span>{u.display_name || u.username}{u.id === me.id && <span className="tiny faint"> · you</span>}</span>
                      <span className="mono tiny faint">{u.username}</span>
                    </div>
                  </td>
                  <td>
                    <Hint text={`${ROLE_INFO[u.role].label}: ${ROLE_INFO[u.role].help}`}>
                      <span><Seg value={u.role} options={ROLE_OPTIONS} onChange={(role) => patch.mutate({ id: u.id, body: { role } })} /></span>
                    </Hint>
                  </td>
                  <td className="small muted nowrap" title={u.last_login_at ? dateTime(u.last_login_at) : undefined}>{u.last_login_at ? ago(u.last_login_at) : "Never"}</td>
                  <td>
                    <Hint text={u.id === me.id ? "You can't disable your own account." : u.disabled ? "Disabled: can't sign in. Turn on to allow it again." : "Turn off to block sign-in and end their sessions, without deleting the account."}>
                      <span><Switch on={!u.disabled} label={`${u.username} active`} onChange={(on) => u.id !== me.id && patch.mutate({ id: u.id, body: { disabled: !on } })} /></span>
                    </Hint>
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end", gap: 4 }}>
                      <Hint text="Set a new password for this user (they're signed out everywhere). Nothing is e-mailed — tell them yourself.">
                        <button className="btn ghost sm" onClick={() => setResetting(u)}><KeyRound size={13} /> Reset password</button>
                      </Hint>
                      {u.id !== me.id && (
                        <Hint text="Delete the account. Their past actions stay in the audit log.">
                          <button className="btn ghost sm icon danger" aria-label={`Delete ${u.username}`} onClick={() => setDeleting(u)}><Trash2 size={13} /></button>
                        </Hint>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddUserModal onClose={() => setAdding(false)} onDone={done} />}
      {resetting && <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} onDone={done} />}
      {deleting && <DeleteUserModal user={deleting} onClose={() => setDeleting(null)} onDone={done} />}
    </div>
  );
}

function AddUserModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [password, setPassword] = useState("");
  const add = useMutation({
    mutationFn: () => api.post<AuthUser>("/auth/users", { username, displayName, role, password }),
    onSuccess: (u) => { onDone(); toast(`${u.username} added`); onClose(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  const short = password.length > 0 && password.length < MIN_PASSWORD;
  return (
    <Modal
      onClose={onClose}
      title="Add user"
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" form="add-user" type="submit" disabled={add.isPending || !username || password.length < MIN_PASSWORD}><Plus size={14} /> Add user</button></>}
    >
      <form id="add-user" className="col" style={{ gap: 12 }} onSubmit={submit}>
        <div className="grid g2" style={{ gap: 12 }}>
          <Field label="Username" help="What they type to sign in: 2–40 lower-case letters, digits, dot, dash or underscore.">
            <input className="input" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </Field>
          <Field label="Display name" help="Shown in the sidebar and the audit log. Optional.">
            <input className="input" autoComplete="off" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
        <Field label="Role" help={<>{ROLE_OPTIONS.map((o) => <div key={o.value}><b>{o.label}</b> — {ROLE_INFO[o.value].help}</div>)}</>}>
          <span><Seg value={role} options={ROLE_OPTIONS} onChange={setRole} /></span>
        </Field>
        <Field label="First password" help={`At least ${MIN_PASSWORD} characters. Tell them yourself; they can change it in Settings → Users & access.`} hint={short ? `At least ${MIN_PASSWORD} characters.` : undefined}>
          <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose, onDone }: { user: AuthUser; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const reset = useMutation({
    mutationFn: () => api.patch(`/auth/users/${user.id}`, { password }),
    onSuccess: () => { onDone(); toast(`New password set for ${user.username}`); onClose(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <Modal
      onClose={onClose}
      title={`Reset password · ${user.username}`}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={reset.isPending || password.length < MIN_PASSWORD} onClick={() => reset.mutate()}><KeyRound size={14} /> Set new password</button></>}
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="small muted">The old password can't be shown — it's never stored. Choose a new one and tell {user.display_name || user.username}; they're signed out everywhere.</div>
        <Field label="New password" help={`At least ${MIN_PASSWORD} characters.`}>
          <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
      </div>
    </Modal>
  );
}

function DeleteUserModal({ user, onClose, onDone }: { user: AuthUser; onClose: () => void; onDone: () => void }) {
  const del = useMutation({
    mutationFn: () => api.del(`/auth/users/${user.id}`),
    onSuccess: () => { onDone(); toast(`${user.username} deleted`); onClose(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <Modal
      onClose={onClose}
      title={`Delete ${user.username}?`}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={del.isPending} onClick={() => del.mutate()}><Trash2 size={14} /> Delete user</button></>}
    >
      <div className="small">They can't sign in any more. Projects and work they touched stay as they are, and their entries remain in the audit log. To block them temporarily, turn the account off instead.</div>
    </Modal>
  );
}

function OwnPassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => api.post("/auth/password", { currentPassword: current, newPassword: next }),
    onSuccess: () => { setCurrent(""); setNext(""); toast("Password changed — other sessions were signed out"); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <div className="card">
      <div className="card-head"><div className="card-title"><KeyRound size={15} /> Your password</div></div>
      <form className="card-pad grid g2" style={{ gap: 12, alignItems: "end" }} onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
        <Field label="Current password" help="Proves it's you before the password changes.">
          <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" help={`At least ${MIN_PASSWORD} characters. Your other browsers are signed out; this one stays signed in.`}>
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <div><button className="btn" type="submit" disabled={change.isPending || !current || next.length < MIN_PASSWORD}>Change password</button></div>
      </form>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "auth.setup": "Turned on login",
  login: "Signed in",
  "login.failed": "Failed sign-in",
  logout: "Signed out",
  "password.change": "Changed own password",
  "user.create": "Added user",
  "user.update": "Changed user",
  "user.password_reset": "Reset password",
  "user.delete": "Deleted user",
};

function detailText(detail: string | null) {
  if (!detail) return "";
  try {
    const v = JSON.parse(detail);
    if (v && typeof v === "object") return Object.entries(v).map(([k, x]) => `${k}: ${typeof x === "object" ? JSON.stringify(x) : String(x)}`).join(" · ");
    return String(v);
  } catch {
    return detail;
  }
}

function AuditLog() {
  const [limit, setLimit] = useState<"50" | "200" | "1000">("200");
  const { data } = useQuery({ queryKey: ["audit", limit], queryFn: () => api.get<AuditEntry[]>(`/audit?limit=${limit}`), refetchInterval: 30_000 });
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title"><ScrollText size={15} /> Audit log</div>
        <Hint text="How many of the most recent entries to show.">
          <span><Seg value={limit} options={[{ value: "50", label: "50" }, { value: "200", label: "200" }, { value: "1000", label: "1000" }]} onChange={setLimit} /></span>
        </Hint>
      </div>
      {!data ? <div className="card-pad muted small">Loading…</div> : !data.length ? (
        <Empty icon={<ScrollText size={20} />} title="Nothing recorded yet">Sign-ins, user changes, deleted projects, approved gates and settings changes appear here.</Empty>
      ) : (
        <div style={{ overflowX: "auto", maxHeight: 460 }}>
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Target</th><th>Detail</th></tr></thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td className="small muted nowrap" title={dateTime(a.created_at)}>{ago(a.created_at)}</td>
                  <td className="small">{a.username ?? "—"}</td>
                  <td className="small" style={a.action === "login.failed" ? { color: "var(--warn)" } : undefined}>{ACTION_LABEL[a.action] ?? a.action}</td>
                  <td className="small mono">{a.target ?? ""}</td>
                  <td className="small muted" style={{ maxWidth: 360, wordBreak: "break-word" }}>{detailText(a.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
