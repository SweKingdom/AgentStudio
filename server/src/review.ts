/**
 * Optional architect code review: after QA approves a story (and before documentation and the merge), the architect
 * reviews the task branch's diff against the team's review checklist and the solution design. Per project:
 * `settings.codeReview` = "off" (default) | "complex" (integration, development and data migration stories) | "all".
 * A "changes requested" verdict sends the story back to the developer through the same rework loop as QA.
 */
import { insert, now } from "./db.js";
import { runAgent } from "./agents/runner.js";
import type { Agent } from "./agents/store.js";
import { designExcerpt } from "./agents/context.js";
import { branchDiff } from "./git.js";
import { commentCodeReview } from "./pullrequests.js";
import { endPhase, getItem, getProject, logActivity, postMessage, startPhase, type Project, type WorkItem } from "./store.js";
import { teamSettings } from "./team.js";

export type CodeReviewMode = "off" | "complex" | "all";

/** Story categories whose code is worth a second pair of eyes under "complex". */
export const COMPLEX_CATEGORIES = ["integration", "development", "data_migration"];

/** Normalises any stored or submitted value (PATCH passes settings through) to a valid mode. */
export function codeReviewMode(v: unknown): CodeReviewMode {
  return v === "complex" || v === "all" ? v : "off";
}

/** Does this item get an architect code review in this project? */
export function needsCodeReview(project: Pick<Project, "settings">, item: Pick<WorkItem, "type" | "category">) {
  const mode = codeReviewMode(project.settings.codeReview);
  if (mode === "off" || !["story", "task", "bug"].includes(item.type)) return false;
  return mode === "all" || COMPLEX_CATEGORIES.includes(item.category);
}

/** The review task: compact on purpose — the diff, the checklist and the design excerpt are all the architect needs
 *  (the story card already travels in the run context). */
function reviewTask(project: Project, item: WorkItem, iteration: number, diff: { files: string[]; patch: string }) {
  const design = designExcerpt(project, item, 2500);
  return [
    `Code review of ${item.code} "${item.title}" (iteration ${iteration}) on ${item.branch}. QA has approved its behaviour; you review the code: design fit, the checklist below, security, bulk safety, maintainability. Don't rewrite code yourself.`,
    "Finish with submit_code_review: approved, or changes_requested with one bullet per finding — file, what is wrong, what is expected. Only request changes for real defects, not style preferences.",
    `## Review checklist\n${teamSettings().conventions.reviewChecklist}`,
    design ? `## Solution design — the parts that concern ${item.code}\n${design}` : "",
    `## Files changed (${diff.files.length})\n${diff.files.join("\n") || "(none)"}`,
    diff.patch ? `## Diff against ${project.settings.repo?.branch || "main"}\n\`\`\`diff\n${diff.patch}\n\`\`\`` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface CodeReviewResult {
  verdict: "approved" | "changes_requested";
  findings: string;
  reviewer: Agent;
}

/** Run the architect's review of one story and record it everywhere: item phase "review", a work-item comment, an
 *  activity line and (when the story has one) a PR comment. A run that ends without a verdict counts as approved. */
export async function runCodeReview(o: { projectId: string; itemId: string; architect: Agent; iteration: number; attempt: number; signal: AbortSignal; kind?: string }): Promise<CodeReviewResult> {
  const project = getProject(o.projectId)!;
  const item = getItem(o.itemId)!;
  const diff = await branchDiff(project, item.code).catch(() => ({ files: [] as string[], patch: "", truncated: false }));
  const phase = startPhase(o.projectId, o.itemId, "review", o.architect.id, o.iteration);
  const r = await runAgent({
    project,
    agent: o.architect,
    stage: "review",
    item,
    iteration: o.iteration,
    attempt: o.attempt,
    signal: o.signal,
    kind: o.kind,
    task: reviewTask(project, item, o.iteration, diff),
  });
  const verdict = r.outcome.codeReview?.verdict ?? "approved";
  const findings = r.outcome.codeReview?.findings || (verdict === "approved" ? "No findings." : r.summary);
  endPhase(phase, verdict);
  const label = verdict === "approved" ? "✅ approved" : "❌ changes requested";
  insert("comments", { project_id: o.projectId, item_id: o.itemId, author_id: o.architect.id, content: `Code review (iteration ${o.iteration}): ${label}\n${findings}`, created_at: now() });
  logActivity({ projectId: o.projectId, agentId: o.architect.id, itemId: o.itemId, type: "review", summary: `${o.architect.name} code review of ${item.code}: ${label}` });
  await commentCodeReview(o.projectId, o.itemId, { reviewer: o.architect.name, verdict, findings, iteration: o.iteration });
  if (verdict === "changes_requested") {
    postMessage({ projectId: o.projectId, from: o.architect.id, to: item.assigned_agent_id ?? "human", itemId: o.itemId, kind: "rework", content: `Code review of ${item.code} requested changes:\n${findings}`.slice(0, 3000) });
  }
  return { verdict, findings, reviewer: o.architect };
}
