import crypto from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { all, get, insert, now, run, uid } from "./db.js";

/**
 * Optional sign-in for the ARM. Off until the first admin account exists, so a single-user localhost setup keeps working
 * with no login. Once any user exists every /api request (the live event stream included) needs a session cookie.
 * Passwords are scrypt hashes with a per-user salt; session tokens are random and only their SHA-256 is stored, so a copy
 * of the database can't be used to sign in.
 */

export type UserRole = "admin" | "member" | "viewer";
export const USER_ROLES: UserRole[] = ["admin", "member", "viewer"];

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
}

interface UserRow extends Omit<User, "disabled"> {
  disabled: number;
  password_hash: string;
}

export const SESSION_COOKIE = "arm_session";
export const SESSION_TTL_MS = 12 * 60 * 60_000;
/** Only push the expiry forward (a DB write + a new cookie) when it has drifted this much — not on every request. */
const SLIDE_AFTER_MS = 60_000;
export const MIN_PASSWORD_LENGTH = 10;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 10 * 60_000;

// ---------------------------------------------------------------- passwords

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** `scrypt$N$r$p$salt$hash` — the parameters travel with the hash so they can be raised later without breaking old ones. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Hash of a password nobody has: verifying against it keeps "unknown user" as slow as "wrong password". */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string) {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString("hex"));
  await verifyPassword(password, await dummyHash);
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) return `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 256) return "Passwords can't be longer than 256 characters.";
  return null;
}

// ---------------------------------------------------------------- users

const USER_COLUMNS = "id, username, display_name, role, disabled, created_at, last_login_at";

/** Users never leave this module with their password hash. */
function toUser(row: Omit<UserRow, "password_hash">): User {
  return { ...row, disabled: !!row.disabled };
}

export function normalizeUsername(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

export function usernameProblem(username: string): string | null {
  return /^[a-z0-9][a-z0-9._-]{1,39}$/.test(username) ? null : "Usernames are 2–40 characters: letters, digits, dot, dash or underscore.";
}

export function listUsers(): User[] {
  return all<UserRow>(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at`).map(toUser);
}

export function getUser(id: string): User | null {
  const row = get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, id);
  return row ? toUser(row) : null;
}

export function findUserForLogin(username: string): UserRow | undefined {
  return get<UserRow>("SELECT * FROM users WHERE username = ?", username);
}

/** Login is on as soon as any user exists. */
export function authEnabled(): boolean {
  return !!get("SELECT 1 AS x FROM users LIMIT 1");
}

export function activeAdminCount(): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")?.n ?? 0;
}

export interface NewUser { username: string; displayName?: unknown; role: UserRole }

/** Synchronous insert of an already-hashed password, so a caller can check-then-insert with no await in between. */
export function insertUser(input: NewUser, passwordHash: string): User {
  const id = uid("usr");
  insert("users", {
    id,
    username: input.username,
    display_name: String(input.displayName ?? "").trim().slice(0, 80) || input.username,
    password_hash: passwordHash,
    role: input.role,
    disabled: 0,
    created_at: now(),
  });
  return getUser(id)!;
}

export async function createUser(input: NewUser & { password: string }): Promise<User> {
  return insertUser(input, await hashPassword(input.password));
}

export async function setPassword(userId: string, password: string) {
  run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(password), userId);
}

// ---------------------------------------------------------------- sessions

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookieFlags(req: Request) {
  // Secure only over https: the ARM normally runs on plain http://127.0.0.1, where a Secure cookie would never be sent.
  return `HttpOnly; SameSite=Strict; Path=/${req.secure ? "; Secure" : ""}`;
}

function setSessionCookie(req: Request, res: Response, token: string) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=${token}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; ${cookieFlags(req)}`);
}

export function clearSessionCookie(req: Request, res: Response) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; Max-Age=0; ${cookieFlags(req)}`);
}

/** Starts a session and sets its cookie. The raw token exists only in the cookie. */
export function startSession(req: Request, res: Response, userId: string) {
  run("DELETE FROM sessions WHERE expires_at < ?", now());
  const token = crypto.randomBytes(32).toString("base64url");
  const t = Date.now();
  insert("sessions", { token_hash: sha256(token), user_id: userId, created_at: new Date(t).toISOString(), expires_at: new Date(t + SESSION_TTL_MS).toISOString() });
  setSessionCookie(req, res, token);
}

export function endSession(req: Request, res: Response) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
  clearSessionCookie(req, res);
}

/** Signs a user out everywhere (password reset, disable), optionally keeping the session making the request. */
export function endUserSessions(userId: string, keep?: Request) {
  const token = keep ? readCookie(keep, SESSION_COOKIE) : null;
  run("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", userId, token ? sha256(token) : "");
}

const resolved = new WeakMap<Request, User | null>();

/** The signed-in user for this request, or null (no session, or login is off). */
export function currentUser(req: Request): User | null {
  return resolved.get(req) ?? null;
}

