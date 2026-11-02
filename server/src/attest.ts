/**
 * Deterministic first: what a check (and later a scan or a review) proved is recorded with the exact git tree it was
 * proved on. Agents and gates then rely on the record instead of repeating the work, and anything that changes the
 * tree invalidates it — evidence is always about the code as it is now.
 */
import { all, insert, now } from "./db.js";
import { formatChecks, runChecks, type ChecksReport } from "./checks.js";
import { currentTree } from "./git.js";
import { logActivity, type Project } from "./store.js";

export type AttestKind = "checks" | "scan" | "review";

export interface Attestation {
  kind: AttestKind;
  tree: string;
  ok: boolean;
  detail: string;
  created_at: string;
}

/** Record what was proved on the working copy's current tree (a story's, or the base with code null). */
export async function attest(project: Pick<Project, "id" | "key" | "settings">, code: string | null, kind: AttestKind, ok: boolean, detail = "") {
  const tree = await currentTree(project, code);
  if (!tree) return null;
  insert("attestations", { project_id: project.id, item_code: code ?? "", kind, tree, ok: ok ? 1 : 0, detail: detail.slice(0, 20_000), created_at: now() });
  return tree;
}

/** The latest record of this kind for the working copy's current tree, if there is one. */
export async function attestedNow(project: Pick<Project, "id" | "key" | "settings">, code: string | null, kind: AttestKind): Promise<Attestation | null> {
  const tree = await currentTree(project, code);
  if (!tree) return null;
  const row = all<{ kind: AttestKind; tree: string; ok: number; detail: string; created_at: string }>(
    "SELECT kind, tree, ok, detail, created_at FROM attestations WHERE project_id = ? AND item_code = ? AND kind = ? AND tree = ? ORDER BY id DESC LIMIT 1",
    project.id,
    code ?? "",
    kind,
    tree,
  )[0];
  return row ? { ...row, ok: row.ok === 1 } : null;
}

/** The latest record of this kind, whatever tree it was for. */
export function lastAttestation(projectId: string, code: string | null, kind: AttestKind): Attestation | null {
  const row = all<{ kind: AttestKind; tree: string; ok: number; detail: string; created_at: string }>(
    "SELECT kind, tree, ok, detail, created_at FROM attestations WHERE project_id = ? AND item_code = ? AND kind = ? ORDER BY id DESC LIMIT 1",
    projectId,
    code ?? "",
    kind,
  )[0];
  return row ? { ...row, ok: row.ok === 1 } : null;
}

export interface Verification {
  ok: boolean;
  /** Reused an earlier green or red run on the same tree: nothing was run. */
  reused: boolean;
  report: ChecksReport | null;
  /** What failed, for a bounded fix: the failing check's name and output. */
  failure: string;
  text: string;
}

/**
 * Run the project's checks on a working copy unless they already ran on exactly this tree, and record the result.
 * No model is involved. Simulation counts as passed.
 */
export async function verify(project: Project, code: string | null, label: string): Promise<Verification> {
  const known = await attestedNow(project, code, "checks");
  if (known) return { ok: known.ok, reused: true, report: null, failure: known.ok ? "" : known.detail, text: known.detail };
  const report = await runChecks(project, code);
  const text = formatChecks(report);
  const failed = report.results.find((r) => !r.ok);
  const failure = failed ? `${failed.name} (\`${failed.command}\`) failed:\n${failed.output}` : "";
  await attest(project, code, "checks", report.ok, report.ok ? text : failure);
  logActivity({
    projectId: project.id,
    agentId: "orchestrator",
    type: "validation",
    summary: `${report.ok ? "✅" : "❌"} ${label}: ${report.note && !report.results.length ? "none configured" : failed ? `${failed.name} failed (exit ${failed.exitCode ?? "none"})` : `${report.results.length} passed${report.simulated ? " (simulated)" : ""}`}`,
    detail: text,
  });
  return { ok: report.ok, reused: false, report, failure, text };
}
