import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TMP, fileUrl } from "./setup.ts";
import { ensureItemBranch, ensureRepo, commitWork, finishMerge, listBranches, mergeItemBranch, pushRefs } from "../src/git.ts";
import { workspaceDir, worktreeDir } from "../src/store.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function project(key: string, push = false) {
  const remote = path.join(TMP, `${key.toLowerCase()}-remote.git`);
  fs.mkdirSync(remote, { recursive: true });
  sh(remote, "init", "-q", "--bare", "-b", "main");
  return { p: { key, settings: { repo: { url: fileUrl(remote), branch: "main", push } } } as any, remote };
}
const write = (dir: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};
const item = (code: string, title: string, branch: string | null = null) => ({ code, title, type: "story" as const, branch });

test("each task works on its own branch and worktree, then merges into main", async () => {
  const { p } = project("GBR");
  await ensureRepo(p);
  const a = item("US-101", "Email to case");
  const b = item("US-102", "Assign by región");
  const ra = await ensureItemBranch(p, a);
  const rb = await ensureItemBranch(p, b);
  assert.equal(ra.branch, "feature/US-101-email-to-case");
  assert.equal(rb.branch, "feature/US-102-assign-by-region", "accents are folded");
  // Parallel work in separate folders.
  write(worktreeDir(p, "US-101"), "force-app/main/default/classes/A.cls", "class A {}\n");
  write(worktreeDir(p, "US-102"), "force-app/main/default/classes/B.cls", "class B {}\n");
  await commitWork(p, { author: "Forge", email: "forge@x", message: "US-101: dev", itemCode: "US-101" });
  await commitWork(p, { author: "Forge", email: "forge@x", message: "US-102: dev", itemCode: "US-102" });
  assert.ok(!fs.existsSync(path.join(workspaceDir(p), "force-app/main/default/classes/A.cls")), "main is untouched until merge");
  const ma = await mergeItemBranch(p, { ...a, branch: ra.branch });
  const mb = await mergeItemBranch(p, { ...b, branch: rb.branch });
  assert.ok(ma.merged && mb.merged);
  assert.ok(fs.existsSync(path.join(workspaceDir(p), "force-app/main/default/classes/A.cls")));
  assert.ok(fs.existsSync(path.join(workspaceDir(p), "force-app/main/default/classes/B.cls")));
  assert.ok(!fs.existsSync(worktreeDir(p, "US-101")), "worktree removed after merge");
  const branches = await listBranches(p);
  assert.ok(branches.find((x) => x.name === ra.branch)?.merged);
  assert.match(sh(workspaceDir(p), "log", "-1", "--format=%s"), /^Merge feature\/US-102-assign-by-region: US-102/);
});

test("conflicts stop the merge until they're resolved", async () => {
  const { p } = project("GCF");
  await ensureRepo(p);
  const a = { ...item("US-201", "First"), branch: (await ensureItemBranch(p, item("US-201", "First"))).branch };
  const b = { ...item("US-202", "Second"), branch: (await ensureItemBranch(p, item("US-202", "Second"))).branch };
  const rel = "force-app/main/default/permissionsets/Agent.permissionset-meta.xml";
  write(worktreeDir(p, "US-201"), rel, "<a>\n  <x>first</x>\n</a>\n");
  write(worktreeDir(p, "US-202"), rel, "<a>\n  <x>second</x>\n</a>\n");
  assert.ok((await mergeItemBranch(p, a)).merged);
  const m = await mergeItemBranch(p, b);
  assert.equal(m.merged, false);
  assert.deepEqual(m.conflicts, [rel]);
  // Markers still there → refused.
  const still = await finishMerge(p, b, { author: "Forge", email: "forge@x" });
  assert.equal(still.merged, false);
  // The developer writes the resolution → merged.
  write(worktreeDir(p, "US-202"), rel, "<a>\n  <x>first</x>\n  <x>second</x>\n</a>\n");
  const done = await finishMerge(p, b, { author: "Forge", email: "forge@x" });
  assert.ok(done.merged);
  assert.match(fs.readFileSync(path.join(workspaceDir(p), rel), "utf8"), /first[\s\S]*second/);
});

