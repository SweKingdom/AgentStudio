#!/usr/bin/env node
// Stand-in for the GitHub CLI used by tests: implements `gh pr create/list/view/comment/ready/merge` against a LOCAL
// bare repository (ARM_FAKE_GH_REMOTE), with real git commands, so the merge lands where `git fetch` will see it.
// Pull requests live in a JSON file (ARM_FAKE_GH_STATE); every call is logged to ARM_FAKE_GH_LOG.
// ARM_FAKE_GH_FAIL=all makes every call fail like a network error; ARM_FAKE_GH_FAIL=merge fails only `pr merge`.
// Never talks to GitHub.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const stdin = flag("--body-file") === "-" ? fs.readFileSync(0, "utf8") : undefined;
if (process.env.ARM_FAKE_GH_LOG) {
  fs.appendFileSync(process.env.ARM_FAKE_GH_LOG, JSON.stringify({ args, stdin, promptDisabled: process.env.GH_PROMPT_DISABLED === "1" }) + "\n");
}
const fail = (msg, code = 1) => {
  process.stderr.write(msg + "\n");
  process.exit(code);
};
const cmd = args.slice(0, 2).join(" ");
const failing = process.env.ARM_FAKE_GH_FAIL;
if (failing === "all" || (failing && cmd === `pr ${failing}`)) fail("error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com");

const repo = flag("--repo");
if (!repo) fail("--repo is required by SiroccoARM");
const remote = process.env.ARM_FAKE_GH_REMOTE;
const statePath = process.env.ARM_FAKE_GH_STATE;
if (!remote || !statePath) fail("fake gh: ARM_FAKE_GH_REMOTE and ARM_FAKE_GH_STATE must be set");
// Parallel delivery lanes call gh at the same time: one process at a time reads and writes the state file.
const lock = `${statePath}.lock`;
for (let i = 0; ; i++) {
  try {
    fs.mkdirSync(lock);
    break;
  } catch {
    if (i > 600) fail("fake gh: state lock timeout");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
process.on("exit", () => fs.rmSync(lock, { recursive: true, force: true }));
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { prs: [] };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=GitHub", "-c", "user.email=noreply@example.com", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const pick = (pr) => {
  const fields = (flag("--json") ?? "number,url,state,isDraft").split(",");
  return Object.fromEntries(fields.map((f) => [f, pr[f]]));
};
const find = (n) => state.prs.find((p) => p.number === Number(n)) ?? fail(`GraphQL: Could not resolve to a PullRequest with the number of ${n}.`);

if (cmd === "pr list") {
  const head = flag("--head");
  const base = flag("--base");
  const st = (flag("--state") ?? "open").toUpperCase();
  const rows = state.prs.filter((p) => (!head || p.headRefName === head) && (!base || p.baseRefName === base) && (st === "ALL" || p.state === st));
  process.stdout.write(JSON.stringify(rows.slice(0, Number(flag("--limit") ?? 30)).map(pick)));
  process.exit(0);
}
if (cmd === "pr create") {
  const head = flag("--head");
  const base = flag("--base");
  try {
    git(remote, "rev-parse", "--verify", `refs/heads/${head}`);
    git(remote, "rev-parse", "--verify", `refs/heads/${base}`);
  } catch {
    fail(`pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between ${base} and ${head}`);
  }
  const number = state.prs.length + 1;
  const pr = { number, url: `https://github.com/${repo}/pull/${number}`, state: "OPEN", isDraft: args.includes("--draft"), title: flag("--title"), body: stdin ?? "", headRefName: head, baseRefName: base, comments: [] };
  state.prs.push(pr);
  save();
  process.stdout.write(`${pr.url}\n`);
  process.exit(0);
}
if (cmd === "pr view") {
  process.stdout.write(JSON.stringify(pick(find(args[2]))));
  process.exit(0);
}
if (cmd === "pr comment") {
  const pr = find(args[2]);
  pr.comments.push(stdin ?? flag("--body") ?? "");
  save();
  process.stdout.write(`${pr.url}#issuecomment-${pr.comments.length}\n`);
  process.exit(0);
}
if (cmd === "pr ready") {
  find(args[2]).isDraft = false;
  save();
  process.exit(0);
}
if (cmd === "pr merge") {
  const pr = find(args[2]);
  if (!args.includes("--merge")) fail("fake gh: SiroccoARM always merges with --merge");
  if (pr.isDraft) fail(`Pull request ${repo}#${pr.number} is still a draft`);
  if (pr.state !== "OPEN") fail(`Pull request ${repo}#${pr.number} is not open`);
  // A real merge commit on the bare repository, made in a throwaway clone.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gh-merge-"));
  try {
    git(tmp, "clone", "-q", remote, ".");
    git(tmp, "checkout", "-q", pr.baseRefName);
    git(tmp, "merge", "--no-ff", "-q", "-m", flag("--subject") ?? `Merge pull request #${pr.number}`, "-m", stdin || "", `origin/${pr.headRefName}`);
    git(tmp, "push", "-q", "origin", `HEAD:refs/heads/${pr.baseRefName}`);
  } catch (e) {
    fail(`Pull request ${repo}#${pr.number} is not mergeable: ${e.stderr ?? e.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  pr.state = "MERGED";
  pr.isDraft = false;
  save();
  process.exit(0);
}
fail(`fake gh: unsupported ${cmd}`);
