import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TMP } from "./setup.ts";
import { createApp } from "../src/app.ts";
import { api as apiRouter } from "../src/api.ts";
import { registerAuth } from "../src/routes/auth.ts";
import { run, all } from "../src/db.ts";

// The coordinator registers the auth routes in api.ts; register them here only if that hasn't happened yet.
const registered = (apiRouter as unknown as { stack: { route?: { path: string } }[] }).stack.some((l) => l.route?.path === "/auth/status");
if (!registered) registerAuth(apiRouter);

let server: Server;
let base = "";

interface Res<T = any> { status: number; body: T; cookie: string | null; setCookie: string | null }

async function call<T = any>(method: string, path: string, body?: unknown, cookie?: string | null): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${base}/api${path}`, { method, headers, body: payload });
  const text = await res.text();
  const setCookie = res.headers.get("set-cookie");
  const cookiePair = setCookie?.match(/arm_session=([^;]*)/)?.[1];
  return {
    status: res.status,
    body: (res.headers.get("content-type")?.includes("json") && text ? JSON.parse(text) : text) as T,
    cookie: cookiePair ? `arm_session=${cookiePair}` : null,
    setCookie,
  };
}

/** Status code of the SSE stream without waiting for it to end. */
function sseStatus(cookie?: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/events`, { headers: cookie ? { cookie } : {} }, (res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", (e) => ((e as NodeJS.ErrnoException).code === "ECONNRESET" ? undefined : reject(e)));
  });
}

async function login(username: string, password: string) {
  const r = await call("POST", "/auth/login", { username, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.cookie);
  return r.cookie!;
}

const ADMIN_PW = "correct horse battery";
let admin = "";

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

test("login is off by default: everything works without a session", async () => {
  const status = await call("GET", "/auth/status");
  assert.deepEqual(status.body, { enabled: false, setupNeeded: true, user: null });
  assert.equal((await call("GET", "/projects")).status, 200);
  assert.equal((await call("PUT", "/settings", { mode: "simulation", simulationSpeed: 0 })).status, 200);
  assert.equal(await sseStatus(), 200);
  assert.equal((await call("POST", "/auth/login", { username: "x", password: "y" })).status, 409, "no login while off");
});

test("setup validates input, creates the first admin and turns login on", async () => {
  assert.equal((await call("POST", "/auth/setup", { username: "admin", password: "short" })).status, 400);
  assert.equal((await call("POST", "/auth/setup", { username: "a b", password: ADMIN_PW })).status, 400);
  const r = await call("POST", "/auth/setup", { username: "Admin", displayName: "The Admin", password: ADMIN_PW });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, "admin", "usernames are lower-cased");
  assert.equal(r.body.user.role, "admin");
  assert.equal(r.body.user.password_hash, undefined);
  assert.match(r.setCookie!, /HttpOnly/);
  assert.match(r.setCookie!, /SameSite=Strict/);
  assert.match(r.setCookie!, /Path=\//);
  assert.doesNotMatch(r.setCookie!, /Secure/, "plain http gets no Secure flag");
  admin = r.cookie!;
  const s = await call("GET", "/auth/status", undefined, admin);
  assert.equal(s.body.enabled, true);
  assert.equal(s.body.user.username, "admin");
  assert.equal((await call("POST", "/auth/setup", { username: "other", password: ADMIN_PW })).status, 409, "setup only once");
});

test("without a session every API call is 401 — the live event stream included — except /auth/*", async () => {
  assert.equal((await call("GET", "/projects")).status, 401);
  assert.equal((await call("GET", "/meta")).status, 401);
  assert.equal((await call("PUT", "/settings", {})).status, 401);
  assert.equal((await call("GET", "/projects", undefined, "arm_session=forged")).status, 401);
  assert.equal(await sseStatus(), 401);
  assert.equal(await sseStatus(admin), 200);
  const s = await call("GET", "/auth/status");
  assert.equal(s.status, 200);
  assert.deepEqual(s.body, { enabled: true, setupNeeded: false, user: null });
  assert.equal((await call("GET", "/projects", undefined, admin)).status, 200);
});

test("login and logout", async () => {
  const c = await login("ADMIN", ADMIN_PW);
  assert.notEqual(c, admin, "every login gets its own token");
  assert.equal((await call("GET", "/projects", undefined, c)).status, 200);
  const out = await call("POST", "/auth/logout", {}, c);
  assert.equal(out.status, 200);
  assert.match(out.setCookie!, /Max-Age=0/);
  assert.equal((await call("GET", "/projects", undefined, c)).status, 401, "token is gone after logout");
  assert.equal((await call("GET", "/projects", undefined, admin)).status, 200, "other sessions survive");
  const tokens = all<{ token_hash: string }>("SELECT token_hash FROM sessions");
  assert.ok(tokens.every((t) => /^[0-9a-f]{64}$/.test(t.token_hash) && !admin.includes(t.token_hash)), "only SHA-256 hashes are stored");
});

test("wrong password is rejected and repeated failures are rate limited per username", async () => {
  await call("POST", "/auth/users", { username: "limited", role: "member", password: "limited-password-1" }, admin);
  for (let i = 0; i < 5; i++) {
    const r = await call("POST", "/auth/login", { username: "limited", password: "wrong-password!" });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "Wrong username or password.");
  }
  const locked = await call("POST", "/auth/login", { username: "limited", password: "limited-password-1" });
  assert.equal(locked.status, 429, "even the right password waits once locked");
  assert.equal((await call("POST", "/auth/login", { username: "nobody", password: "whatever-pass" })).body.error, "Wrong username or password.", "unknown users look the same");
  await login("admin", ADMIN_PW); // other usernames aren't affected
});

