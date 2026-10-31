/**
 * Claude accounts for the plan backend. Each account is a `claude` login kept in its own folder (CLAUDE_CONFIG_DIR)
 * under data/claude-accounts, so AgentStudio can run on a work account while Claude Code in the terminal keeps its own
 * login. AgentStudio never stores a token: the login lives in Claude's own files; AgentStudio only picks the folder.
 * "This computer's login" (no folder) stays the default.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR, getSetting, setSetting } from "./db.js";
import type { Project } from "./store.js";

const pexec = promisify(execFile);

export const ACCOUNTS_DIR = path.join(DATA_DIR, "claude-accounts");

export interface ClaudeAccount {
  id: string;
  label: string;
}

interface Stored {
  accounts: ClaudeAccount[];
  /** The account live agents use; null = this computer's own `claude` login. */
  active: string | null;
}

export interface AccountStatus {
  loggedIn: boolean;
  email?: string;
  orgName?: string;
  authMethod?: string;
  /** Why the status couldn't be read (claude missing, timeout). */
  error?: string;
}

const stored = (): Stored => ({ accounts: [], active: null, ...getSetting<Partial<Stored>>("claudeAccounts", {}) });
const save = (s: Stored) => setSetting("claudeAccounts", s);

export const accountDir = (id: string) => path.join(ACCOUNTS_DIR, id);

export function listAccounts() {
  return stored();
}

export function addAccount(label: string): ClaudeAccount {
  const name = label.trim();
  if (!name || name.length > 60) throw new Error("Give the account a name of at most 60 characters.");
  const s = stored();
  if (s.accounts.some((a) => a.label.toLowerCase() === name.toLowerCase())) throw new Error(`There is already an account called "${name}".`);
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "account";
  let id = base;
  for (let n = 2; s.accounts.some((a) => a.id === id); n++) id = `${base}-${n}`;
  fs.mkdirSync(accountDir(id), { recursive: true });
  const account = { id, label: name };
  save({ ...s, accounts: [...s.accounts, account] });
  return account;
}

export function setActiveAccount(id: string | null) {
  const s = stored();
  if (id !== null && !s.accounts.some((a) => a.id === id)) throw new Error("Unknown Claude account.");
  save({ ...s, active: id });
}

export async function removeAccount(id: string) {
  const s = stored();
  if (!s.accounts.some((a) => a.id === id)) throw new Error("Unknown Claude account.");
  cancelLogin(id);
  await claude(["auth", "logout"], id).catch(() => undefined);
  fs.rmSync(accountDir(id), { recursive: true, force: true });
  save({ accounts: s.accounts.filter((a) => a.id !== id), active: s.active === id ? null : s.active });
}

/** The CLAUDE_CONFIG_DIR a run uses: the project's own account, else the active one; undefined = this computer's login. */
export function claudeConfigDir(project?: Pick<Project, "settings"> | null): string | undefined {
  const s = stored();
  const own = project?.settings.claudeAccount;
  const id = own && s.accounts.some((a) => a.id === own) ? own : s.active;
  return id && s.accounts.some((a) => a.id === id) ? accountDir(id) : undefined;
}

/** The environment for a `claude` process on an account: the plan login, never an API key (it would win and bill it). */
export function claudeEnv(configDir?: string) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

async function claude(args: string[], id: string | null, timeout = 15_000) {
  const { stdout } = await pexec("claude", args, { env: claudeEnv(id ? accountDir(id) : undefined), timeout, windowsHide: true });
  return stdout;
}

export async function accountStatus(id: string | null): Promise<AccountStatus> {
  try {
    const s = JSON.parse(await claude(["auth", "status"], id)) as AccountStatus;
    return { loggedIn: Boolean(s.loggedIn), email: s.email, orgName: s.orgName, authMethod: s.authMethod };
  } catch (e) {
    const x = e as { code?: string; stdout?: string; message?: string };
    // `claude auth status` exits non-zero when logged out but still prints its JSON.
    try {
      const s = JSON.parse(x.stdout ?? "") as AccountStatus;
      return { loggedIn: Boolean(s.loggedIn), email: s.email, orgName: s.orgName, authMethod: s.authMethod };
    } catch {
      return { loggedIn: false, error: x.code === "ENOENT" ? "Claude Code (claude) is not installed." : (x.message ?? String(e)).split("\n")[0] };
    }
  }
}

export async function logoutAccount(id: string) {
  if (!stored().accounts.some((a) => a.id === id)) throw new Error("Unknown Claude account.");
  cancelLogin(id);
  await claude(["auth", "logout"], id);
}

