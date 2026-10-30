import type { NextFunction, Request, Response, Router } from "express";
import {
  USER_ROLES,
  activeAdminCount,
  audit,
  auditAs,
  authEnabled,
  burnPasswordCheck,
  clearLoginFailures,
  createUser,
  currentUser,
  endSession,
  endUserSessions,
  findUserForLogin,
  getUser,
  hashPassword,
  insertUser,
  listAudit,
  listUsers,
  loginLockedFor,
  normalizeUsername,
  passwordProblem,
  recordLoginFailure,
  requireRole,
  setPassword,
  startSession,
  usernameProblem,
  verifyPassword,
  type UserRole,
} from "../auth.js";
import { now, run, update } from "../db.js";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

const isRole = (v: unknown): v is UserRole => USER_ROLES.includes(v as UserRole);

/** Would this change leave nobody able to manage users? */
const isLastActiveAdmin = (id: string) => {
  const u = getUser(id);
  return !!u && u.role === "admin" && !u.disabled && activeAdminCount() <= 1;
};

/** Sign-in, first-run setup, user management and the audit log. Passwords are never returned or logged. */
export function registerAuth(api: Router) {
  api.get("/auth/status", (req, res) => {
    const enabled = authEnabled();
    res.json({ enabled, setupNeeded: !enabled, user: currentUser(req) });
  });

  /** Creates the first admin and turns login on. Only possible while no user exists. */
  api.post(
    "/auth/setup",
    wrap(async (req, res) => {
      if (authEnabled()) return res.status(409).json({ error: "Login is already set up — sign in instead." });
      const username = normalizeUsername(req.body?.username);
      const problem = usernameProblem(username) ?? passwordProblem(req.body?.password);
      if (problem) return res.status(400).json({ error: problem });
      const hash = await hashPassword(req.body.password);
      // Re-check after the (async) hashing: two first-run requests at once must not both become "the first admin".
      if (authEnabled()) return res.status(409).json({ error: "Login is already set up — sign in instead." });
      const user = insertUser({ username, displayName: req.body?.displayName, role: "admin" }, hash);
      run("UPDATE users SET last_login_at = ? WHERE id = ?", now(), user.id);
      startSession(req, res, user.id);
      auditAs(user, "auth.setup", user.username, { role: "admin" });
      res.json({ enabled: true, user: getUser(user.id) });
    }),
  );

  api.post(
    "/auth/login",
    wrap(async (req, res) => {
      if (!authEnabled()) return res.status(409).json({ error: "Login isn't turned on." });
      const username = normalizeUsername(req.body?.username);
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const wait = loginLockedFor(username);
      if (wait) {
        res.setHeader("Retry-After", String(wait));
        return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} min.` });
      }
      const row = username ? findUserForLogin(username) : undefined;
      const ok = row ? await verifyPassword(password, row.password_hash) : (await burnPasswordCheck(password), false);
      if (!row || !ok || row.disabled) {
        recordLoginFailure(username);
        audit(req, "login.failed", username || null, row?.disabled && ok ? "account disabled" : null);
        // One message for unknown user, wrong password and disabled account, so usernames can't be probed.
        return res.status(401).json({ error: "Wrong username or password." });
      }
      clearLoginFailures(username);
      run("UPDATE users SET last_login_at = ? WHERE id = ?", now(), row.id);
      startSession(req, res, row.id);
      const user = getUser(row.id)!;
      auditAs(user, "login", user.username);
      res.json({ enabled: true, user });
    }),
  );

  api.post("/auth/logout", (req, res) => {
    const user = currentUser(req);
    endSession(req, res);
    if (user) audit(req, "logout", user.username);
    res.json({ ok: true });
  });

  /** Change your own password (needs the current one). Your other sessions are signed out. */
  api.post(
    "/auth/password",
    wrap(async (req, res) => {
      const me = requireRole(req, res, "viewer");
      if (!me) return;
      const row = findUserForLogin(me.username)!;
      if (!(await verifyPassword(String(req.body?.currentPassword ?? ""), row.password_hash))) return res.status(400).json({ error: "Your current password is wrong." });
      const problem = passwordProblem(req.body?.newPassword);
      if (problem) return res.status(400).json({ error: problem });
      await setPassword(me.id, req.body.newPassword);
      endUserSessions(me.id, req);
      audit(req, "password.change", me.username);
      res.json({ ok: true });
    }),
  );

  // ---------------------------------------------------------------- users (admin)

  api.get("/auth/users", (req, res) => {
    if (!requireRole(req, res, "admin")) return;
    res.json(listUsers());
  });

  api.post(
    "/auth/users",
    wrap(async (req, res) => {
      if (!requireRole(req, res, "admin")) return;
      const username = normalizeUsername(req.body?.username);
      const role = req.body?.role ?? "member";
      const problem = usernameProblem(username) ?? (isRole(role) ? null : "Role must be admin, member or viewer.") ?? passwordProblem(req.body?.password);
      if (problem) return res.status(400).json({ error: problem });
      if (findUserForLogin(username)) return res.status(409).json({ error: `${username} already exists.` });
      const user = await createUser({ username, displayName: req.body?.displayName, role, password: req.body.password });
      audit(req, "user.create", user.username, { role: user.role });
      res.json(user);
    }),
  );

  /** Rename, change role, disable/enable, or set a new password (the admin types it; nothing secret is returned). */
  api.patch(
    "/auth/users/:id",
    wrap(async (req, res) => {
      const me = requireRole(req, res, "admin");
      if (!me) return;
      const user = getUser(String(req.params.id));
      if (!user) return res.status(404).json({ error: "User not found" });
      const b = req.body ?? {};
      const patch: Record<string, unknown> = {};
      const changed: Record<string, unknown> = {};
      if (b.displayName !== undefined) {
        patch.display_name = String(b.displayName).trim().slice(0, 80) || user.username;
        changed.displayName = patch.display_name;
      }
      if (b.role !== undefined && b.role !== user.role) {
        if (!isRole(b.role)) return res.status(400).json({ error: "Role must be admin, member or viewer." });
        if (isLastActiveAdmin(user.id)) return res.status(409).json({ error: "This is the last admin — make someone else admin first." });
        patch.role = b.role;
        changed.role = b.role;
      }
      if (b.disabled !== undefined && !!b.disabled !== user.disabled) {
        if (b.disabled && user.id === me.id) return res.status(409).json({ error: "You can't disable your own account." });
        if (b.disabled && isLastActiveAdmin(user.id)) return res.status(409).json({ error: "This is the last admin — it can't be disabled." });
        patch.disabled = b.disabled ? 1 : 0;
        changed.disabled = !!b.disabled;
      }
      if (b.password !== undefined) {
        const problem = passwordProblem(b.password);
        if (problem) return res.status(400).json({ error: problem });
      }
      update("users", user.id, patch);
      if (b.password !== undefined) {
        await setPassword(user.id, b.password);
        changed.password = "reset";
      }
      // A disabled account or a reset password ends that user's sessions (keeping yours if you reset your own).
      if (changed.disabled === true || changed.password) endUserSessions(user.id, user.id === me.id ? req : undefined);
      if (Object.keys(changed).length) audit(req, b.password !== undefined && Object.keys(changed).length === 1 ? "user.password_reset" : "user.update", user.username, changed);
      res.json(getUser(user.id));
    }),
  );

  api.delete("/auth/users/:id", (req, res) => {
    const me = requireRole(req, res, "admin");
    if (!me) return;
    const user = getUser(String(req.params.id));
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.id === me.id) return res.status(409).json({ error: "You can't delete your own account." });
    if (isLastActiveAdmin(user.id)) return res.status(409).json({ error: "This is the last admin — it can't be deleted." });
    run("DELETE FROM users WHERE id = ?", user.id);
    audit(req, "user.delete", user.username, { role: user.role });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- audit log (admin)

  api.get("/audit", (req, res) => {
    // With login off there are no admins to restrict this to — the middleware already let a local request through.
    if (authEnabled() && !requireRole(req, res, "admin")) return;
    res.json(listAudit(Number(req.query.limit ?? 200)));
  });
}
