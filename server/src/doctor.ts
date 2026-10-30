/**
 * System check: is this machine ready to run SiroccoARM — and live work in particular? Used by Settings → System check
 * and by `npm run doctor`. Every check is read-only and free: no tokens are spent and nothing is changed anywhere.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { DATA_DIR } from "./db.js";
import { appSettings, effectiveMode, hasApiKey } from "./settings.js";
import { listAgents } from "./agents/store.js";
import { adoConfigOf, adoProjects, hasAdoToken, NO_TOKEN, testAdo } from "./ado.js";

const pexec = promisify(execFile);

export type CheckStatus = "ok" | "warn" | "fail" | "info";
export interface Check {
  id: string;
  group: "App" | "Git & GitHub" | "Claude API" | "Azure DevOps";
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it. */
  fix?: string;
}

async function run(cmd: string, args: string[], timeout = 15_000) {
  try {
    const { stdout, stderr } = await pexec(cmd, args, { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; code?: string | number; message?: string };
    return { ok: false, missing: x.code === "ENOENT", out: `${x.stdout ?? ""}${x.stderr ?? ""}`.trim() || String(x.message ?? e) };
  }
}

const versionAtLeast = (v: string, min: number[]) => {
  const p = v.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) if ((p[i] ?? 0) !== min[i]) return (p[i] ?? 0) > min[i];
  return true;
};