test("viewer can read but not write", async () => {
  const r = await call("POST", "/auth/users", { username: "viewer", displayName: "Vee", role: "viewer", password: "viewer-password-1" }, admin);
  assert.equal(r.status, 200);
  const v = await login("viewer", "viewer-password-1");
  assert.equal((await call("GET", "/projects", undefined, v)).status, 200);
  assert.equal(await sseStatus(v), 200);
  assert.equal((await call("POST", "/agents", { role: "developer" }, v)).status, 403);
  assert.equal((await call("DELETE", "/projects/NOPE", undefined, v)).status, 403);
  assert.equal((await call("GET", "/auth/users", undefined, v)).status, 403);
  assert.equal((await call("GET", "/audit", undefined, v)).status, 403);
});

test("member can start a project but not change app-wide settings or users", async () => {
  await call("POST", "/auth/users", { username: "member", role: "member", password: "member-password-1" }, admin);
  const m = await login("member", "member-password-1");
  assert.equal((await call("PUT", "/settings", { mode: "live" }, m)).status, 403);
  assert.equal((await call("PUT", "/models", [], m)).status, 403);
  assert.equal((await call("PUT", "/team", {}, m)).status, 403);
  assert.equal((await call("POST", "/team/import", {}, m)).status, 403);
  assert.equal((await call("POST", "/salesforce/orgs", { alias: "x" }, m)).status, 403);
  assert.equal((await call("DELETE", "/salesforce/orgs/x", undefined, m)).status, 403);
  assert.equal((await call("GET", "/auth/users", undefined, m)).status, 403);
  assert.equal((await call("POST", "/auth/users", { username: "sneaky", role: "admin", password: "sneaky-password" }, m)).status, 403);

  const agents = (await call<any[]>("GET", "/agents", undefined, m)).body;
  // A local bare repository stands in for the remote — nothing leaves this machine.
  const remote = path.join(TMP, "auth-remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const created = await call("POST", "/projects", { name: "Auth Demo", key: "AUD", agentIds: agents.slice(0, 1).map((a) => a.id), description: "Agents must log calls against the account.", settings: { gates: false, budgetUsd: 0, repo: { url: `file://${remote}`, branch: "main" } } }, m);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const started = await call("POST", "/projects/AUD/start", {}, m);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await call("POST", "/projects/AUD/pause", { mode: "now" }, m);
});

test("the last active admin can't be demoted, disabled or deleted", async () => {
  const users = (await call("GET", "/auth/users", undefined, admin)).body as any[];
  const me = users.find((u) => u.username === "admin");
  assert.ok(users.every((u) => u.password_hash === undefined), "password hashes never leave the server");
  assert.equal((await call("PATCH", `/auth/users/${me.id}`, { role: "member" }, admin)).status, 409);
  assert.equal((await call("PATCH", `/auth/users/${me.id}`, { disabled: true }, admin)).status, 409);
  assert.equal((await call("DELETE", `/auth/users/${me.id}`, undefined, admin)).status, 409);
  // With a second admin, the first may step down.
  const second = (await call("POST", "/auth/users", { username: "second", role: "admin", password: "second-password-1" }, admin)).body;
  const s = await login("second", "second-password-1");
  assert.equal((await call("PATCH", `/auth/users/${me.id}`, { role: "member" }, s)).status, 200);
  assert.equal((await call("DELETE", `/auth/users/${second.id}`, undefined, s)).status, 409, "can't delete yourself");
  assert.equal((await call("PATCH", `/auth/users/${me.id}`, { role: "admin" }, s)).status, 200);
});

test("admin password reset and disable sign the user out; nothing secret comes back", async () => {
  const u = (await call("POST", "/auth/users", { username: "resetme", role: "member", password: "first-password-1" }, admin)).body;
  assert.equal(u.password_hash, undefined);
  const c = await login("resetme", "first-password-1");
  const r = await call("PATCH", `/auth/users/${u.id}`, { password: "second-password-2" }, admin);
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes("second-password-2") && r.body.password_hash === undefined);
  assert.equal((await call("GET", "/projects", undefined, c)).status, 401, "old session ended");
  const c2 = await login("resetme", "second-password-2");
  // Change own password.
  assert.equal((await call("POST", "/auth/password", { currentPassword: "nope-nope-nope", newPassword: "third-password-3" }, c2)).status, 400);
  assert.equal((await call("POST", "/auth/password", { currentPassword: "second-password-2", newPassword: "third-password-3" }, c2)).status, 200);
  assert.equal((await call("GET", "/projects", undefined, c2)).status, 200, "your own session survives");
  assert.equal((await call("PATCH", `/auth/users/${u.id}`, { disabled: true }, admin)).status, 200);
  assert.equal((await call("GET", "/projects", undefined, c2)).status, 401, "disabled user is signed out");
  assert.equal((await call("POST", "/auth/login", { username: "resetme", password: "third-password-3" })).status, 401, "and can't sign in");
  assert.equal((await call("DELETE", `/auth/users/${u.id}`, undefined, admin)).status, 200);
});

