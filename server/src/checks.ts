/**
 * The project's own checks (test, build, typecheck, lint) — the gate that replaces "the agent says it works".
 * A story only goes to QA, and QA can only approve it, when every check exits 0 on the story's branch.
 *
 * Commands come from the project (or the team default); when none are set they are detected from package.json.
 * Simulation never runs anything.
 */
import { spawn } from "node:child_process";
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
    // A shell, because commands are written like a terminal line ("npm test -- --ci", "make check").
    const child = spawn(c.command, { cwd, shell: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, windowsHide: true });
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
  if (!commands.length) {
    return { ok: true, simulated: false, results: [], note: "No checks configured and none found in package.json — set them in the project settings." };
  }
  const cwd = rootFor(project, itemCode);
  const timeoutMs = projectChecks(project).timeoutMinutes * 60_000;
  const results: CheckResult[] = [];
  for (const c of commands) {
    const r = await runOne(c, cwd, timeoutMs);
    results.push(r);
    if (!r.ok) break;
  }
  return { ok: results.every((r) => r.ok), simulated: false, results };
}

export function formatChecks(r: ChecksReport) {
  if (r.note) return r.note;
  const lines = r.results.map((x) => `${x.ok ? "✅" : "❌"} ${x.name} (\`${x.command}\`) — exit ${x.exitCode ?? "none"}, ${(x.durationMs / 1000).toFixed(1)} s`);
  const failed = r.results.find((x) => !x.ok);
  if (failed) lines.push("", `Output of ${failed.name} (last lines):`, "```", failed.output, "```");
  return `${r.simulated ? "Simulated checks:\n" : ""}${lines.join("\n")}`;
}
