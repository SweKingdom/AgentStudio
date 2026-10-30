/**
 * Every project's workspace is a real local git repository: agents commit their work, releases are tagged.
 * The remote URL is stored as `origin` but nothing is ever pushed or fetched — no network, no credentials.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { workspaceDir, worktreeDir, type Project, type WorkItem } from "./store.js";
import { fill, teamSettings } from "./team.js";

const pexec = promisify(execFile);

export interface RepoSettings {
  url: string;
  branch: string;
  push?: boolean;
}

export type Provider = "github" | "azure" | "gitlab" | "bitbucket" | "other";

/** Accepts https / ssh / scp-style git URLs; refuses URLs that embed a user, password or token. */
export function validateRepoUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const url = raw.trim();
  if (!url) return { ok: false, error: "A git repository URL is required." };
  if (/\s/.test(url)) return { ok: false, error: "The URL can't contain spaces." };
  const https = url.match(/^https?:\/\/([^/@]+@)?([^/]+)\/(.+)$/i);
  if (https) {
    if (https[1]) return { ok: false, error: "Don't put a user, password or token in the URL — AgentStudio never stores credentials." };
    return { ok: true, url };
  }
  if (/^(ssh:\/\/)?git@[\w.-]+[:/][\w./~-]+$/i.test(url)) return { ok: true, url };
  if (/^file:\/\/\/\S+$/i.test(url)) return { ok: true, url }; // a local (bare) repository
  return { ok: false, error: "Use an https:// or git@ URL, e.g. https://github.com/org/repo.git" };
}

export function providerOf(url: string): Provider {
  if (/github\.com/i.test(url)) return "github";
  if (/dev\.azure\.com|visualstudio\.com/i.test(url)) return "azure";
  if (/gitlab/i.test(url)) return "gitlab";
  if (/bitbucket/i.test(url)) return "bitbucket";
  return "other";
}

/** Browser URL for the repository (ssh → https, strip .git). */
export function webUrlOf(url: string): string | null {
  const scp = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(\.git)?$/i);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  if (/^https?:\/\//i.test(url)) return url.replace(/\.git$/i, "");
  return null;
}

export function repoName(url: string) {
  const m = url.replace(/\.git$/i, "").match(/[:/]([^/:]+\/[^/:]+)$/);
  return m ? m[1].replace(/^_git\//, "") : url;
}

// Git operations on one workspace must not overlap (parallel delivery lanes): one queue per project.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  queues.set(key, next);
  return next;
}