test("push sends branches and tags to origin only when the project opts in", async () => {
  const off = project("GPO");
  await ensureRepo(off.p);
  assert.equal((await pushRefs(off.p, ["main"])).pushed, false);

  const { p, remote } = project("GPS", true);
  await ensureRepo(p);
  const it = { ...item("US-301", "Pushed"), branch: (await ensureItemBranch(p, item("US-301", "Pushed"))).branch };
  write(worktreeDir(p, "US-301"), "force-app/main/default/classes/P.cls", "class P {}\n");
  await commitWork(p, { author: "Forge", email: "forge@x", message: "US-301: dev", itemCode: "US-301" });
  assert.ok((await pushRefs(p, [it.branch])).pushed);
  await mergeItemBranch(p, it);
  sh(workspaceDir(p), "-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", "v1.0.0", "-m", "release");
  const r = await pushRefs(p, ["main"], true);
  assert.ok(r.pushed, r.output);
  const refs = sh(remote, "for-each-ref", "--format=%(refname)");
  assert.match(refs, /refs\/heads\/main/);
  assert.match(refs, /refs\/heads\/feature\/US-301-pushed/);
  assert.match(refs, /refs\/tags\/v1\.0\.0/);
});

test("a resolution the developer's run already committed still merges (no second commit)", async () => {
  const { p } = project("GDC");
  await ensureRepo(p);
  const a = { ...item("US-401", "First"), branch: (await ensureItemBranch(p, item("US-401", "First"))).branch };
  const b = { ...item("US-402", "Second"), branch: (await ensureItemBranch(p, item("US-402", "Second"))).branch };
  write(worktreeDir(p, "US-401"), "src/config.ts", "export const a = 1;\n");
  write(worktreeDir(p, "US-402"), "src/config.ts", "export const b = 2;\n");
  assert.ok((await mergeItemBranch(p, a)).merged);
  assert.deepEqual((await mergeItemBranch(p, b)).conflicts, ["src/config.ts"]);
  // The developer resolves the file; the end of their run commits everything, which concludes the merge.
  write(worktreeDir(p, "US-402"), "src/config.ts", "export const a = 1;\nexport const b = 2;\n");
  await commitWork(p, { author: "Dev", email: "dev@x", message: "US-402: development", itemCode: "US-402" });
  const done = await finishMerge(p, b, { author: "Dev", email: "dev@x" });
  assert.ok(done.merged, done.output ?? "not merged");
  assert.match(fs.readFileSync(path.join(workspaceDir(p), "src/config.ts"), "utf8"), /a = 1[\s\S]*b = 2/);
});

test("a task branch picked up again is brought up to date with main; conflicts are reported", async () => {
  const { p } = project("GUP");
  await ensureRepo(p);
  const story = item("US-501", "Retry");
  const { branch } = await ensureItemBranch(p, story);
  write(worktreeDir(p, "US-501"), "src/feature.ts", "export const x = 1;\n");
  write(worktreeDir(p, "US-501"), "package.json", '{ "scripts": {} }\n');
  await commitWork(p, { author: "Dev", email: "dev@x", message: "US-501: dev", itemCode: "US-501" });
  // Meanwhile main gets the project skeleton (another story).
  const main = workspaceDir(p);
  write(main, "eslint.config.js", "export default [];\n");
  write(main, "package.json", '{ "scripts": { "lint": "eslint ." } }\n');
  sh(main, "add", "-A");
  sh(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "skeleton");

  const again = await ensureItemBranch(p, { ...story, branch });
  assert.equal(again.created, false);
  assert.deepEqual(again.conflicts, ["package.json"], "the conflict is reported, not hidden");
  assert.ok(fs.existsSync(path.join(worktreeDir(p, "US-501"), "eslint.config.js")), "main's new files are on the branch");
  // Picked up again before the developer resolved it: the same conflicts, no new merge attempt.
  assert.deepEqual((await ensureItemBranch(p, { ...story, branch })).conflicts, ["package.json"]);

  write(worktreeDir(p, "US-501"), "package.json", '{ "scripts": { "lint": "eslint ." } }\n');
  await commitWork(p, { author: "Dev", email: "dev@x", message: "US-501: resolve", itemCode: "US-501" });
  write(main, "README.md", "# Project\n");
  sh(main, "add", "-A");
  sh(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "readme");
  assert.deepEqual((await ensureItemBranch(p, { ...story, branch })).conflicts, [], "a clean update merges silently");
  assert.ok(fs.existsSync(path.join(worktreeDir(p, "US-501"), "README.md")));
});
