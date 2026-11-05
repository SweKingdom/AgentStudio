/**
 * Commands a developer agent may run in its story's worktree (e.g. `dotnet ef migrations add`, a seed CLI), so it can
 * produce generated files itself instead of stopping for a person. Only what the project allows: a command must start
 * with one of the project's allowed commands, word for word, and may not contain shell operators. It runs with this
 * computer's rights (there is no real sandbox), in the worktree, with a time limit and without AgentStudio's secrets.
 */
import { spawn } from "node:child_process";
import { projectChecks } from "./team.js";
import { rootFor, type Project } from "./store.js";

const MAX_ALLOWED = 20;
const OUTPUT_TAIL = 6000;
/** Chaining, redirection, substitution and variables: an allowed prefix can't be turned into another command. */
const SHELL_OPERATORS = /[;&|<>`$\r\n]|\$\(/;
/** Never handed to a command an agent runs. */
const SECRETS = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|AZURE_DEVOPS_PAT|GH_TOKEN$|GITHUB_TOKEN$|NPM_TOKEN$|ARM_)/;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/** Validate a project's allowed commands: one line each, no shell operators, at most 20. */
export function cleanAllowedCommands(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error("Allowed commands must be a list.");
  const list = [...new Set(v.map((c) => words(String(c ?? "")).join(" ")).filter(Boolean))];
  for (const c of list) {
    if (c.length > 200) throw new Error(`Allowed command "${c.slice(0, 40)}…" is longer than 200 characters.`);
    if (SHELL_OPERATORS.test(c)) throw new Error(`Allowed command "${c}" can't contain ; & | < > \` or $.`);
  }
  if (list.length > MAX_ALLOWED) throw new Error(`At most ${MAX_ALLOWED} allowed commands.`);
  return list;
}

export function allowedCommands(project: Pick<Project, "settings">): string[] {
  return project.settings.commands ?? [];
}

/** Why a command isn't allowed, or null when it starts with an allowed command (whole words) and has no operators. */
export function commandRefusal(command: string, allowed: string[]): string | null {
  const cmd = words(command);
  if (!cmd.length) return "Give the command to run.";
  if (SHELL_OPERATORS.test(command)) return "Commands can't contain ; & | < > ` or $ — run one command at a time.";
  const ok = allowed.some((a) => {
    const prefix = words(a);
    return prefix.length <= cmd.length && prefix.every((w, i) => w === cmd[i]);
  });
  return ok ? null : `Not an allowed command for this project. Allowed: ${allowed.length ? allowed.map((a) => `\`${a}\``).join(", ") : "none"}. Ask for a manual step with request_manual_step instead.`;
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

/** Runs an allowed command in the story's worktree (callers check commandRefusal first). */
export function runCommand(project: Project, itemCode: string | null | undefined, command: string): Promise<CommandResult> {
  const cwd = rootFor(project, itemCode);
  const timeoutMs = projectChecks(project).timeoutMinutes * 60_000;
  const env: NodeJS.ProcessEnv = { CI: "1", FORCE_COLOR: "0" };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRETS.test(k) && k !== "NODE_TEST_CONTEXT") env[k] = v;
  const started = Date.now();
  return new Promise((resolve) => {
    let out = "";
    const keep = (d: Buffer) => {
      out = (out + d.toString()).slice(-OUTPUT_TAIL * 2);
    };
    // A shell, so `npm`/`dotnet` resolve as in a terminal; the command has no operators, so it stays one command.
    const child = spawn(words(command).join(" "), { cwd, shell: true, env, windowsHide: true });
    const timer = setTimeout(() => {
      out += `\n[stopped after ${Math.round(timeoutMs / 60000)} min]`;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({ command, exitCode, durationMs: Date.now() - started, output: out.slice(-OUTPUT_TAIL).trim() });
    };
    child.on("error", (e) => {
      out += `\n${e.message}`;
      done(null);
    });
    child.on("close", done);
  });
}