export async function runChecks(o: { network?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // ---------------------------------------------------------------- app
  const node = process.versions.node;
  add({
    id: "node",
    group: "App",
    label: "Node.js",
    status: versionAtLeast(node, [22, 5]) ? "ok" : "fail",
    detail: `v${node}`,
    fix: versionAtLeast(node, [22, 5]) ? undefined : "Install Node.js 22.5 or newer (the database uses node:sqlite).",
  });
  try {
    const probe = path.join(DATA_DIR, `.write-check-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    add({ id: "data", group: "App", label: "Data folder", status: "ok", detail: DATA_DIR });
  } catch (e) {
    add({ id: "data", group: "App", label: "Data folder", status: "fail", detail: `${DATA_DIR}: ${e instanceof Error ? e.message : e}`, fix: "Give this user write access to the data folder, or set ARM_DATA_DIR." });
  }
  const mode = effectiveMode();
  add({ id: "mode", group: "App", label: "Mode", status: "info", detail: mode === "live" ? "Live — agents call the Claude API (real cost)" : `Simulation${appSettings().mode === "live" ? " (Live is selected but there's no API key)" : ""} — nothing is sent to Claude` });
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) add({ id: "proxy", group: "App", label: "Proxy", status: "info", detail: `HTTPS_PROXY is set — git and the Claude SDK must both be able to use it.` });

  // ---------------------------------------------------------------- git & GitHub
  const g = await run("git", ["--version"]);
  const gv = g.out.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? "";
  if (!g.ok) add({ id: "git", group: "Git & GitHub", label: "git", status: "fail", detail: g.missing ? "Not installed" : g.out, fix: "Install git 2.25 or newer." });
  else add({ id: "git", group: "Git & GitHub", label: "git", status: versionAtLeast(gv, [2, 25]) ? "ok" : "warn", detail: `v${gv}`, fix: versionAtLeast(gv, [2, 25]) ? undefined : "Update git to 2.25+ (task branches use worktrees)." });
  if (g.ok) {
    const helpers = (await run("git", ["config", "--get-all", "credential.helper"])).out.split("\n").filter(Boolean);
    add({
      id: "git-https",
      group: "Git & GitHub",
      label: "HTTPS login (credential helper)",
      status: helpers.length ? "ok" : "warn",
      detail: helpers.length ? helpers.join(", ") : "None configured",
      fix: helpers.length ? undefined : "For https:// repositories run `gh auth login` (GitHub CLI) or configure a credential helper (macOS: osxkeychain; Windows: manager).",
    });
    if (o.network) {
      const ssh = await run("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", "git@github.com"], 15_000);
      const who = ssh.out.match(/Hi ([^!]+)!/)?.[1];
      add({
        id: "github-ssh",
        group: "Git & GitHub",
        label: "GitHub over SSH",
        status: who ? "ok" : "warn",
        detail: who ? `Authenticated as ${who}` : ssh.out.split("\n").pop() || "No SSH access",
        fix: who ? undefined : "Only needed for git@github.com URLs: add an SSH key to GitHub (ssh-keygen, then GitHub → Settings → SSH keys).",
      });
      const gh = await run("gh", ["auth", "status", "--hostname", "github.com"]);
      if (!gh.missing) {
        const acct = gh.out.match(/account (\S+)/)?.[1] ?? gh.out.match(/as (\S+)/)?.[1];
        add({ id: "gh", group: "Git & GitHub", label: "GitHub CLI", status: gh.ok ? "ok" : "warn", detail: gh.ok ? `Logged in${acct ? ` as ${acct}` : ""}` : "Not logged in", fix: gh.ok ? undefined : "Run `gh auth login` — it also sets up the HTTPS credential helper for git." });
      }
    }
  }

  // ---------------------------------------------------------------- Claude API
  if (!hasApiKey()) {
    add({ id: "api-key", group: "Claude API", label: "API key", status: "warn", detail: "Not set — the app runs in simulation", fix: "Add ANTHROPIC_API_KEY=… to the .env file in the project folder and restart." });
  } else {
    add({ id: "api-key", group: "Claude API", label: "API key", status: "ok", detail: "Set (not shown)" });
    if (o.network) {
      // Model access differs per account (e.g. Fable). Looking a model up is free.
      const client = new Anthropic({ maxRetries: 1, timeout: 20_000 });
      const wanted = [...new Set(listAgents().filter((a) => a.enabled).map((a) => a.model))];
      for (const m of wanted) {
        try {
          await client.models.retrieve(m);
          add({ id: `model-${m}`, group: "Claude API", label: m, status: "ok", detail: `Available · used by ${listAgents().filter((a) => a.model === m).map((a) => a.name).join(", ")}` });
        } catch (e) {
          const status = (e as { status?: number }).status;
          add({
            id: `model-${m}`,
            group: "Claude API",
            label: m,
            status: "fail",
            detail: status === 401 ? "The API key was rejected" : status === 404 ? "Not available to this account" : String((e as Error).message ?? e).split("\n")[0],
            fix: status === 401 ? "Check ANTHROPIC_API_KEY in .env." : "Pick another model for these agents (Agents → model).",
          });
          if (status === 401) break;
        }
      }
    }
  }
  // ---------------------------------------------------------------- Azure DevOps
  const adoUsers = adoProjects();
  const adoToken = hasAdoToken();
  if (!adoUsers.length) {
    add({ id: "ado-token", group: "Azure DevOps", label: "Token (AZURE_DEVOPS_PAT)", status: "info", detail: `${adoToken ? "Set (not shown)" : "Not set"} — no project syncs to Azure DevOps` });
  } else {
    add({
      id: "ado-token",
      group: "Azure DevOps",
      label: "Token (AZURE_DEVOPS_PAT)",
      status: adoToken ? "ok" : "warn",
      detail: adoToken ? `Set (not shown) · used by ${adoUsers.map((p) => p.key).join(", ")}` : `Not set — ${adoUsers.map((p) => p.key).join(", ")} can't sync`,
      fix: adoToken ? undefined : NO_TOKEN,
    });
    if (o.network && adoToken) {
      // One read per distinct ADO project (nothing is changed).
      const seen = new Set<string>();
      for (const p of adoUsers) {
        const cfg = adoConfigOf(p)!;
        const k = `${cfg.orgUrl}|${cfg.project}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const r = await testAdo(cfg);
        add({ id: `ado-${p.key}`, group: "Azure DevOps", label: `Project ${cfg.project}`, status: r.ok ? "ok" : "fail", detail: r.ok ? `Connected${r.process ? ` · process ${r.process}` : ""}` : r.error ?? "Failed", fix: r.ok ? undefined : "Check the Azure DevOps settings of the project and AZURE_DEVOPS_PAT in .env." });
      }
    }
  }

  return checks;
}
