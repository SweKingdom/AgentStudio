// Claude accounts for the plan backend: each is a login in its own folder, the active one (or a project's own) is the
// folder agents run with, and signing in is watched until it's done. A stand-in replaces `claude auth login`.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { TMP } from "./setup.ts";

process.env.ANTHROPIC_API_KEY = "key-that-must-not-reach-claude";

const accounts = await import("../src/claudeAccounts.ts");
const { createApp } = await import("../src/app.ts");
const { sdkRun, setSdkQueryForTests } = await import("../src/agents/runner-sdk.ts");
const { defaultAgentFor } = await import("../src/agents/store.ts");

let server: Server;
let base = "";
async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

before(() => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  accounts.setLoginCommandForTests(null);
  setSdkQueryForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
  server.close();
});

test("accounts get their own folder; the active one, or a project's own, is the one agents run with", () => {
  const work = accounts.addAccount("Work");
  const priv = accounts.addAccount("Private");
  assert.equal(work.id, "work");
  assert.ok(fs.existsSync(accounts.accountDir("work")));
  assert.throws(() => accounts.addAccount("work"), /already/);

  assert.equal(accounts.claudeConfigDir(null), undefined, "default: this computer's own login");
  accounts.setActiveAccount("work");
  assert.equal(accounts.claudeConfigDir(null), accounts.accountDir("work"));
  assert.equal(accounts.claudeConfigDir({ settings: { claudeAccount: priv.id } } as any), accounts.accountDir(priv.id), "a project's own account wins");
  assert.equal(accounts.claudeConfigDir({ settings: { claudeAccount: "gone" } } as any), accounts.accountDir("work"), "an unknown one falls back to the active");
  assert.throws(() => accounts.setActiveAccount("nope"), /Unknown/);
  accounts.setActiveAccount(null);
});

test("a claude process gets the account's folder and never the API key", () => {
  const env = accounts.claudeEnv("/tmp/acct");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/acct");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(accounts.claudeEnv().CLAUDE_CONFIG_DIR, undefined);
});

test("agent runs on the plan use the chosen account's folder", async () => {
  const seen: { options?: any } = {};
  setSdkQueryForTests(async function* (p: { options?: unknown }) {
    seen.options = p.options;
    yield { type: "result", subtype: "success", is_error: false, result: "ok", modelUsage: {}, errors: [] };
  });
  await sdkRun({ agent: defaultAgentFor("developer"), system: "s", content: [], maxTurns: 1, effort: "low", configDir: accounts.accountDir("work") });
  assert.equal(seen.options.env.CLAUDE_CONFIG_DIR, accounts.accountDir("work"));
  assert.equal(seen.options.env.ANTHROPIC_API_KEY, undefined);
});

test("sign-in: the link is picked up, and a sign-in that stops unfinished is reported", async () => {
  const stand = path.join(TMP, "fake-login.mjs");
  fs.writeFileSync(stand, `console.log("Opening browser to sign in…");\nconsole.log("If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&x=" + process.env.CLAUDE_CONFIG_DIR.length);\nsetTimeout(() => { console.error("Login cancelled"); process.exit(1); }, 300);\n`);
  accounts.setLoginCommandForTests({ cmd: process.execPath, args: [stand] });
  const acct = accounts.addAccount("Login test");
  accounts.startLogin(acct.id);
  const t0 = Date.now();
  while (accounts.loginState(acct.id)?.state === "waiting" && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 100));
  const s = accounts.loginState(acct.id)!;
  assert.match(s.url ?? "", /^https:\/\/claude\.ai\/oauth\/authorize/);
  assert.equal(s.state, "failed");
  assert.match(s.error ?? "", /Login cancelled/);
  accounts.cancelLogin(acct.id);
  assert.equal(accounts.loginState(acct.id), null);
});

test("API: add, choose and remove accounts; a project can only pick a known one", async () => {
  let r = await api("POST", "/claude-accounts", { label: "Team" });
  const team = r.accounts.find((a: any) => a.label === "Team");
  assert.ok(team);
  assert.equal(team.status.loggedIn, false, "a new account isn't signed in yet");
  assert.match(team.loginCommand, /CLAUDE_CONFIG_DIR/);
  r = await api("PUT", "/claude-accounts/active", { id: team.id });
  assert.equal(r.active, team.id);
  await assert.rejects(api("POST", "/claude-accounts", { label: "" }), /400/);

  const agents = await api<any[]>("GET", "/agents");
  const p = await api("POST", "/projects", { name: "Acct", key: "ACT", description: "x", agentIds: agents.map((a) => a.id), settings: { gates: true, parallelism: 1, budgetUsd: 0, maxRework: 1, repo: { url: "https://github.com/demo/act.git", branch: "main" } } });
  await assert.rejects(api("PATCH", `/projects/${p.id}`, { settings: { claudeAccount: "nobody" } }), /Unknown Claude account/);
  const saved = await api("PATCH", `/projects/${p.id}`, { settings: { claudeAccount: team.id } });
  assert.equal(saved.settings.claudeAccount, team.id);

  r = await api("DELETE", `/claude-accounts/${team.id}`);
  assert.ok(!r.accounts.some((a: any) => a.id === team.id));
  assert.equal(r.active, null, "removing the active account falls back to this computer's login");
  assert.ok(!fs.existsSync(accounts.accountDir(team.id)));
});