// ---------------------------------------------------------------- login

/** A sign-in in progress: `claude auth login` opens the browser; AgentStudio watches the account until it's logged in. */
interface LoginSession {
  child: ChildProcess;
  url: string | null;
  output: string;
  startedAt: number;
  state: "waiting" | "done" | "failed";
  error?: string;
  timer: NodeJS.Timeout;
}

const logins = new Map<string, LoginSession>();
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** For tests: the command that signs in (the real `claude`, or a stand-in). */
let loginCommand = { cmd: "claude", args: ["auth", "login"] };
export function setLoginCommandForTests(c: { cmd: string; args: string[] } | null) {
  loginCommand = c ?? { cmd: "claude", args: ["auth", "login"] };
}

export function startLogin(id: string, o: { sso?: boolean; email?: string } = {}) {
  if (!stored().accounts.some((a) => a.id === id)) throw new Error("Unknown Claude account.");
  cancelLogin(id);
  fs.mkdirSync(accountDir(id), { recursive: true });
  const args = [...loginCommand.args, ...(o.sso ? ["--sso"] : []), ...(o.email?.trim() ? ["--email", o.email.trim()] : [])];
  const child = spawn(loginCommand.cmd, args, { env: claudeEnv(accountDir(id)), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const session: LoginSession = { child, url: null, output: "", startedAt: Date.now(), state: "waiting", timer: setInterval(() => void poll(id), 2000) };
  const take = (d: Buffer) => {
    session.output = (session.output + d.toString()).slice(-4000);
    session.url ??= session.output.match(/https:\/\/\S+/)?.[0] ?? null;
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  child.on("error", (e) => finish(id, "failed", (e as NodeJS.ErrnoException).code === "ENOENT" ? "Claude Code (claude) is not installed." : e.message));
  child.on("exit", () => void poll(id, true));
  logins.set(id, session);
  return loginState(id);
}

async function poll(id: string, exited = false) {
  const s = logins.get(id);
  if (!s || s.state !== "waiting") return;
  const status = await accountStatus(id);
  if (logins.get(id) !== s || s.state !== "waiting") return;
  if (status.loggedIn) return finish(id, "done");
  if (Date.now() - s.startedAt > LOGIN_TIMEOUT_MS) return finish(id, "failed", "The sign-in wasn't finished within 10 minutes.");
  if (exited) finish(id, "failed", lastLine(s.output) || "The sign-in stopped before it was finished.");
}

function finish(id: string, state: "done" | "failed", error?: string) {
  const s = logins.get(id);
  if (!s) return;
  clearInterval(s.timer);
  s.state = state;
  s.error = error;
  if (s.child.exitCode === null) s.child.kill();
}

export function cancelLogin(id: string) {
  const s = logins.get(id);
  if (!s) return;
  clearInterval(s.timer);
  if (s.child.exitCode === null) s.child.kill();
  logins.delete(id);
}

export function loginState(id: string) {
  const s = logins.get(id);
  if (!s) return null;
  return { state: s.state, url: s.url, error: s.error ?? null };
}

const lastLine = (s: string) => s.trim().split("\n").filter((l) => !/^https?:\/\//.test(l.trim())).pop()?.trim() ?? "";

/** The command that signs in to this account from a terminal (where pasting a code always works). */
export function loginCommandFor(id: string) {
  const dir = accountDir(id);
  return process.platform === "win32" ? `$env:CLAUDE_CONFIG_DIR="${dir}"; claude auth login` : `CLAUDE_CONFIG_DIR="${dir}" claude auth login`;
}

/** Opens a terminal window that signs in to this account. Returns false when this platform has no known terminal. */
export function openLoginTerminal(id: string): boolean {
  if (!stored().accounts.some((a) => a.id === id)) throw new Error("Unknown Claude account.");
  const dir = accountDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const env = claudeEnv(dir);
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "Claude login", "cmd.exe", "/k", "claude auth login"], { env, detached: true, stdio: "ignore", windowsHide: false }).unref();
    return true;
  }
  if (process.platform === "darwin") {
    const script = `tell application "Terminal" to do script "export CLAUDE_CONFIG_DIR='${dir.replace(/'/g, "")}'; claude auth login"`;
    spawn("osascript", ["-e", script, "-e", 'tell application "Terminal" to activate'], { detached: true, stdio: "ignore" }).unref();
    return true;
  }
  return false;
}
