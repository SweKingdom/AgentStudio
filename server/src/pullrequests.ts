/**
 * One GitHub pull request per story, for projects that push to a GitHub repository. The PR opens as a draft when the
 * developer first hands the story to QA, collects QA's findings as comments, and is merged on GitHub once the story is
 * documented; the local base branch then catches up with origin. Every GitHub step is best-effort: when `gh` is
 * missing, not logged in or offline, the story is merged locally and pushed exactly as before — work is never lost.
 */
import { all } from "./db.js";
import { getAgent } from "./agents/store.js";
import { changedOnBranch, mergeIntoBase, mergeSubjectFor, pushRefs, syncBaseAfterPr, type MergeResult } from "./git.js";
import { commentPr, findOrCreatePr, githubRepoOf, markReady, mergePr, prNumberOf } from "./github.js";
import { getItem, getProject, logActivity, patchItem, type Project } from "./store.js";

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";
const message = (e: unknown) => firstLine(e instanceof Error ? e.message : String(e));

/** `owner/name` when this project's stories go through pull requests: it pushes, and its remote is on GitHub. */
export function prRepoFor(project: Pick<Project, "settings">): string | null {
  const repo = project.settings.repo;
  return repo?.push && repo.url ? githubRepoOf(repo.url) : null;
}

/** PR comments are plain text for reviewers: no links (evidence paths are local), no table-breaking characters. */
function linkFree(s: string) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<?\bhttps?:\/\/[^\s)>]+>?/gi, "")
    .trim();
}
const cell = (s: string) => linkFree(s).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").slice(0, 300) || "—";
const ICON: Record<string, string> = { pass: "✅", fail: "❌", blocked: "⛔" };

/** QA's checks for one iteration (the latest by default) as a markdown table, plus who ran them. */
function qaChecks(itemId: string, iteration?: number) {
  const rows = all<{ ac_ref: string; result: string; notes: string; agent_id: string | null; iteration: number }>(
    `SELECT ac_ref, result, notes, agent_id, iteration FROM test_results WHERE item_id = ? AND kind = 'qa'
       AND iteration = ${iteration == null ? "(SELECT MAX(iteration) FROM test_results WHERE item_id = ? AND kind = 'qa')" : "?"} ORDER BY id`,
    itemId,
    iteration == null ? itemId : iteration,
  );
  const n = (r: string) => rows.filter((x) => x.result === r).length;
  const table = rows.length
    ? `| Check | Result | Notes |\n|---|---|---|\n${rows.map((r) => `| ${cell(r.ac_ref)} | ${ICON[r.result] ?? r.result} | ${cell(r.notes)} |`).join("\n")}\n\n✅ ${n("pass")} passed · ❌ ${n("fail")} failed · ⛔ ${n("blocked")} blocked`
    : "";
  const tester = rows.find((r) => r.agent_id)?.agent_id;
  return { table, tester: tester ? getAgent(tester)?.name : undefined, iteration: rows[0]?.iteration };
}

const signature = (name: string | undefined) => `— ${name ?? "QA"} (QA)`;

async function comment(projectId: string, itemId: string, body: string, what: string) {
  const it = getItem(itemId)!;
  const repo = prRepoFor(getProject(projectId)!);
  const n = prNumberOf(it.pr_url);
  if (!repo || !n) return false;
  try {
    await commentPr(repo, n, body);
    logActivity({ projectId, agentId: "orchestrator", itemId, type: "file", summary: `Commented ${what} on PR #${n} for ${it.code}` });
    return true;
  } catch (e) {
    logActivity({ projectId, agentId: "orchestrator", itemId, type: "tool_error", summary: `⚠ Couldn't comment on PR #${n} for ${it.code}: ${message(e)}` });
    return false;
  }
}

/** After the developer's hand-over to QA: push the branch and open (or reuse) the story's PR as a draft. Never throws. */
export async function openDraftPr(projectId: string, itemId: string, body: string) {
  const p = getProject(projectId)!;
  const repo = prRepoFor(p);
  const it = getItem(itemId)!;
  if (!repo || !it.branch) return;
  const base = p.settings.repo?.branch || "main";
  try {
    // GitHub refuses a pull request without commits; there is nothing to review yet anyway.
    if (!(await changedOnBranch(p, it.code)).length) return;
    const pushed = await pushRefs(p, [base, it.branch]);
    if (!pushed.pushed) throw new Error(`push failed: ${firstLine(pushed.output)}`);
    const pr = await findOrCreatePr(repo, { head: it.branch, base, title: mergeSubjectFor(it), body, draft: true });
    if (it.pr_url !== pr.url) patchItem(itemId, { pr_url: pr.url });
    if (pr.created) logActivity({ projectId, agentId: "orchestrator", itemId, type: "file", summary: `Opened draft PR #${pr.number} for ${it.code}`, detail: pr.url });
  } catch (e) {
    logActivity({ projectId, agentId: "orchestrator", itemId, type: "tool_error", summary: `⚠ Couldn't open a draft PR for ${it.code}: ${message(e)} — the story continues; it's merged locally if GitHub stays unavailable.` });
  }
}

