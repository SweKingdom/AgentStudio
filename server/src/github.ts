/**
 * GitHub pull requests through the `gh` CLI. SiroccoARM never sees a token: `gh` uses this machine's own login
 * (`gh auth login`), and every call names the repository explicitly (`--repo owner/name`) so it never depends on — or
 * touches — a local checkout. Prompts are disabled, so a missing login fails fast instead of hanging.
 *
 * Tests point `ARM_GH_BIN` at a stand-in script. Because their remotes are local `file://` bare repositories (which are
 * not on GitHub), `ARM_FORCE_GITHUB=1` makes `githubRepoOf` treat any remote as GitHub — a test-only switch kept here so
 * `providerOf` (used by the UI and the API) keeps telling the truth.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { providerOf } from "./git.js";

export interface PullRequest {
  number: number;
  url: string;
  /** OPEN | MERGED | CLOSED */
  state: string;
  isDraft: boolean;
}

/** `owner/name` of a GitHub remote, or null when the remote isn't on GitHub. */
export function githubRepoOf(url: string | undefined | null): string | null {
  if (!url) return null;
  if (providerOf(url) !== "github" && process.env.ARM_FORCE_GITHUB !== "1") return null;
  const m = url.replace(/\.git$/i, "").replace(/\/+$/, "").match(/[:/]([^/:]+)\/([^/:]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The PR number from its URL (…/pull/12). */
export function prNumberOf(url: string | null | undefined): number | null {
  const m = url?.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** gh output may echo an Authorization header or a token in a URL on some errors — never let one reach a log. */
export function redact(text: string) {
  return text
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/(authorization:\s*)(\S+\s+)?\S+/gi, "$1[redacted]");
}

export class GhError extends Error {}

function gh(args: string[], input?: string, timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ARM_GH_BIN || "gh", args, {
      cwd: os.tmpdir(), // never inside a workspace: gh must not pick up (or change) a local checkout
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      reject(new GhError(missing ? "The GitHub CLI (gh) is not installed on this computer." : redact(e.message)));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out.trim());
      const text = redact(`${err}${out}`.trim()) || (signal ? `gh timed out (${signal})` : `gh exited with ${code}`);
      reject(new GhError(`gh ${args.slice(0, 2).join(" ")}: ${text.split("\n").slice(0, 4).join(" ")}`));
    });
    child.stdin.on("error", () => undefined); // gh may exit before reading its input
    child.stdin.end(input ?? "");
  });
}

const FIELDS = "number,url,state,isDraft";

function parsePr(raw: unknown): PullRequest {
  const r = raw as Partial<PullRequest>;
  if (!r || typeof r.number !== "number" || typeof r.url !== "string") throw new GhError("gh returned an unexpected pull request.");
  return { number: r.number, url: r.url, state: String(r.state ?? "OPEN").toUpperCase(), isDraft: Boolean(r.isDraft) };
}

export async function prStatus(repo: string, n: number): Promise<PullRequest> {
  return parsePr(JSON.parse(await gh(["pr", "view", String(n), "--repo", repo, "--json", FIELDS])));
}

/** The open PR from `head` into `base`, or a new one. A reused PR keeps its title and description. */
export async function findOrCreatePr(repo: string, o: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<PullRequest & { created: boolean }> {
  const open = JSON.parse((await gh(["pr", "list", "--repo", repo, "--head", o.head, "--base", o.base, "--state", "open", "--json", FIELDS, "--limit", "1"])) || "[]") as unknown[];
  if (open.length) return { ...parsePr(open[0]), created: false };
  const args = ["pr", "create", "--repo", repo, "--head", o.head, "--base", o.base, "--title", o.title.slice(0, 250), "--body-file", "-"];
  if (o.draft) args.push("--draft");
  const out = await gh(args, o.body);
  // `gh pr create` prints the new PR's URL; read it back for the full record.
  const url = out.split("\n").map((l) => l.trim()).find((l) => /\/pull\/\d+/.test(l));
  const n = prNumberOf(url);
  if (!n) throw new GhError(`gh pr create didn't return a pull request URL: ${redact(out).slice(0, 200)}`);
  return { ...(await prStatus(repo, n)), created: true };
}

export async function commentPr(repo: string, n: number, body: string) {
  await gh(["pr", "comment", String(n), "--repo", repo, "--body-file", "-"], body);
}

/** Draft → ready for review (no-op when it already is). */
export async function markReady(repo: string, n: number) {
  const pr = await prStatus(repo, n);
  if (pr.isDraft) await gh(["pr", "ready", String(n), "--repo", repo]);
}

/** Merge with a merge commit; the branch is kept — it's the history of the task. */
export async function mergePr(repo: string, n: number, o: { subject: string; body: string }): Promise<PullRequest> {
  await gh(["pr", "merge", String(n), "--repo", repo, "--merge", "--subject", o.subject.slice(0, 250), "--body-file", "-"], o.body, 120_000);
  const pr = await prStatus(repo, n);
  if (pr.state !== "MERGED") throw new GhError(`PR #${n} is ${pr.state.toLowerCase()} after the merge request (it may wait for required checks or reviews).`);
  return pr;
}
