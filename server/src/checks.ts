/**
 * The project's own checks (test, build, typecheck, lint) — the gate that replaces "the agent says it works".
 * A story only goes to QA, and QA can only approve it, when every check exits 0 on the story's branch.
 *
 * Commands come from the project (or the team default); when none are set they are detected from package.json.
 * The dependencies are installed first (agents have no shell), so the checks can run and a new lockfile is committed
 * with the story. Simulation never runs anything.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { effectiveMode } from "./settings.js";
import { projectChecks, type CheckCommand } from "./team.js";
import { rootFor, type Project } from "./store.js";

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Tail of stdout + stderr — enough to find the failure, not the whole log. */
  output: string;
  /** The install step didn't run: package.json and the lockfile are unchanged since the last install. */
  skipped?: boolean;
}

export interface ChecksReport {
  ok: boolean;
  simulated: boolean;
  results: CheckResult[];
  /** Why nothing ran (no commands found), if so. */
  note?: string;
}

const OUTPUT_TAIL = 6000;

/** npm scripts that count as checks, in the order they run (cheap first). */
const SCRIPT_ORDER = ["typecheck", "lint", "test", "build"];

export function detectChecks(dir: string): CheckCommand[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    // npm's placeholder test script fails on purpose; it isn't a real check.
    return SCRIPT_ORDER.filter((s) => scripts[s] && !/no test specified/.test(scripts[s])).map((s) => ({ name: s, command: `npm run ${s} --silent` }));
  } catch {
    return [];
  }
}

/** Lockfile → package manager. Without a lockfile npm installs and writes package-lock.json. */
const INSTALLERS: [lockfile: string, command: string][] = [
  ["pnpm-lock.yaml", "pnpm install"],
  ["yarn.lock", "yarn install"],
  ["bun.lockb", "bun install"],
  ["bun.lock", "bun install"],
  ["package-lock.json", "npm install --no-audit --no-fund"],
];

export function detectInstall(dir: string): string | null {
  if (!fs.existsSync(path.join(dir, "package.json"))) return null;
  return INSTALLERS.find(([lock]) => fs.existsSync(path.join(dir, lock)))?.[1] ?? "npm install --no-audit --no-fund";
}

/** The command that installs the dependencies before the checks, or null when there is none (or it's turned off). */
export function installFor(project: Project, itemCode?: string | null): string | null {
  const install = projectChecks(project).install;
  if (install === "off") return null;
  return install === "auto" ? detectInstall(rootFor(project, itemCode)) : install;
}

const MARKER = path.join("node_modules", ".agentstudio-install");

/** What the install depends on: the command, package.json and the lockfiles. Same fingerprint → nothing to install. */
function installFingerprint(dir: string, command: string) {
  const h = crypto.createHash("sha256").update(command);
  for (const f of ["package.json", ...INSTALLERS.map(([lock]) => lock)]) {
    const file = path.join(dir, f);
    if (fs.existsSync(file)) h.update(f).update(fs.readFileSync(file));
  }
  return h.digest("hex");
}

async function install(command: string, cwd: string, timeoutMs: number): Promise<CheckResult> {
  const marker = path.join(cwd, MARKER);
  const before = installFingerprint(cwd, command);
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === before) {
    return { name: "install", command, ok: true, exitCode: 0, durationMs: 0, output: "Dependencies are up to date.", skipped: true };
  }
  const r = await runOne({ name: "install", command }, cwd, timeoutMs);
  // The install may write the lockfile, so the fingerprint is taken afterwards.
  if (r.ok) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, installFingerprint(cwd, command));
  }
  return r;
}

export function checksFor(project: Project, itemCode?: string | null): CheckCommand[] {
  const configured = projectChecks(project).commands;
  return configured.length ? configured : detectChecks(rootFor(project, itemCode));
}

function runOne(c: CheckCommand, cwd: string, timeoutMs: number): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = "";
    const keep = (d: Buffer) => {
      out = (out + d.toString()).slice(-OUTPUT_TAIL * 2);
    };
    // A shell, because commands are written like a terminal line ("npm test -- --ci", "make check"). The project's
    // own test runner must not think it is part of ours (node --test reads NODE_TEST_CONTEXT and reports nothing).
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", FORCE_COLOR: "0" };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(c.command, { cwd, shell: true, env, windowsHide: true });
    const timer = setTimeout(() => {
      out += `\n[timed out after ${Math.round(timeoutMs / 60000)} min]`;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({ name: c.name, command: c.command, ok: exitCode === 0, exitCode, durationMs: Date.now() - started, output: out.slice(-OUTPUT_TAIL).trim() });
    };
    child.on("error", (e) => {
      out += `\n${e.message}`;
      done(null);
    });
    child.on("close", done);
  });
}

/** Runs every check in order on the story's branch (or the main workspace); stops at the first failure. */
export async function runChecks(project: Project, itemCode?: string | null): Promise<ChecksReport> {
  const commands = checksFor(project, itemCode);
  if (project.mode === "simulation" || effectiveMode() === "simulation") {
    return { ok: true, simulated: true, results: commands.map((c) => ({ name: c.name, command: c.command, ok: true, exitCode: 0, durationMs: 0, output: "(simulated — nothing was run)" })) };
  }
  const cwd = rootFor(project, itemCode);
  const timeoutMs = projectChecks(project).timeoutMinutes * 60_000;
  const results: CheckResult[] = [];
  // Installed even without checks: it writes the lockfile the project needs.
  const installCommand = installFor(project, itemCode);
  if (installCommand) {
    const r = await install(installCommand, cwd, timeoutMs);
    results.push(r);
    if (!r.ok) return { ok: false, simulated: false, results };
  }
  if (!commands.length) {
    return { ok: true, simulated: false, results, note: "No checks configured and none found in package.json — set them in the project settings." };
  }
  for (const c of commands) {
    const r = await runOne(c, cwd, timeoutMs);
    results.push(r);
    if (!r.ok) break;
  }
  return { ok: results.every((r) => r.ok), simulated: false, results };
}

export function formatChecks(r: ChecksReport) {
  const lines = r.results.map((x) => `${x.ok ? "✅" : "❌"} ${x.name} (\`${x.command}\`) — ${x.skipped ? x.output : `exit ${x.exitCode ?? "none"}, ${(x.durationMs / 1000).toFixed(1)} s`}`);
  if (r.note) lines.push(r.note);
  const failed = r.results.find((x) => !x.ok);
  if (failed) lines.push("", `Output of ${failed.name} (last lines):`, "```", failed.output, "```");
  return `${r.simulated ? "Simulated checks:\n" : ""}${lines.join("\n")}`;
}