/** QA asked for changes: their findings and failed checks go on the PR as a comment. Never throws. */
export async function commentQaFindings(projectId: string, itemId: string, o: { iteration: number; findings: string; tester: string }) {
  const checks = qaChecks(itemId); // the QA run that just ended is the latest iteration
  const body = `### ❌ QA: changes requested (iteration ${o.iteration})\n\n${linkFree(o.findings)}${checks.table ? `\n\n${checks.table}` : ""}\n\n${signature(checks.tester ?? o.tester)}`;
  await comment(projectId, itemId, body, "QA findings");
}

/** The architect's code review on the PR, signed with their name. Never throws; no-op without a PR. */
export async function commentCodeReview(projectId: string, itemId: string, o: { reviewer: string; verdict: "approved" | "changes_requested"; findings: string; iteration: number }) {
  const label = o.verdict === "approved" ? "✅ approved" : "❌ changes requested";
  const body = `### ${o.reviewer} (architect) — code review: ${label}

Iteration ${o.iteration}.

${linkFree(o.findings) || "No findings."}

— ${o.reviewer} (architect)`;
  await comment(projectId, itemId, body, "the code review");
}

/** QA's final verdict and checks, posted before the merge. An account can't approve its own PR, so it's a comment. */
function verdictComment(itemId: string) {
  const it = getItem(itemId)!;
  const checks = qaChecks(itemId);
  if (!checks.table) return null;
  const loops = it.rework_count ? `${it.rework_count} rework loop(s) before approval.` : "Approved on the first pass — no rework loops.";
  return `### ✅ QA verdict: approved (iteration ${checks.iteration})\n\n${checks.table}\n\n${loops}\n\n${signature(checks.tester)}`;
}

/** The PR half of integrating a story whose branch is already up to date with the base branch: push, open or reuse the
 *  PR, post QA's verdict, mark it ready, merge it on GitHub and bring the local base branch up to date. Falls back to
 *  the local merge + push when any GitHub step fails. */
export async function integrateViaPr(projectId: string, itemId: string, body: string): Promise<MergeResult> {
  const p = () => getProject(projectId)!;
  const it = getItem(itemId)!;
  const repo = prRepoFor(p())!;
  const base = p().settings.repo?.branch || "main";
  const subject = mergeSubjectFor(it);
  let number: number | null = null;
  try {
    const pushed = await pushRefs(p(), [base, it.branch!]);
    if (!pushed.pushed) throw new Error(`push failed: ${firstLine(pushed.output)}`);
    const pr = await findOrCreatePr(repo, { head: it.branch!, base, title: subject, body });
    number = pr.number;
    if (it.pr_url !== pr.url) patchItem(itemId, { pr_url: pr.url });
    if (pr.created) logActivity({ projectId, agentId: "orchestrator", itemId, type: "file", summary: `Opened PR #${pr.number} for ${it.code}`, detail: pr.url });
    const verdict = verdictComment(itemId);
    if (verdict) await comment(projectId, itemId, verdict, "QA's verdict");
    if (pr.isDraft) await markReady(repo, pr.number);
    await mergePr(repo, pr.number, { subject, body });
    logActivity({ projectId, agentId: "orchestrator", itemId, type: "file", summary: `Merged PR #${pr.number} into ${base}`, detail: pr.url });
  } catch (e) {
    logActivity({ projectId, agentId: "orchestrator", itemId, type: "tool_error", summary: `⚠ GitHub ${number ? `PR #${number}` : "pull request"} for ${it.code} failed: ${message(e)} — merging locally and pushing instead.` });
    const m = await mergeIntoBase(p(), { ...it, body });
    logActivity({ projectId, agentId: "orchestrator", itemId, type: "file", summary: `Merged ${it.branch} into ${base} (${m.commit})` });
    const r = await pushRefs(p(), [base, it.branch!]);
    logActivity({ projectId, agentId: "orchestrator", itemId, type: r.pushed ? "file" : "tool_error", summary: r.pushed ? `Pushed ${base} and ${it.branch} to origin` : `Push failed: ${firstLine(r.output)}`, detail: r.output });
    return m;
  }
  const s = await syncBaseAfterPr(p(), { ...it, body });
  logActivity({
    projectId,
    agentId: "orchestrator",
    itemId,
    type: s.fallback ? "tool_error" : "file",
    summary: s.fallback
      ? `⚠ Couldn't update ${base} from origin (${firstLine(s.fallback)}) — merged ${it.branch} locally instead (${s.commit})`
      : `Updated local ${base} from origin/${base} (${s.fastForward ? "fast-forward" : "merge"}, ${s.commit})`,
  });
  return s;
}