test("sessions expire after 12 h without use", async () => {
  const c = await login("admin", ADMIN_PW);
  assert.equal((await call("GET", "/projects", undefined, c)).status, 200);
  run("UPDATE sessions SET expires_at = ?", new Date(Date.now() - 1000).toISOString());
  assert.equal((await call("GET", "/projects", undefined, c)).status, 401);
  assert.equal((await call("GET", "/projects", undefined, admin)).status, 401);
  admin = await login("admin", ADMIN_PW);
});

test("sessions slide forward when used", async () => {
  const c = await login("admin", ADMIN_PW);
  const soon = new Date(Date.now() + 60 * 60_000).toISOString();
  run("UPDATE sessions SET expires_at = ?", soon);
  const r = await call("GET", "/projects", undefined, c);
  assert.equal(r.status, 200);
  assert.match(r.setCookie ?? "", /Max-Age=43200/, "cookie refreshed");
  const rows = all<{ expires_at: string }>("SELECT expires_at FROM sessions");
  assert.ok(rows.some((x) => Date.parse(x.expires_at) > Date.now() + 11 * 60 * 60_000), "the used session moved to now + 12 h");
  admin = c;
});

test("audit log records logins and user changes, without secrets", async () => {
  const r = await call("GET", "/audit?limit=500", undefined, admin);
  assert.equal(r.status, 200);
  const actions = (r.body as any[]).map((a) => a.action);
  for (const a of ["auth.setup", "login", "logout", "login.failed", "user.create", "user.update", "user.password_reset", "user.delete", "password.change"]) {
    assert.ok(actions.includes(a), `audit has ${a}`);
  }
  const text = JSON.stringify(r.body);
  for (const secret of [ADMIN_PW, "second-password-2", "third-password-3", "viewer-password-1"]) assert.ok(!text.includes(secret), "no passwords in the audit log");
  const setup = (r.body as any[]).find((a) => a.action === "auth.setup");
  assert.equal(setup.username, "admin");
  assert.equal((await call("GET", "/audit?limit=2", undefined, admin)).body.length, 2);
});