/** Looks up the session cookie, sliding its 12 h expiry forward on use. */
function resolveSession(req: Request, res: Response): User | null {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const hash = sha256(token);
  const row = get<UserRow & { expires_at: string }>(
    `SELECT ${USER_COLUMNS.split(", ").map((c) => `u.${c}`).join(", ")}, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    hash,
  );
  if (!row) return null;
  const expires = Date.parse(row.expires_at);
  if (!(expires > Date.now()) || row.disabled) {
    run("DELETE FROM sessions WHERE token_hash = ?", hash);
    return null;
  }
  if (Date.now() + SESSION_TTL_MS - expires > SLIDE_AFTER_MS) {
    run("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", new Date(Date.now() + SESSION_TTL_MS).toISOString(), hash);
    setSessionCookie(req, res, token);
  }
  const { expires_at: _e, ...user } = row;
  return toUser(user);
}

// ---------------------------------------------------------------- roles

const WRITE = /^(POST|PUT|PATCH|DELETE)$/;

/** App-wide configuration a member may read but not change. `/auth/users` and `/audit` check for admin themselves. */
const ADMIN_ONLY: { method: RegExp; path: RegExp }[] = [
  { method: /^PUT$/, path: /^\/(settings|models|team)\/?$/i },
  { method: /^POST$/, path: /^\/team\/import\/?$/i },
  { method: WRITE, path: /^\/system(\/|$)/i },
  { method: WRITE, path: /^\/claude-accounts(\/|$)/i },
  { method: /./, path: /^\/audit(\/|$)/i },
];

export function roleAllows(role: UserRole, method: string, path: string): boolean {
  if (role === "admin") return true;
  if (role === "viewer") return method === "GET" || method === "HEAD" || method === "OPTIONS";
  return !ADMIN_ONLY.some((r) => r.method.test(method) && r.path.test(path));
}

/**
 * Mounted on /api before the router. When login is on, everything outside /api/auth/* needs a session and a role that
 * allows the request. /api/auth/* resolves the user too but decides for itself (login and setup must work signed out).
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled()) {
    resolved.set(req, null);
    return next();
  }
  const user = resolveSession(req, res);
  resolved.set(req, user);
  if (/^\/auth(\/|$)/i.test(req.path)) return next();
  if (!user) return res.status(401).json({ error: "Sign in required", auth: true });
  if (!roleAllows(user.role, req.method, req.path)) {
    return res.status(403).json({ error: user.role === "viewer" ? "Viewers can look but not change anything." : "Only an admin can change this." });
  }
  next();
}

/** For routes that need a specific role even when the middleware let the request through (the /auth/* routes). */
export function requireRole(req: Request, res: Response, role: UserRole): User | null {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ error: "Sign in required", auth: true });
    return null;
  }
  if (role === "admin" && user.role !== "admin") {
    res.status(403).json({ error: "Only an admin can do this." });
    return null;
  }
  return user;
}

// ---------------------------------------------------------------- login rate limit

const failures = new Map<string, number[]>();

function recentFailures(username: string) {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  const list = (failures.get(username) ?? []).filter((t) => t > cutoff);
  if (list.length) failures.set(username, list);
  else failures.delete(username);
  return list;
}

/** Seconds until this username may try again, or 0. Counted per username so one locked account doesn't lock others. */
export function loginLockedFor(username: string): number {
  const list = recentFailures(username);
  if (list.length < LOGIN_MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((list[list.length - LOGIN_MAX_FAILURES] + LOGIN_WINDOW_MS - Date.now()) / 1000));
}

export function recordLoginFailure(username: string) {
  failures.set(username, [...recentFailures(username), Date.now()]);
}

export function clearLoginFailures(username: string) {
  failures.delete(username);
}

// ---------------------------------------------------------------- audit trail

export interface AuditEntry { id: number; user_id: string | null; username: string | null; action: string; target: string | null; detail: string | null; created_at: string }

/**
 * Records who did what. Never pass secrets in `detail` — it is shown to admins as is.
 */
export function audit(req: Request | null, action: string, target?: string | null, detail?: unknown) {
  auditAs(req ? currentUser(req) : null, action, target, detail);
}

/** Audit with an explicit actor — for login and setup, where the request started signed out. */
export function auditAs(user: Pick<User, "id" | "username"> | null, action: string, target?: string | null, detail?: unknown) {
  insert("audit", {
    user_id: user?.id ?? null,
    // No user: "local" while login is off (whoever uses this computer); anonymous (null) once it's on, e.g. a failed sign-in.
    username: user?.username ?? (authEnabled() ? null : "local"),
    action,
    target: target ?? null,
    detail: detail === undefined || detail === null ? null : typeof detail === "string" ? detail : JSON.stringify(detail),
    created_at: now(),
  });
}

export function listAudit(limit = 200): AuditEntry[] {
  const n = Math.min(Math.max(Math.floor(Number(limit)) || 200, 1), 1000);
  return all<AuditEntry>("SELECT * FROM audit ORDER BY id DESC LIMIT ?", n);
}