async function git(dir: string, args: string[], env: Record<string, string> = {}) {
  const { stdout } = await pexec("git", args, {
    cwd: dir,
    timeout: 30_000,
    maxBuffer: 20_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  return stdout;
}

/** Like git(), but never throws: returns the exit status and the combined output. */
async function tryGit(dir: string, args: string[], env: Record<string, string> = {}) {
  try {
    return { ok: true, out: await git(dir, args, env) };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${x.stdout ?? ""}${x.stderr ?? ""}`.trim() || String(x.message ?? e) };
  }
}

/** Network git (fetch, push, ls-remote): the system config is allowed — on macOS that's where the Keychain credential
 *  helper lives — but git never prompts, so a missing login fails fast instead of hanging. */
async function remoteGit(dir: string, args: string[], timeout = 120_000) {
  try {
    const { stdout, stderr } = await pexec("git", args, { cwd: dir, timeout, maxBuffer: 20_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=15" } });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${x.stderr ?? ""}${x.stdout ?? ""}`.trim() || String(x.message ?? e) };
  }
}



// Isolated from the user's global git config: no signing, no hooks.
const ARM_IDENTITY = ["-c", "user.name=AgentStudio", "-c", "user.email=arm@agentstudio.local", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

export function ensureRepo(project: Pick<Project, "key" | "settings">) {
  return serial(project.key, async () => {
    const dir = workspaceDir(project);
    fs.mkdirSync(dir, { recursive: true });
    const branch = project.settings.repo?.branch || "main";
    let fresh = false;
    if (!fs.existsSync(path.join(dir, ".git"))) {
      await git(dir, ["init", "-q", "-b", branch]);
      fs.writeFileSync(path.join(dir, ".gitignore"), ".DS_Store\nnode_modules/\n");
      await git(dir, [...ARM_IDENTITY, "add", "-A"]);
      await git(dir, [...ARM_IDENTITY, "commit", "-q", "--allow-empty", "-m", `chore: initialise ${project.key} workspace`]);
      fresh = true;
    }
    const url = project.settings.repo?.url;
    const remotes = (await git(dir, ["remote"])).split("\n").filter(Boolean);
    if (url && remotes.includes("origin")) await git(dir, ["remote", "set-url", "origin", url]);
    else if (url) await git(dir, ["remote", "add", "origin", url]);
    else if (remotes.includes("origin")) await git(dir, ["remote", "remove", "origin"]);
    const current = (await git(dir, ["branch", "--show-current"])).trim();
    if (current && current !== branch) await git(dir, ["branch", "-m", current, branch]);
    // A new workspace starts from the repository's own code when the remote has the branch: the agents work in the
    // existing codebase (and its checks), and later pushes are fast-forwards. An empty or unreachable remote keeps the
    // fresh workspace.
    if (fresh && url) {
      const f = await remoteGit(dir, ["fetch", "-q", "origin", branch]);
      if (f.ok) await git(dir, ["reset", "-q", "--hard", `origin/${branch}`]);
    }
  });
}

/** Commit everything the agent changed, authored by the agent. No-op when nothing changed.
 *  With `itemCode`, the task's worktree (its branch) is committed too; the main workspace holds the project-level
 *  files (living documents, manifest) and is committed on the base branch. Returns the task-branch commit if any. */
export function commitWork(project: Pick<Project, "key" | "settings">, o: { author: string; email: string; message: string; itemCode?: string | null }) {
  return ensureRepo(project).then(() =>
    serial(project.key, async () => {
      const commitIn = async (dir: string) => {
        await git(dir, [...ARM_IDENTITY, "add", "-A"]);
        const staged = (await git(dir, ["diff", "--cached", "--name-only"])).trim();
        if (!staged) return null;
        await git(dir, [...ARM_IDENTITY, "-c", `user.name=${o.author}`, "-c", `user.email=${o.email}`, "commit", "-q", "-m", o.message]);
        return (await git(dir, ["rev-parse", "--short", "HEAD"])).trim();
      };
      const wt = o.itemCode ? worktreeDir(project, o.itemCode) : null;
      const onBranch = wt && fs.existsSync(path.join(wt, ".git")) ? await commitIn(wt) : null;
      const onBase = await commitIn(workspaceDir(project));
      return onBranch ?? onBase;
    }),
  );
}

// ---------- One branch per task ----------

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/** The task's branch name from the team's pattern (default feature/{code}-{slug}, bugfix/{code}-{slug} for bugs). */
export function branchNameFor(item: Pick<WorkItem, "code" | "title" | "type">) {
  const c = teamSettings().conventions;
  const name = fill(item.type === "bug" ? c.bugBranchPattern : c.branchPattern, { code: item.code, slug: slug(item.title), type: item.type, title: slug(item.title) })
    .replace(/[^\w./-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/-+(?=\/|$)/g, "")
    .replace(/^[./-]+|[./-]+$/g, "")
    .replace(/\.lock$/, "");
  return name || `task/${item.code}`;
}

/** Give the task its own branch and working copy (git worktree), branched from the latest base branch. Re-opening a
 *  task that was already merged reuses its branch, brought up to date with the base first. Returns the branch name. */
export function ensureItemBranch(project: Pick<Project, "key" | "settings">, item: Pick<WorkItem, "code" | "title" | "type" | "branch">) {
  return ensureRepo(project).then(() =>
    serial(project.key, async () => {
      const main = workspaceDir(project);
      const base = project.settings.repo?.branch || "main";
      const wt = worktreeDir(project, item.code);
      const branch = item.branch || branchNameFor(item);
      if (fs.existsSync(path.join(wt, ".git"))) return { branch, created: false };
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      await tryGit(main, ["worktree", "prune"]);
      const exists = (await git(main, ["branch", "--list", branch])).trim();
      if (exists) {
        await git(main, ["worktree", "add", "-q", wt, branch]);
        await tryGit(wt, [...ARM_IDENTITY, "merge", "-q", "--no-edit", base]);
      } else {
        await git(main, ["worktree", "add", "-q", "-b", branch, wt, base]);
      }
      return { branch, created: !exists };
    }),
  );
}

/** `body`: the merge commit's description — the team's PR template, filled in by the orchestrator.
 *  `via: "pr"`: stop once the task branch is up to date with the base branch — the merge itself happens on GitHub. */
type MergeItem = Pick<WorkItem, "code" | "title" | "branch"> & { body?: string; via?: "local" | "pr" };

/** The merge commit's subject (also the pull request's title) from the team's merge pattern. */
export function mergeSubjectFor(item: Pick<WorkItem, "code" | "title" | "branch">) {
  return fill(teamSettings().conventions.mergePattern, { branch: item.branch, code: item.code, title: item.title }).split("\n")[0].slice(0, 200);
}

export interface MergeResult {
  merged: boolean;
  /** Files with conflicts between the task branch and the base branch (the merge is left in progress in the worktree). */
  conflicts: string[];
  commit?: string;
  output?: string;
  /** `via: "pr"` only: the task branch is up to date with the base branch and ready for its pull request. */
  ready?: boolean;
}

/** Step 1 of integrating a task: bring the base branch into the task branch. Conflicts stay in the worktree (with
 *  conflict markers) for the developer to resolve; then call `finishMerge`. Without conflicts it goes straight on. */
export function mergeItemBranch(project: Pick<Project, "key" | "settings">, item: MergeItem): Promise<MergeResult> {
  return ensureRepo(project).then(() =>
    serial(project.key, async () => {
      const wt = worktreeDir(project, item.code);
      if (!item.branch || !fs.existsSync(path.join(wt, ".git"))) return { merged: false, conflicts: [], output: "No task branch to merge." };
      const base = project.settings.repo?.branch || "main";
      await commitPending(wt, `${item.code}: work in progress`);
      const up = await tryGit(wt, [...ARM_IDENTITY, "merge", "--no-edit", "-m", `Merge ${base} into ${item.branch}`, base]);
      if (!up.ok) {
        const conflicts = (await git(wt, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
        if (conflicts.length) return { merged: false, conflicts, output: up.out };
        throw new Error(`git merge ${base} → ${item.branch} failed: ${up.out}`);
      }
      return item.via === "pr" ? readyForPr(project) : integrate(project, item);
    }),
  );
}

/** Step 2 after conflicts: commit the resolution (refused while conflict markers remain), then integrate. */
export function finishMerge(project: Pick<Project, "key" | "settings">, item: MergeItem, o: { author: string; email: string; keep?: "task" }): Promise<MergeResult> {
  return serial(project.key, async () => {
    const wt = worktreeDir(project, item.code);
    const unresolved = (await git(wt, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
    // Simulation only: keep the task branch's version of each conflicted file (ours = the task branch here).
    if (o.keep === "task" && unresolved.length) {
      await git(wt, ["checkout", "--ours", "--", ...unresolved]);
    }
    const files = (await git(wt, ["diff", "--name-only"])).split("\n").filter(Boolean);
    const marked: string[] = [];
    for (const f of new Set([...unresolved, ...files])) {
      const abs = path.join(wt, f);
      if (fs.existsSync(abs) && /^(<{7}|>{7})( |$)/m.test(fs.readFileSync(abs, "utf8"))) marked.push(f);
    }
    if (marked.length) return { merged: false, conflicts: marked, output: "Conflict markers are still present." };
    await git(wt, [...ARM_IDENTITY, "add", "-A"]);
    await git(wt, [...ARM_IDENTITY, "-c", `user.name=${o.author}`, "-c", `user.email=${o.email}`, "commit", "-q", "--no-edit"]);
    return item.via === "pr" ? readyForPr(project) : integrate(project, item);
  });
}

/** Merge the (up-to-date) task branch into the base branch with a merge commit, then remove its worktree. The branch
 *  itself is kept — it's the history of the task. Runs inside the project's git queue. */
async function integrate(project: Pick<Project, "key" | "settings">, item: MergeItem): Promise<MergeResult> {
  const main = workspaceDir(project);
  const wt = worktreeDir(project, item.code);
  await commitPending(main, "docs: update living documents");
  const subject = mergeSubjectFor(item);
  const r = await tryGit(main, [...ARM_IDENTITY, "merge", "--no-ff", "-m", subject, ...(item.body?.trim() ? ["-m", item.body.trim()] : []), item.branch!]);
  if (!r.ok) {
    await tryGit(main, ["merge", "--abort"]);
    throw new Error(`Merging ${item.branch} into the base branch failed: ${r.out}`);
  }
  const commit = (await git(main, ["rev-parse", "--short", "HEAD"])).trim();
  await tryGit(main, ["worktree", "remove", "--force", wt]);
  return { merged: true, conflicts: [], commit };
}

/** Pull-request flow: the base branch's pending work (living documents) is committed so it can be pushed before the PR. */
async function readyForPr(project: Pick<Project, "key" | "settings">): Promise<MergeResult> {
  await commitPending(workspaceDir(project), "docs: update living documents");
  return { merged: false, conflicts: [], ready: true };
}

/** Local merge of an up-to-date task branch into the base branch — the fallback when the pull request path fails. */
export function mergeIntoBase(project: Pick<Project, "key" | "settings">, item: MergeItem): Promise<MergeResult> {
  return serial(project.key, () => integrate(project, item));
}

/** After the task's PR was merged on GitHub: bring the local base branch up to date with origin (fast-forward when
 *  possible; a normal merge when other lanes committed meanwhile) and remove the task's worktree. If origin can't be
 *  fetched or merged, the task branch is merged locally instead, so the local base never misses the story. */
export function syncBaseAfterPr(project: Pick<Project, "key" | "settings">, item: MergeItem): Promise<MergeResult & { fastForward: boolean; fallback?: string }> {
  return serial(project.key, async () => {
    const main = workspaceDir(project);
    const base = project.settings.repo?.branch || "main";
    await commitPending(main, "docs: update living documents");
    const f = await remoteGit(main, ["fetch", "-q", "origin", base]);
    const ff = f.ok && (await tryGit(main, ["merge-base", "--is-ancestor", base, `origin/${base}`])).ok;
    const m = f.ok ? await tryGit(main, [...ARM_IDENTITY, "merge", "-q", "--no-edit", "-m", `Merge origin/${base} into ${base}`, `origin/${base}`]) : f;
    if (!m.ok) {
      if (f.ok) await tryGit(main, ["merge", "--abort"]);
      const local = await integrate(project, item);
      return { ...local, fastForward: false, fallback: m.out };
    }
    // Belt and braces: origin must now contain the task's work; if it somehow doesn't, merge it locally.
    if (item.branch && !(await tryGit(main, ["merge-base", "--is-ancestor", item.branch, base])).ok) {
      return { ...(await integrate(project, item)), fastForward: false, fallback: `origin/${base} doesn't contain ${item.branch}` };
    }
    const commit = (await git(main, ["rev-parse", "--short", "HEAD"])).trim();
    await tryGit(main, ["worktree", "remove", "--force", worktreeDir(project, item.code)]);
    return { merged: true, conflicts: [], commit, fastForward: ff };
  });
}

async function commitPending(dir: string, message: string) {
  await git(dir, [...ARM_IDENTITY, "add", "-A"]);
  if ((await git(dir, ["diff", "--cached", "--name-only"])).trim()) await git(dir, [...ARM_IDENTITY, "commit", "-q", "-m", message]);
}

/** Drop a task's worktree without merging (task cancelled). The branch is kept. */
export function dropItemWorktree(project: Pick<Project, "key" | "settings">, code: string) {
  return serial(project.key, async () => {
    const wt = worktreeDir(project, code);
    if (fs.existsSync(wt)) await tryGit(workspaceDir(project), ["worktree", "remove", "--force", wt]);
  });
}

/** Push branches and tags to origin — only when the project opted in. Uses this machine's own git login (SSH key or
 *  credential helper); AgentStudio never stores credentials and never prompts. */
export function pushRefs(project: Pick<Project, "key" | "settings">, refs: string[], tags = false): Promise<{ pushed: boolean; output: string }> {
  return serial(project.key, async () => {
    const repo = project.settings.repo;
    if (!repo?.push || !repo.url) return { pushed: false, output: "Push is off for this project." };
    const dir = workspaceDir(project);
    const base = repo.branch || "main";
    const notes: string[] = [];
    // If someone else moved the remote base branch (or it started with a README), merge it in before pushing.
    if (refs.includes(base)) {
      const f = await remoteGit(dir, ["fetch", "-q", "origin", base]);
      if (f.ok) {
        const behind = !(await tryGit(dir, ["merge-base", "--is-ancestor", `origin/${base}`, base])).ok;
        if (behind) {
          const m = await tryGit(dir, [...ARM_IDENTITY, "merge", "-q", "--no-edit", "--allow-unrelated-histories", `origin/${base}`]);
          if (!m.ok) {
            await tryGit(dir, ["merge", "--abort"]);
            return { pushed: false, output: `origin/${base} has changes that conflict with the local ${base}; resolve them in the repository, then push again.\n${m.out}` };
          }
          notes.push(`Merged origin/${base} into ${base} first.`);
        }
      }
    }
    const args = ["push", "--porcelain", "origin", ...refs.map((r) => `refs/heads/${r}:refs/heads/${r}`)];
    if (tags) args.push("--follow-tags");
    const r = await remoteGit(dir, args);
    return { pushed: r.ok, output: [...notes, r.out].filter(Boolean).join("\n") };
  });
}

/** Can this computer reach a remote, and write to it, with its own git login? `git ls-remote` plus a dry-run push from a
 *  throwaway repository — nothing is changed on the remote. */
export async function testRemoteUrl(url: string) {
  const check = validateRepoUrl(url);
  if (!check.ok) return { read: false, write: false, output: check.error, branches: [] as string[] };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arm-remote-check-"));
  try {
    const read = await remoteGit(tmp, ["ls-remote", "--heads", check.url], 30_000);
    if (!read.ok) return { read: false, write: false, output: read.out, branches: [] as string[] };
    const branches = read.out.split("\n").map((l) => l.split("\t")[1]?.replace("refs/heads/", "")).filter(Boolean) as string[];
    await git(tmp, ["init", "-q"]);
    await git(tmp, [...ARM_IDENTITY, "commit", "-q", "--allow-empty", "-m", "connection check"]);
    const write = await remoteGit(tmp, ["push", "--dry-run", "--porcelain", check.url, "HEAD:refs/heads/arm-connection-check"], 60_000);
    return { read: true, write: write.ok, output: write.out, branches };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The files a task changed on its branch (committed or not), relative to where it left the base branch. */
export function changedOnBranch(project: Pick<Project, "key" | "settings">, code: string) {
  return serial(project.key, async () => {
    const wt = worktreeDir(project, code);
    if (!fs.existsSync(path.join(wt, ".git"))) return [] as string[];
    const base = project.settings.repo?.branch || "main";
    await git(wt, [...ARM_IDENTITY, "add", "-A"]);
    const mb = (await git(wt, ["merge-base", base, "HEAD"])).trim();
    return (await git(wt, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", mb])).split("\n").filter(Boolean);
  });
}

/** The task branch's own changes as a unified diff (committed or not), for a code review. Evidence images and binary
 *  files are left out; the patch is capped at `maxChars` so a review stays cheap. */
export function branchDiff(project: Pick<Project, "key" | "settings">, code: string, maxChars = 24_000) {
  return serial(project.key, async () => {
    const wt = worktreeDir(project, code);
    if (!fs.existsSync(path.join(wt, ".git"))) return { files: [] as string[], patch: "", truncated: false };
    const base = project.settings.repo?.branch || "main";
    await git(wt, [...ARM_IDENTITY, "add", "-A"]);
    const mb = (await git(wt, ["merge-base", base, "HEAD"])).trim();
    const scope = ["--", ".", ":(exclude)**/evidence/**", ":(exclude)**/*.png", ":(exclude)**/*.svg"];
    const files = (await git(wt, ["diff", "--cached", "--name-status", mb, ...scope])).split("\n").filter(Boolean).map((l) => l.replace(/\t/g, " "));
    const full = await git(wt, ["diff", "--cached", "--no-color", "-U3", mb, ...scope]);
    const truncated = full.length > maxChars;
    return { files, patch: truncated ? `${full.slice(0, maxChars).replace(/\n[^\n]*$/, "")}\n…[diff truncated at ${maxChars} characters — review what is shown and say which files you could not see]` : full, truncated };
  });
}

export interface BranchInfo {
  name: string;
  head: string;
  date: string;
  subject: string;
  base: boolean;
  merged: boolean;
  ahead: number;
  active: boolean;
}

export function listBranches(project: Pick<Project, "key" | "settings">): Promise<BranchInfo[]> {
  return ensureRepo(project).then(() =>
    serial(project.key, async () => {
      const main = workspaceDir(project);
      const base = project.settings.repo?.branch || "main";
      const SEP = "\u001f";
      const out = await git(main, ["for-each-ref", "refs/heads", `--format=%(refname:short)${SEP}%(objectname:short)${SEP}%(committerdate:iso-strict)${SEP}%(subject)${SEP}%(worktreepath)`]);
      const merged = new Set((await git(main, ["branch", "--merged", base, "--format=%(refname:short)"])).split("\n").filter(Boolean));
      const rows: BranchInfo[] = [];
      for (const line of out.split("\n").filter(Boolean)) {
        const [name, head, date, subject, wt] = line.split(SEP);
        const ahead = name === base ? 0 : Number((await tryGit(main, ["rev-list", "--count", `${base}..${name}`])).out.trim()) || 0;
        rows.push({ name, head, date, subject, base: name === base, merged: name !== base && merged.has(name), ahead, active: !!wt && name !== base });
      }
      return rows.sort((a, b) => Number(b.base) - Number(a.base) || b.date.localeCompare(a.date));
    }),
  );
}

export function tagRelease(project: Pick<Project, "key" | "settings">, version: string, message: string) {
  return ensureRepo(project).then(() =>
    serial(project.key, async () => {
      const dir = workspaceDir(project);
      const tag = `v${version.replace(/^v/, "")}`;
      const exists = (await git(dir, ["tag", "--list", tag])).trim();
      if (!exists) await git(dir, [...ARM_IDENTITY, "tag", "-a", tag, "-m", message.slice(0, 500)]);
      return tag;
    }),
  );
}

export interface Commit {
  hash: string;
  short: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  files: { path: string; added: number; removed: number }[];
  tags: string[];
  branches: string[];
  parents: string[];
}

/** Commits on every branch, or with `only` just one branch's own commits (those not on the default branch). */
export function gitLog(project: Pick<Project, "key" | "settings">, limit = 500, only?: string): Promise<{ commits: Commit[]; branch: string }> {
  return ensureRepo(project).then(() =>
    serial(project.key, async () => {
      const dir = workspaceDir(project);
      const SEP = "\u001f";
      const base = project.settings.repo?.branch || "main";
      if (only && !/^[\w./-]+$/.test(only)) throw new Error("Invalid branch name");
      const range = only ? (only === base ? ["--first-parent", base] : [`${base}..${only}`]) : ["--all"];
      const out = await git(dir, ["log", ...range, `-${limit}`, "--date=iso-strict", `--pretty=format:@@%H${SEP}%h${SEP}%an${SEP}%ae${SEP}%ad${SEP}%s${SEP}%D${SEP}%P`, "--numstat"]);
      const commits: Commit[] = [];
      for (const block of out.split("@@").filter(Boolean)) {
        const [head, ...rest] = block.split("\n");
        const [hash, short, author, email, date, subject, refs, parents] = head.split(SEP);
        const files = rest
          .filter((l) => /^\d+|^-/.test(l))
          .map((l) => {
            const [a, r, p] = l.split("\t");
            return { path: p, added: Number(a) || 0, removed: Number(r) || 0 };
          });
        const refList = (refs ?? "").split(", ").map((x) => x.replace(/^HEAD -> /, "")).filter(Boolean);
        const tags = refList.filter((x) => x.startsWith("tag: ")).map((x) => x.slice(5));
        const branches = refList.filter((x) => !x.startsWith("tag: ") && x !== "HEAD" && !x.startsWith("origin/"));
        commits.push({ hash, short, author, email, date, subject, files, tags, branches, parents: (parents ?? "").split(" ").filter(Boolean) });
      }
      const branch = (await git(dir, ["branch", "--show-current"])).trim();
      return { commits, branch };
    }),
  );
}
